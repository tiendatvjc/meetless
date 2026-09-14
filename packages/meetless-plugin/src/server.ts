import { randomUUID } from "node:crypto";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TranscriptState } from "@meetless/meeting-domain";
import { MeetingStore } from "@meetless/meeting-store";
import type { MeetingDeleteStoreResult } from "@meetless/meeting-store";
import { RecordingService } from "./recording-service.js";
import { RecordingControlServer } from "./control-server.js";
import { runtimeEndpoint } from "./runtime-endpoints.js";
import {
  assertCapturePermissionsReady,
  assertProductionHostProvenance,
  registerPackagedCaptureHelper,
} from "./production-host.js";
import { FfmpegAudioInspector, TranscriptionService, transcribeTwoSourceRecording } from "./transcription-service.js";
import { buildSourceTimelines, type SourceTimeline, type SourceTimelines } from "./source-timeline.js";
import { resolveTwoSourcePlan, type TwoSourceTranscriptPlan } from "./two-source-plan.js";
import {
  DeterministicFixtureTranscriptionProvider,
  NativeOpenAiTranscriptionProvider,
  UnixSocketNativeTranscriptionTransport,
  type TranscriptionProvider,
} from "./transcription-provider.js";
import { CitationPlaybackService, FfmpegCitationClipEncoder } from "./citation-playback.js";
import { PrivateAudioSnapshotStore } from "./private-audio-snapshot.js";
import { UiTestIdentitySchema, type UiTestIdentity } from "./readiness-protocol.js";
import type { PluginHandlerContext } from "@paseo/plugin";
import {
  MeetingChatService,
  PaseoMeetingChatAgentPort,
  resolveChatExecutionRoot,
} from "./chat-service.js";
import { MeetingLifecycleCoordinator, type MeetingWorkKind } from "./meeting-lifecycle-coordinator.js";
import { listRecordingOwnedStagePaths } from "./finalizer.js";
import {
  ConvexManagedTranscriptionService,
  listManagedArtifactPaths,
  ManagedTimelineArtifactStore,
  type ConvexManagedTranscriptionResult,
} from "./managed-transcription.js";
import {
  NativePremiumAccessPort,
  PremiumService,
  UnavailablePremiumAccessPort,
} from "./premium-service.js";
import { ManagedDeviceWireSchema, type ManagedDeviceWire } from "@meetless/meeting-contracts";
import {
  ConvexManagedCredentialSource,
  UnixSocketManagedAuthTransport,
  type ManagedAppleVerificationMaterial,
} from "./managed-auth.js";
import {
  ConvexHttpManagedFunctionClient,
  ConvexManagedUploadPort,
  FileManagedConvexUploadJournal,
  type ManagedConvexCredential,
} from "./managed-upload.js";
import { TranscriptionRouteCoordinator, type TranscriptionByokRoute, type TranscriptionPremiumAccess } from "./transcription-route.js";
import { OpenAiByokTranscriptionProvider } from "./openai-byok-provider.js";
import { LinuxNoopPremiumAccess } from "./linux-premium-access.js";
import { PyannoteDiarizerProvider } from "./diarization/pyannote-provider.js";
import { MeetingDiarizationService, readSpeakerLabelOverlay } from "./diarization/meeting-diarization.js";

let store: MeetingStore | null = null;
let recordingService: RecordingService | null = null;
let controlServer: RecordingControlServer | null = null;
let transcriptionService: TranscriptionService | null = null;
let citationPlaybackService: CitationPlaybackService | null = null;
let recordingStart: Promise<void> | null = null;
let runtimeIdentity: { instanceId: string; startedAt: string; uiTest: UiTestIdentity | null } | null = null;
let chatService: MeetingChatService | null = null;
let premiumService: PremiumService | null = null;
let managedCredential: ManagedConvexCredential | null = null;
let managedCredentialSource: ConvexManagedCredentialSource | null = null;
let transcriptionRoute: TranscriptionRouteCoordinator | null = null;
let byokProvider: OpenAiByokTranscriptionProvider | null = null;
let byokProviderConfigPath: string | null = null;
let diarizationService: MeetingDiarizationService | null = null;
const meetingLifecycle = new MeetingLifecycleCoordinator();

export async function deleteMeetingSafely(
  meetingStore: Pick<MeetingStore, "deleteMeeting">,
  meetingId: string,
  activity: { transcription?: boolean; ask?: boolean } = {},
): Promise<MeetingDeleteStoreResult> {
  if (activity.transcription) return { meetingId, outcome: "refused", reason: "transcription" };
  if (activity.ask) return { meetingId, outcome: "refused", reason: "ask" };
  return meetingStore.deleteMeeting(meetingId);
}

export function deleteMeeting(meetingId: string): Promise<MeetingDeleteStoreResult> {
  const acquisition = meetingLifecycle.tryAcquireDeletion(meetingId);
  if (!acquisition.acquired) {
    return Promise.resolve({ meetingId, outcome: "refused", reason: deletionReason(acquisition.active) });
  }
  return (async () => {
    try {
      const meetingStore = getMeetingStore();
      if (!recordingService) {
        return await deleteMeetingBeforeRecordingBootstrap(
          meetingStore,
          meetingId,
          requiredAbsolute("MEETLESS_EXPORT_ROOT"),
          requiredAbsolute("MEETLESS_STORE_ROOT"),
        );
      }
      const recordingStagePaths = await recordingService.ownedStagePaths(meetingId);
      const managedArtifactPaths = await recordingService.ownedManagedArtifactPaths(meetingId);
      return await meetingStore.deleteMeeting(meetingId, { recordingStagePaths, managedArtifactPaths });
    } finally {
      acquisition.lease.release();
    }
  })();
}

export async function deleteMeetingBeforeRecordingBootstrap(
  meetingStore: Pick<MeetingStore, "listRecordings" | "deleteMeeting">,
  meetingId: string,
  exportRoot: string,
  storeRoot: string,
): Promise<MeetingDeleteStoreResult> {
  const candidates = (await meetingStore.listRecordings()).filter((recording) => recording.meetingId === meetingId);
  const recordingIds = (await Promise.all(candidates.map(async (recording) => {
    if (["recording", "interrupted", "recoverable", "finalizing"].includes(recording.status)) return recording.id;
    if (recording.status !== "failed") return null;
    return lstat(path.join(storeRoot, "sessions", recording.id)).then(
      (state) => state.isDirectory() && !state.isSymbolicLink() ? recording.id : null,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error),
    );
  }))).filter((recordingId): recordingId is string => recordingId !== null);
  const recordingStagePaths = await listRecordingOwnedStagePaths(exportRoot, recordingIds);
  const managedArtifactPaths = await listManagedArtifactPaths(path.join(storeRoot, "managed-artifacts"), recordingIds);
  return meetingStore.deleteMeeting(meetingId, { recordingStagePaths, managedArtifactPaths });
}

function deletionReason(active: MeetingWorkKind[]): "active_capture" | "finalization" | "transcription" | "ask" {
  if (active.includes("active_capture")) return "active_capture";
  if (active.includes("finalization")) return "finalization";
  if (active.includes("transcription")) return "transcription";
  return "ask";
}

export function getMeetingStore(): MeetingStore {
  if (store) return store;
  const configuredRoot = process.env.MEETLESS_STORE_ROOT?.trim();
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    throw new Error(
      "MEETLESS_STORE_ROOT must be an absolute isolated path fixed by the Meetless launcher",
    );
  }
  const exportRoot = process.env.MEETLESS_EXPORT_ROOT?.trim();
  store = new MeetingStore({
    root: configuredRoot,
    approvedExportRoots: exportRoot && path.isAbsolute(exportRoot) ? [exportRoot] : [],
  });
  return store;
}

export async function getMeetingChatService(
  paseo: PluginHandlerContext["paseo"],
): Promise<MeetingChatService> {
  chatService ??= new MeetingChatService(
    getMeetingStore(),
    new PaseoMeetingChatAgentPort(paseo, resolveChatExecutionRoot()),
    meetingLifecycle,
  );
  await chatService.initialize();
  return chatService;
}

export function getPremiumService(): PremiumService {
  if (premiumService) return premiumService;
  const configuredSocket = process.env.MEETLESS_TRANSCRIPTION_SOCKET?.trim() ?? "";
  if (!configuredSocket && process.env.MEETLESS_RUNTIME_PACKAGED !== "1") {
    return new PremiumService(new UnavailablePremiumAccessPort(configuredSocket ? "store_unavailable" : "not_configured"));
  }
  const endpoint = runtimeEndpoint(process.env, "transcription");
  premiumService ??= new PremiumService(new NativePremiumAccessPort(endpoint.bindArgument), {
    requireAppleSignedTransaction: true,
    onAppleSignedTransaction: enrollManagedAppleTransaction,
    readAuthorization: async () => {
      const credential = await refreshManagedAuthorization();
      if (!credential.state) throw new Error("Managed authorization snapshot is missing state");
      return {
        state: credential.state,
        naturalExpiryAt: credential.naturalExpiryAt ?? null,
      };
    },
  });
  return premiumService;
}

/** Consumes the opaque host JWS before the public Premium RPC resolves. */
export async function enrollManagedAppleTransaction(signedTransaction: string): Promise<ManagedConvexCredential> {
  if (!signedTransaction.trim()) throw new Error("Apple signed transaction is empty");
  managedCredential = await getManagedConvexCredentialSource().enroll({
    adapter: "app-store-server-api",
    signedTransaction,
  });
  return managedCredential;
}

export async function listManagedDevices(): Promise<ManagedDeviceWire[]> {
  const client = await managedClientWithCredential();
  await client.mutation("managedAuth:touchDeviceActivity", {});
  const value = await client.query("managedAuth:listDevices", {});
  if (!Array.isArray(value)) throw new Error("Managed device list response is invalid");
  return value.map((device) => ManagedDeviceWireSchema.parse(device));
}

export async function revokeManagedDevice(deviceId: string): Promise<{ deviceId: string; outcome: "revoked" | "already-revoked" }> {
  const client = await managedClientWithCredential();
  const value = await client.mutation("managedAuth:revokeEnrolledDevice", { deviceId });
  if (!value || typeof value !== "object" || typeof (value as { deviceId?: unknown }).deviceId !== "string" || (value as { outcome?: unknown }).outcome !== "revoked" && (value as { outcome?: unknown }).outcome !== "already-revoked") {
    throw new Error("Managed device revoke response is invalid");
  }
  return { deviceId: (value as { deviceId: string }).deviceId, outcome: (value as { outcome: "revoked" | "already-revoked" }).outcome };
}

export async function stopMeetingChatService(): Promise<void> {
  const current = chatService;
  if (!current) return;
  await current.close();
  if (chatService === current) chatService = null;
}

export async function startRecordingRuntime(deadlineEpochMs = Number.POSITIVE_INFINITY): Promise<void> {
  assertBootstrapDeadline(deadlineEpochMs);
  if (recordingService || controlServer) return;
  if (recordingStart) {
    await recordingStart;
    assertBootstrapDeadline(deadlineEpochMs);
    return;
  }
  recordingStart = startRecordingRuntimeOnce(deadlineEpochMs);
  try {
    await recordingStart;
    assertBootstrapDeadline(deadlineEpochMs);
  } catch (error) {
    if (Date.now() >= deadlineEpochMs) await stopRecordingRuntime();
    throw error;
  } finally {
    recordingStart = null;
  }
}

async function startRecordingRuntimeOnce(deadlineEpochMs: number): Promise<void> {
  assertBootstrapDeadline(deadlineEpochMs);
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const helperPath = requiredAbsolute("MEETLESS_CAPTURE_HELPER");
  const ffmpeg = requiredAbsolute("MEETLESS_FFMPEG");
  const ffprobe = requiredAbsolute("MEETLESS_FFPROBE");
  const exportRoot = requiredAbsolute("MEETLESS_EXPORT_ROOT");
  const recordingEndpoint = runtimeEndpoint(process.env, "recording");
  const transcriptionStaging = process.env.MEETLESS_TRANSCRIPTION_STAGING?.trim();
  const uiTest = await readControlledUiTestIdentity();
  await Promise.all([access(helperPath), access(ffmpeg), access(ffprobe)]);
  const fixedStamp = process.env.MEETLESS_FIXTURE_EXPORT_STAMP?.trim();
  const fixture = process.env.MEETLESS_CAPTURE_MODE === "fixture";
  if (fixture && !uiTest) {
    throw new Error(
      "Fixture capture requires a valid consumed one-shot UI-test envelope; normal production has no fixture fallback",
    );
  }
  if (!fixture || process.env.MEETLESS_RUNTIME_PACKAGED === "1") await assertProductionHostProvenance();
  const transcriptionMode = uiTest?.transcriptionMode ?? "native";
  const byokTranscriptionReady = await linuxByokTranscriptionReady();
  const transcriptionEndpoint = transcriptionMode === "fake"
    ? null
    : byokTranscriptionReady
      ? linuxByokExemptTranscriptionEndpoint()
      : runtimeEndpoint(process.env, "transcription");
  if (!fixture && !byokTranscriptionReady && (!transcriptionEndpoint || !transcriptionStaging || !path.isAbsolute(transcriptionStaging))) {
    throw new Error("Production transcription requires the signed MeetlessHost native capability socket");
  }
  const fixtureExportNow = resolveFixtureExportNow(fixture, fixedStamp);
  const managedArtifacts = new ManagedTimelineArtifactStore(path.join(storeRoot, "managed-artifacts"));
  const provider: TranscriptionProvider | null = transcriptionMode === "fake"
    ? new DeterministicFixtureTranscriptionProvider()
    : transcriptionEndpoint
      ? new NativeOpenAiTranscriptionProvider(new UnixSocketNativeTranscriptionTransport(transcriptionEndpoint.bindArgument))
      : null;
  if (fixture && !provider) {
    throw new Error("Controlled native transcription requires the signed host capability socket");
  }
  const transcript = provider
    ? new TranscriptionService(getMeetingStore(), provider, {
      inspector: new FfmpegAudioInspector(
        ffmpeg,
        ffprobe,
        transcriptionStaging ?? path.join(storeRoot, "transcription-ranges"),
      ),
      sourceSnapshots: new PrivateAudioSnapshotStore(
        path.join(storeRoot, "transcription-source-snapshots"),
        "transcription-source",
      ),
    }, meetingLifecycle)
    : undefined;
  const service = new RecordingService({
    storeRoot, helperPath, ffmpeg, ffprobe, exportRoot,
    fixture,
    exportNow: fixtureExportNow,
    fixtureStampApplied: fixtureExportNow !== undefined,
    failFinalizationOnce: process.env.MEETLESS_FIXTURE_FAIL_FINALIZATION_ONCE === "1",
    authorizeProductionStart: async () => {
      await assertProductionHostProvenance();
      if (!(await linuxByokTranscriptionReady())) await assertCapturePermissionsReady();
    },
    ...(process.env.MEETLESS_RUNTIME_PACKAGED === "1"
      ? { registerCaptureHelper: (childPid: number, registrationToken: string) =>
        registerPackagedCaptureHelper(childPid, registrationToken) }
      : {}),
    transcription: transcript,
    managedTimelineConsumer: managedArtifacts,
  }, getMeetingStore(), meetingLifecycle);
  const identity = {
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
    uiTest,
  };
  const server = new RecordingControlServer(recordingEndpoint, service, identity);
  try {
    await service.initialize();
    assertBootstrapDeadline(deadlineEpochMs);
    await server.start();
    assertBootstrapDeadline(deadlineEpochMs);
    recordingService = service;
    controlServer = server;
    transcriptionService = transcript ?? null;
    runtimeIdentity = identity;
  } catch (error) {
    await server.close().catch(() => undefined);
    await service.shutdown().catch(() => undefined);
    throw error;
  }
}

export async function stopRecordingRuntime(): Promise<void> {
  const server = controlServer; const service = recordingService;
  controlServer = null; recordingService = null; transcriptionService = null;
  runtimeIdentity = null;
  await service?.shutdown();
  await server?.close();
}

export function recordingRuntimeForTest(): RecordingService | null { return recordingService; }

export function getTranscriptionService(): TranscriptionService {
  if (!transcriptionService) throw new Error("Meetless transcription runtime is not active");
  return transcriptionService;
}

export function getTranscriptionRoute(): TranscriptionRouteCoordinator {
  if (transcriptionRoute) return transcriptionRoute;
  transcriptionRoute = new TranscriptionRouteCoordinator(
    getMeetingStore(),
    linuxTranscriptionPremiumAccess(),
    {
      resumeExisting: (recordingId) => resumeExistingManagedRecording(recordingId),
      transcribe: (input) => transcribeManagedRecording({
        recordingId: input.recordingId,
        onDurableStart: input.onDurableStart,
      }),
    },
    linuxByokTranscriptionRoute(),
  );
  return transcriptionRoute;
}

/**
 * Linux has no RevenueCat SDK, so Premium is permanently inactive for the
 * transcription route there; BYOK remains the only free local route
 * (docs/product/monetization.md). Other platforms keep the native-backed
 * PremiumService gate unchanged.
 */
function linuxTranscriptionPremiumAccess(): TranscriptionPremiumAccess {
  return process.platform === "linux" ? new LinuxNoopPremiumAccess() : getPremiumService();
}

/**
 * Linux has no signed MeetlessHost native capability socket, so a user-supplied
 * OpenAI key is the only in-process transcription route there
 * (docs/product/monetization.md). macOS keeps the managed-only wiring until
 * BYOK ships on that platform.
 */
function linuxByokTranscriptionRoute(): TranscriptionByokRoute | undefined {
  if (process.platform !== "linux") return undefined;
  return {
    status: () => getLinuxByokProvider().status(),
    transcribe: (input) => transcribeByokRecording(getLinuxByokProvider(), input),
  };
}

/**
 * BYOK key file location (linux-port rider): the runtime root fixed by the
 * daemon launcher (MEETLESS_RUNTIME_ROOT) wins; a direct unpackaged run falls
 * back to the platform support root ~/.local/share/meetless.
 */
function linuxByokConfigPath(): string {
  const runtimeRoot = process.env.MEETLESS_RUNTIME_ROOT?.trim();
  if (runtimeRoot && path.isAbsolute(runtimeRoot)) {
    return path.join(path.resolve(runtimeRoot), "byok-openai.json");
  }
  return path.join(os.homedir(), ".local/share/meetless/byok-openai.json");
}

function getLinuxByokProvider(): OpenAiByokTranscriptionProvider {
  const configPath = linuxByokConfigPath();
  if (!byokProvider || byokProviderConfigPath !== configPath) {
    byokProviderConfigPath = configPath;
    byokProvider = new OpenAiByokTranscriptionProvider({ configPath });
  }
  return byokProvider;
}

/**
 * Linux-port Issue 1c: when the transcription route is BYOK (a configured key
 * exists), recording bootstrap and production start no longer require the
 * signed native capability socket — the native-socket requirements stay
 * mandatory for the managed route, which remains unavailable on linux exactly
 * like the premium no-op. Darwin is byte-identical (never linux).
 */
async function linuxByokTranscriptionReady(): Promise<boolean> {
  if (process.platform !== "linux" || process.env.MEETLESS_RUNTIME_PACKAGED === "1") return false;
  try {
    return (await getLinuxByokProvider().status()) === "configured";
  } catch {
    return false;
  }
}

/** Endpoint resolution that may legitimately be absent under the BYOK exemption. */
function linuxByokExemptTranscriptionEndpoint() {
  try {
    return runtimeEndpoint(process.env, "transcription");
  } catch {
    return null;
  }
}

async function transcribeByokRecording(
  provider: OpenAiByokTranscriptionProvider,
  input: { recordingId: string; onDurableStart(transcript: TranscriptState): void },
): Promise<{ transcript: TranscriptState }> {
  const store = getMeetingStore();
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const staging = process.env.MEETLESS_TRANSCRIPTION_STAGING?.trim();
  const inspector = new FfmpegAudioInspector(
    requiredAbsolute("MEETLESS_FFMPEG"),
    requiredAbsolute("MEETLESS_FFPROBE"),
    staging && path.isAbsolute(staging) ? staging : path.join(storeRoot, "transcription-ranges"),
  );
  const sourceSnapshots = new PrivateAudioSnapshotStore(path.join(storeRoot, "transcription-source-snapshots"), "transcription-source");
  const onStateChange = (transcript: TranscriptState) => {
    // The coordinator's start contract resolves on the first durable
    // pending/transcribing state, mirroring the managed dispatch.
    if (transcript.status === "pending" || transcript.status === "transcribing") input.onDurableStart(transcript);
  };
  const twoSource = await prepareByokTwoSourceDispatch(store, storeRoot, input.recordingId);
  if (twoSource) {
    const transcript = await transcribeTwoSourceRecording(store, provider, input.recordingId, twoSource.timelines, {
      inspector,
      sourceSnapshots,
      onStateChange,
      lifecycle: meetingLifecycle,
    });
    if (transcript) {
      if (transcript.status === "failed") throw new Error(transcript.failureReason ?? "BYOK transcription failed");
      return { transcript };
    }
    // Null means an existing transcript follows the mixed range plan; resume
    // it through the unchanged mixed flow below.
  }
  const service = new TranscriptionService(store, provider, {
    inspector,
    sourceSnapshots,
    onStateChange,
  }, meetingLifecycle);
  const transcript = await service.transcribeSavedRecording(input.recordingId);
  if (transcript.status === "failed") throw new Error(transcript.failureReason ?? "BYOK transcription failed");
  return { transcript };
}

/**
 * Speaker attribution stage A3 dispatch decision: when the recording's session
 * committed chunks for BOTH capture sources, rebuild the per-source timeline
 * WAVs and plan the interleaved two-source transcription. Any missing source,
 * timeline build failure, or pre-existing mixed-plan transcript returns null
 * so the caller keeps the byte-identical mixed-audio flow.
 */
async function prepareByokTwoSourceDispatch(
  store: MeetingStore,
  storeRoot: string,
  recordingId: string,
): Promise<{ timelines: { microphone: SourceTimeline; system: SourceTimeline }; plan: TwoSourceTranscriptPlan } | null> {
  const recording = (await store.listRecordings()).find((candidate) => candidate.id === recordingId);
  if (!recording || recording.status !== "saved" || !recording.savedOutput) return null;
  const sessionDirectory = path.join(storeRoot, "sessions", recordingId);
  if (!await sessionHasBothSourceChunks(sessionDirectory)) return null;
  let timelines: SourceTimelines;
  try {
    timelines = await buildSourceTimelines(sessionDirectory, recordingId, { ffmpeg: requiredAbsolute("MEETLESS_FFMPEG") });
  } catch {
    // Derived-audio reconstruction is best effort; the saved mixed MP3 flow
    // remains the durable fallback.
    return null;
  }
  const existing = await store.getTranscriptForMeeting(recording.meetingId);
  const plan = resolveTwoSourcePlan({
    microphone: timelines.microphone,
    system: timelines.system,
    recordingId,
    audioSha256: recording.savedOutput.sha256,
    existingRanges: existing?.ranges ?? null,
  });
  if (!plan || !timelines.microphone || !timelines.system) return null;
  return { timelines: { microphone: timelines.microphone, system: timelines.system }, plan };
}

async function sessionHasBothSourceChunks(sessionDirectory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(sessionDirectory);
  } catch {
    return false;
  }
  let microphone = false;
  let system = false;
  for (const name of entries) {
    if (name.startsWith("chunk--microphone--")) microphone = true;
    else if (name.startsWith("chunk--system--")) system = true;
  }
  return microphone && system;
}

export function getCitationPlaybackService(): CitationPlaybackService {
  if (citationPlaybackService) return citationPlaybackService;
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  citationPlaybackService = new CitationPlaybackService(
    getMeetingStore(),
    new FfmpegCitationClipEncoder(
      requiredAbsolute("MEETLESS_FFMPEG"),
      path.join(storeRoot, "citation-clips"),
    ),
    new PrivateAudioSnapshotStore(
      path.join(storeRoot, "citation-source-snapshots"),
      "citation-source",
    ),
  );
  return citationPlaybackService;
}

/**
 * Speaker diarization stage B4 service: the pyannote provider over the system
 * capture timeline, persisting an idempotent attribution overlay per meeting.
 * Registered on every platform; availability reports not_installed where the
 * uv venv never ran (darwin).
 */
export function getMeetingDiarizationService(): MeetingDiarizationService {
  if (diarizationService) return diarizationService;
  diarizationService = new MeetingDiarizationService({
    storeRoot: requiredAbsolute("MEETLESS_STORE_ROOT"),
    store: getMeetingStore(),
    provider: new PyannoteDiarizerProvider(),
    ffmpeg: requiredAbsolute("MEETLESS_FFMPEG"),
    lifecycle: meetingLifecycle,
  });
  return diarizationService;
}

/** Test seam for the contribution layer; production always builds the pyannote provider. */
export function setMeetingDiarizationServiceForTest(service: MeetingDiarizationService | null): void {
  diarizationService = service;
}

export function meetingDiarizationStatus(meetingId: string): Promise<import("@meetless/meeting-contracts").DiarizationStatusWire> {
  return getMeetingDiarizationService().status(meetingId);
}

export function runMeetingDiarization(meetingId: string): Promise<import("./diarization/meeting-diarization.js").MeetingDiarizationOutcome> {
  return getMeetingDiarizationService().run(meetingId);
}

export function renameMeetingDiarizationSpeakers(
  meetingId: string,
  names: Readonly<Record<string, string>>,
): Promise<import("./diarization/meeting-diarization.js").MeetingDiarizationOutcome> {
  return getMeetingDiarizationService().rename(meetingId, names);
}

/**
 * Transcript wire overlay applied on reads; deliberately never throws so a
 * missing or unreadable diarization overlay cannot break transcript access.
 */
export async function transcriptSpeakerLabelOverlay(meetingId: string): Promise<Map<string, string>> {
  try {
    return await readSpeakerLabelOverlay(requiredAbsolute("MEETLESS_STORE_ROOT"), meetingId);
  } catch {
    return new Map();
  }
}

export async function transcriptionProviderStatus(): Promise<"configured" | "missing" | "invalid"> {
  // Reading an existing host-owned transcript does not require the recording runtime.
  // The provider is unavailable until that runtime is active, so report that state
  // without hiding or replacing the durable transcript.
  return transcriptionService ? transcriptionService.providerStatus() : "missing";
}

export function grantTranscriptionConsent(meetingId: string) {
  return getTranscriptionRoute().start(meetingId);
}

export function recordingRuntimeIdentity(): { instanceId: string; startedAt: string } {
  if (!runtimeIdentity) throw new Error("Meetless recording runtime is not active");
  return runtimeIdentity;
}

/**
 * Trusted native composition seam. No renderer RPC calls this factory; a
 * future explicit Premium command supplies Apple material or refreshes the
 * enrolled key before invoking the managed service.
 */
export function getManagedConvexCredentialSource(): ConvexManagedCredentialSource {
  const convexUrl = requiredEnv("MEETLESS_CONVEX_URL");
  const socket = runtimeEndpoint(process.env, "transcription").bindArgument;
  managedCredentialSource ??= new ConvexManagedCredentialSource(
    new ConvexHttpManagedFunctionClient(convexUrl),
    new UnixSocketManagedAuthTransport(socket),
  );
  return managedCredentialSource;
}

async function managedClientWithCredential(): Promise<ConvexHttpManagedFunctionClient> {
  const cachedCredential = managedCredential && !credentialNeedsRefresh(managedCredential) ? managedCredential : null;
  const credential: ManagedConvexCredential = cachedCredential
    ?? await getManagedConvexCredentialSource().refresh();
  managedCredential = credential;
  const client = new ConvexHttpManagedFunctionClient(requiredEnv("MEETLESS_CONVEX_URL"), { authToken: credential.authToken });
  return client;
}

async function refreshManagedAuthorization(): Promise<ManagedConvexCredential> {
  const credential = await getManagedConvexCredentialSource().refresh();
  managedCredential = credential;
  return credential;
}

function credentialExpired(credential: ManagedConvexCredential): boolean {
  return credential.expiresAt !== undefined && credential.expiresAt <= Date.now();
}

function credentialNeedsRefresh(credential: ManagedConvexCredential): boolean {
  if (credentialExpired(credential)) return true;
  return (credential.state === "active" || credential.state === "grace")
    && credential.naturalExpiryAt !== undefined
    && credential.naturalExpiryAt !== null
    && credential.naturalExpiryAt <= Date.now();
}

async function resumeExistingManagedRecording(recordingId: string) {
  const credential = await getManagedConvexCredentialSource().refresh().catch(() => { throw new Error("Managed device enrollment could not be verified"); });
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const managedUpload = new ConvexManagedUploadPort(new ConvexHttpManagedFunctionClient(requiredEnv("MEETLESS_CONVEX_URL")), {
    journal: new FileManagedConvexUploadJournal(path.join(storeRoot, "managed-convex-upload-journal")),
  });
  return new ConvexManagedTranscriptionService(getMeetingStore(), {
    lifecycle: meetingLifecycle,
    timelineArtifacts: new ManagedTimelineArtifactStore(path.join(storeRoot, "managed-artifacts")),
    managedUpload,
  }).resumeExisting({ recordingId, credential });
}

export async function transcribeManagedRecording(input: {
  recordingId: string;
  appleVerification?: ManagedAppleVerificationMaterial;
  credential?: ManagedConvexCredential;
  onDurableStart?: (transcript: import("@meetless/meeting-domain").TranscriptState) => void;
}): Promise<ConvexManagedTranscriptionResult> {
  const source = getManagedConvexCredentialSource();
  const suppliedCredential = input.credential;
  const credential = suppliedCredential && !credentialNeedsRefresh(suppliedCredential)
    ? suppliedCredential
    : await (input.appleVerification ? source.enroll(input.appleVerification) : source.refresh()).catch(() => { throw new Error("Managed device enrollment could not be verified"); });
  const storeRoot = requiredAbsolute("MEETLESS_STORE_ROOT");
  const convexUrl = requiredEnv("MEETLESS_CONVEX_URL");
  const upload = new ConvexManagedUploadPort(new ConvexHttpManagedFunctionClient(convexUrl), {
    journal: new FileManagedConvexUploadJournal(path.join(storeRoot, "managed-convex-upload-journal")),
  });
  return new ConvexManagedTranscriptionService(getMeetingStore(), {
    lifecycle: meetingLifecycle,
    timelineArtifacts: new ManagedTimelineArtifactStore(path.join(storeRoot, "managed-artifacts")),
    managedUpload: upload,
  }).transcribe({ recordingId: input.recordingId, credential, onDurableStart: input.onDurableStart });
}

async function readControlledUiTestIdentity(): Promise<UiTestIdentity | null> {
  if (process.env.MEETLESS_UI_TEST_MODE !== "1") return null;
  const markerPath = process.env.MEETLESS_UI_TEST_MARKER?.trim();
  const runtimeRoot = process.env.MEETLESS_RUNTIME_ROOT?.trim();
  if (!markerPath || !runtimeRoot || path.resolve(markerPath) !== path.join(path.resolve(runtimeRoot), "ui-test-run.json")) {
    throw new Error("Controlled UI-test mode requires the exact runtime-root consumed marker");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new Error("Controlled UI-test mode requires a readable consumed marker");
  }
  const identity = UiTestIdentitySchema.parse(
    decoded && typeof decoded === "object" && "identity" in decoded ? decoded.identity : undefined,
  );
  if (
    process.env.MEETLESS_UI_TEST_RUN_ID !== identity.runId ||
    process.env.MEETLESS_CAPTURE_MODE !== identity.captureMode ||
    (process.env.MEETLESS_TRANSCRIPTION_MODE ?? "") !== identity.transcriptionMode
  ) {
    throw new Error("Controlled UI-test environment does not match the consumed marker identity");
  }
  return identity;
}

export function resolveFixtureExportNow(fixture: boolean, fixedStamp: string | undefined): (() => Date) | undefined {
  return fixture && fixedStamp ? () => new Date(fixedStamp) : undefined;
}

function requiredAbsolute(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path fixed by the Meetless launcher`);
  return path.resolve(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured for the explicit managed Convex command`);
  return value;
}

function assertBootstrapDeadline(deadlineEpochMs: number): void {
  if (Date.now() >= deadlineEpochMs) {
    throw new Error("Meetless recording runtime bootstrap exceeded the launcher startup deadline");
  }
}
