import type { PremiumAccessWire, TranscriptionFailureCategoryWire, TranscriptionRouteOutcomeWire, TranscriptionStatusWire } from "@meetless/meeting-contracts";
import { validateManagedQuotaFailure, canRetryTranscript, type Meeting, type RecordingSession, type TranscriptState } from "@meetless/meeting-domain";
import type { TranscriptionProviderStatus } from "./transcription-provider.js";

export const MANAGED_PREMIUM_REQUIRED_MESSAGE = "Premium is required. Purchase or restore Premium, then select Transcribe again.";
export const MANAGED_PREMIUM_RECOVERY_MESSAGE = "Premium access could not be verified. Restore purchases or check Premium access, then select Transcribe again.";
export const MANAGED_TRANSCRIPTION_FAILURE_MESSAGE = "Transcription could not be completed. The saved audio remains local.";
export const MANAGED_TRANSCRIPTION_NO_SAVED_RECORDING_MESSAGE = "Save the recording before starting transcription.";

export interface TranscriptionRouteStore {
  list(): Promise<readonly Meeting[]>;
  listRecordings(): Promise<readonly RecordingSession[]>;
  getTranscriptForMeeting(meetingId: string): Promise<TranscriptState | null>;
  grantTranscriptionConsent(): Promise<{ status: "granted"; grantedAt: string }>;
}
export interface TranscriptionPremiumAccess { status(): Promise<Pick<PremiumAccessWire, "status">>; }
export interface TranscriptionByokRoute {
  /** BYOK selection probe; it must never read or mutate Premium state. */
  status(): Promise<TranscriptionProviderStatus>;
  /** Local dispatch replacing the managed upload flow when BYOK is configured. */
  transcribe(input: { recordingId: string; onDurableStart(transcript: TranscriptState): void }): Promise<{ transcript: TranscriptState }>;
}
export interface ManagedTranscriptionDispatch {
  transcribe(input: { recordingId: string; onDurableStart(transcript: TranscriptState): void }): Promise<{ transcript: TranscriptState }>;
  /** Recover/settle/publish/acknowledge only an existing job; never upload or invoke a provider. */
  resumeExisting?(recordingId: string): Promise<TranscriptState | null>;
}
export interface TranscriptionRouteResult extends TranscriptionStatusWire {
  readonly consent: { status: "granted"; grantedAt: string };
  readonly route: "managed" | "byok";
  readonly transcript: TranscriptState | null;
}

export function transcriptionFailure(error: unknown): { category: TranscriptionFailureCategoryWire; message: string } {
  if (error !== null && typeof error === "object" && "quotaFailure" in error) {
    try {
      const quota = validateManagedQuotaFailure(error.quotaFailure);
      const checked = formatQuotaTime(quota.checkedAt);
      const reset = quota.resetAt === null ? "" : ` At that check, the reported reset time was ${formatQuotaTime(quota.resetAt)}.`;
      return { category: "quota", message: `This recording needs ${formatQuotaDuration(quota.requiredSeconds)}. ${formatQuotaDuration(quota.remainingSeconds)} remained when checked ${checked}.${reset} The saved audio remains local. Retry transcription to check allowance again.` };
    } catch { /* Malformed data must never become numeric quota advice. */ }
  }
  const text = error instanceof Error ? error.message.toLowerCase() : String(error ?? "").toLowerCase();
  if (/quota|allowance/.test(text)) return { category: "quota", message: "Allowance could not be verified. The saved audio remains local. Retry transcription to check again." };
  if (/enroll|credential|device|auth|keychain/.test(text)) return { category: "enrollment", message: "This Mac could not verify managed access. Restore purchases, then select Transcribe again." };
  if (/publish|publication|settle|settlement|acknowledge/.test(text)) return { category: "publication", message: "The transcript could not be saved locally. Check status or retry to recover the existing result." };
  if (/provider|openai/.test(text)) return { category: "provider", message: "The transcription service could not complete this recording. The saved audio remains local." };
  if (/upload/.test(text)) return { category: "upload", message: "Audio upload did not finish. Your saved audio is safe. Retry transcription to try again." };
  return { category: "connection", message: "Transcription could not connect. Check the connection, then try again." };
}

/** The explicit selected-recording dispatch owner. Reads never dispatch new work. */
export class TranscriptionRouteCoordinator {
  private readonly starts = new Map<string, Promise<TranscriptionRouteResult>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, TranscriptionStatusWire>();
  private readonly reads = new Map<string, Promise<TranscriptState | null>>();
  private readonly acknowledgedReady = new Set<string>();

  constructor(private readonly store: TranscriptionRouteStore, private readonly premium: TranscriptionPremiumAccess, private readonly managed: ManagedTranscriptionDispatch, private readonly byok?: TranscriptionByokRoute) {}

  async status(meetingId: string): Promise<{ recording: { recordingId: string; status: RecordingSession["status"] } | null; transcript: TranscriptState | null; transcription: TranscriptionStatusWire }> {
    const recording = (await this.store.listRecordings()).find((entry) => entry.meetingId === meetingId);
    let transcript = await this.store.getTranscriptForMeeting(meetingId);
    const evidence = recording ? { recordingId: recording.id, status: recording.status } : null;
    if (!recording || recording.status !== "saved" || !recording.savedOutput) {
      return { recording: evidence, transcript, transcription: this.state("not_saved", false, "not_saved", MANAGED_TRANSCRIPTION_NO_SAVED_RECORDING_MESSAGE) };
    }
    if (transcript?.status === "ready") {
      // Cleanup of a previously published result must not block local reading.
      if (!this.running.has(recording.id) && !this.acknowledgedReady.has(recording.id)) {
        void this.recoverExisting(recording.id).then(() => this.acknowledgedReady.add(recording.id), () => undefined);
      }
      return { recording: evidence, transcript, transcription: this.state("completed") };
    }
    if (this.running.has(recording.id)) return { recording: evidence, transcript, transcription: this.state("started") };
    // linux-port/BYOK: with a configured user key, status must not run the
    // managed/native recovery or surface its exhaustion state either.
    const byokStatusReady = this.byok !== undefined && (await this.byok.status()) === "configured";
    // A durable pending transcript alone does not establish a live dispatcher.
    if (!byokStatusReady && transcript && this.managed.resumeExisting) {
      try {
        transcript = await this.recoverExisting(recording.id) ?? transcript;
      } catch (error) {
        transcript = await this.store.getTranscriptForMeeting(meetingId) ?? transcript;
        if (transcript?.status === "ready") return { recording: evidence, transcript, transcription: this.state("completed") };
        const failure = transcriptionFailure(error);
        return { recording: evidence, transcript, transcription: this.state("interrupted", !transcript || transcript.status !== "failed" || canRetryTranscript(transcript), failure.category, failure.message) };
      }
    }
    if (transcript?.status === "ready") return { recording: evidence, transcript, transcription: this.state("completed") };
    if (transcript?.status === "failed") {
      const failure = transcriptionFailure(transcript.quotaFailure ? { quotaFailure: transcript.quotaFailure } : transcript.failureReason);
      const retry = byokStatusReady || canRetryTranscript(transcript);
      return { recording: evidence, transcript, transcription: this.state("failed", retry, retry ? (byokStatusReady ? null : failure.category) : "retry_exhausted", retry ? (byokStatusReady ? "Select Transcribe to retry with your OpenAI key." : failure.message) : "No further transcription retries are available for this recording. The saved audio remains local.") };
    }
    const previous = this.failures.get(recording.id);
    return { recording: evidence, transcript, transcription: previous ?? (transcript
      ? this.state("interrupted", true, null, "Transcription is not running on this Mac. Check status or retry to continue the existing work.")
      : this.state("not_started", true)) };
  }

  start(meetingId: string): Promise<TranscriptionRouteResult> {
    const id = meetingId.trim();
    if (!id) return Promise.reject(new Error("Select a meeting first"));
    const previous = this.starts.get(id);
    if (previous) return previous;
    const request = this.startOnce(id).finally(() => this.starts.delete(id));
    this.starts.set(id, request);
    return request;
  }

  private async startOnce(meetingId: string): Promise<TranscriptionRouteResult> {
    if (!(await this.store.list()).some((entry) => entry.id === meetingId)) throw new Error("The selected meeting is unavailable");
    const recording = (await this.store.listRecordings()).find((entry) => entry.meetingId === meetingId && entry.status === "saved" && entry.savedOutput !== null);
    // Reject before recording consent or touching managed auth when audio is not saved.
    if (!recording) throw new Error(MANAGED_TRANSCRIPTION_NO_SAVED_RECORDING_MESSAGE);
    const consent = await this.store.grantTranscriptionConsent();
    let route: "managed" | "byok" = "managed";
    const result = (state: TranscriptionStatusWire, transcript: TranscriptState | null): TranscriptionRouteResult => ({ consent, route, ...state, transcript });
    let transcript = await this.store.getTranscriptForMeeting(meetingId);
    // linux-port/BYOK: a configured user key must win BEFORE any managed/native
    // recovery or retry-exhaustion gate — a transcript that failed through the
    // managed path (for example before the key file existed) would otherwise
    // trap every retry in the native route.
    const byok = this.byok !== undefined && (await this.byok.status()) === "configured" ? this.byok : null;
    if (!byok && transcript && this.managed.resumeExisting && !this.running.has(recording.id)) {
      try { transcript = await this.recoverExisting(recording.id) ?? transcript; }
      catch (error) {
        transcript = await this.store.getTranscriptForMeeting(meetingId) ?? transcript;
        if (transcript?.status === "ready") return result(this.state("completed"), transcript);
        const failure = transcriptionFailure(error);
        return result(this.state("interrupted", !transcript || transcript.status !== "failed" || canRetryTranscript(transcript), failure.category, failure.message), transcript);
      }
    }
    if (transcript?.status === "ready") return result(this.state("completed"), transcript);
    if (this.running.has(recording.id)) return result(this.state("already_running"), transcript);
    if (!byok && transcript?.status === "failed" && !canRetryTranscript(transcript)) return result(this.state("failed", false, "retry_exhausted", "No further transcription retries are available for this recording. The saved audio remains local."), transcript);
    // BYOK selection moved above the managed recovery gate; see the comment there.
    route = byok ? "byok" : "managed";
    if (!byok) {
      let access: PremiumAccessWire["status"] = "unavailable";
      try { access = (await this.premium.status()).status; } catch { /* fail closed */ }
      if (access !== "active") return result(this.state(access === "inactive" ? "purchase_required" : "recovery_required", false, "access", access === "inactive" ? MANAGED_PREMIUM_REQUIRED_MESSAGE : MANAGED_PREMIUM_RECOVERY_MESSAGE), transcript);
    }
    this.failures.delete(recording.id);
    let signal!: (transcript: TranscriptState) => void;
    const durable = new Promise<TranscriptState>((resolve) => { signal = resolve; });
    let failure: unknown = null;
    const work = Promise.resolve().then(() => (byok ?? this.managed).transcribe({ recordingId: recording.id, onDurableStart: signal }))
      .then((completed) => { transcript = completed.transcript; }, (error: unknown) => {
        failure = error;
        const detail = transcriptionFailure(error);
        this.failures.set(recording.id, this.state("failed", true, detail.category, detail.message));
      }).finally(() => this.running.delete(recording.id));
    this.running.set(recording.id, work);
    const started = await Promise.race([durable.then((value) => ({ value })), work.then(() => null)]);
    if (started) return result(this.state("started"), started.value);
    transcript = await this.store.getTranscriptForMeeting(meetingId) ?? transcript;
    if (transcript?.status === "ready") return result(this.state("completed"), transcript);
    if (failure) {
      const state = this.failures.get(recording.id)!;
      if (transcript?.status === "failed" && !canRetryTranscript(transcript)) return result(this.state("failed", false, "retry_exhausted", "No further transcription retries are available for this recording. The saved audio remains local."), transcript);
      return result(state, transcript);
    }
    return result(this.state("interrupted", true, null, "Transcription needs another status check before continuing."), transcript);
  }

  private recoverExisting(recordingId: string): Promise<TranscriptState | null> {
    let read = this.reads.get(recordingId);
    if (!read) {
      read = Promise.resolve().then(() => this.managed.resumeExisting?.(recordingId) ?? null)
        .finally(() => this.reads.delete(recordingId));
      this.reads.set(recordingId, read);
    }
    return read;
  }

  private state(outcome: TranscriptionRouteOutcomeWire, retryEligible = false, failureCategory: TranscriptionFailureCategoryWire | null = null, message: string | null = null): TranscriptionStatusWire {
    return { outcome, retryEligible, failureCategory, message };
  }
}

function formatQuotaDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours} hr` : "", minutes ? `${minutes} min` : "", remainder || (!hours && !minutes) ? `${remainder} sec` : ""].filter(Boolean).join(" ");
}

function formatQuotaTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}
