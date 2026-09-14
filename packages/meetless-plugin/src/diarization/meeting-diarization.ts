import { readdir } from "node:fs/promises";
import path from "node:path";
import type { DiarizationStatusWire } from "@meetless/meeting-contracts";
import type { MeetingStore } from "@meetless/meeting-store";
import type { TranscriptState } from "@meetless/meeting-domain";
import { buildSourceTimelines, type SourceChunkOffset } from "../source-timeline.js";
import type { MeetingLifecycleCoordinator, MeetingLifecycleLease } from "../meeting-lifecycle-coordinator.js";
import type { DiarizerProvider } from "./diarizer.js";
import { DiarizationStore, type StoredDiarization } from "./diarization-store.js";
import {
  attributeSegments,
  defaultSpeakerNames,
  mapTurnsToLogicalTimeline,
  speakerAppearanceOrder,
  type SpeakerTurn,
} from "./attribution.js";

/**
 * Speaker diarization stage B4: run the pyannote provider over the system
 * capture timeline of a meeting's saved recording, attribute the ready
 * transcript's segments to speaker turns, and persist the attribution as a
 * per-meeting overlay (with display names) under the store root. Re-running is
 * idempotent — attribution is recomputed from the fresh turns and overwrites
 * the stored overlay; the durable transcript and its immutable publication are
 * never rewritten.
 */

export interface MeetingDiarizationDeps {
  readonly storeRoot: string;
  readonly store: MeetingStore;
  readonly provider: DiarizerProvider;
  readonly ffmpeg: string;
  readonly lifecycle?: MeetingLifecycleCoordinator;
  readonly now?: () => string;
}

export interface MeetingDiarizationOutcome {
  readonly status: DiarizationStatusWire;
  readonly transcript: TranscriptState | null;
}

/**
 * Transcript read-path overlay: segmentId → current display name, without
 * constructing the full service (so plain transcript reads never need the
 * ffmpeg/provider environment). Never throws for a missing overlay.
 */
export async function readSpeakerLabelOverlay(storeRoot: string, meetingId: string): Promise<Map<string, string>> {
  const stored = await new DiarizationStore(path.join(storeRoot, "diarization-names")).load(meetingId);
  const overlay = new Map<string, string>();
  if (!stored) return overlay;
  const names = new Map(stored.speakers.map((speaker) => [speaker.id, speaker.name]));
  for (const [segmentId, speakerId] of Object.entries(stored.segments)) {
    const name = names.get(speakerId);
    if (name) overlay.set(segmentId, name);
  }
  return overlay;
}

export class MeetingDiarizationService {
  private readonly diarization: DiarizationStore;
  private readonly now: () => string;
  private readonly running = new Map<string, { progress: number }>();

  constructor(private readonly deps: MeetingDiarizationDeps) {
    this.diarization = new DiarizationStore(path.join(deps.storeRoot, "diarization-names"));
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async status(meetingId: string): Promise<DiarizationStatusWire> {
    const availability = await this.deps.provider.available();
    const recording = await this.latestSavedRecording(meetingId);
    const transcript = await this.deps.store.getTranscriptForMeeting(meetingId);
    const hasSystemSource = recording ? await sessionHasSystemChunks(this.sessionDirectory(recording.id)) : false;
    const stored = await this.diarization.load(meetingId);
    const run = this.running.get(meetingId);
    return {
      meetingId,
      available: availability.ok,
      unavailableReason: availability.ok ? null : availability.reason ?? "not_installed",
      eligible: recording !== null && hasSystemSource && transcript?.status === "ready",
      applied: stored !== null,
      running: run !== undefined,
      progress: run?.progress ?? 0,
      speakers: stored ? stored.speakers.map((speaker) => ({ ...speaker })) : [],
    };
  }

  async run(meetingId: string): Promise<MeetingDiarizationOutcome> {
    // Claim the meeting synchronously before the first await: two concurrent
    // run RPCs must never both reach sidecar inference. Every early throw
    // below releases the claim through the shared finally.
    if (this.running.has(meetingId)) {
      throw new Error("Diarization is already running for this meeting");
    }
    this.running.set(meetingId, { progress: 0 });
    let lease: MeetingLifecycleLease | null = null;
    try {
      const recording = await this.latestSavedRecording(meetingId);
      if (!recording || recording.status !== "saved") {
        throw new Error("Speaker diarization requires the meeting's saved recording");
      }
      const transcript = await this.deps.store.getTranscriptForMeeting(meetingId);
      if (!transcript || transcript.status !== "ready") {
        throw new Error("Speaker diarization requires a ready transcript");
      }
      lease = this.deps.lifecycle?.tryAcquireWork(meetingId, "transcription") ?? null;
      if (this.deps.lifecycle && !lease) throw new Error("Meeting deletion is in progress");
      const timelines = await buildSourceTimelines(this.sessionDirectory(recording.id), recording.id, {
        ffmpeg: this.deps.ffmpeg,
      });
      if (!timelines.system) throw new Error("Speaker diarization requires system audio capture");
      const turns = await this.deps.provider.run(timelines.system.wavPath, (fraction) => {
        const run = this.running.get(meetingId);
        if (run) run.progress = fraction;
      });
      const stored = await this.persistAttribution(meetingId, recording.id, transcript, turns, timelines.system.chunkOffsets);
      const refreshed = await this.deps.store.getTranscriptForMeeting(meetingId);
      // Report the settled state: the run has finished, so clear the live marker
      // before reading the status (the finally keeps the failure path covered).
      this.running.delete(meetingId);
      return {
        status: await this.statusWith(meetingId, stored),
        transcript: refreshed ?? transcript,
      };
    } finally {
      this.running.delete(meetingId);
      lease?.release();
    }
  }

  async rename(meetingId: string, names: Readonly<Record<string, string>>): Promise<MeetingDiarizationOutcome> {
    const stored = await this.diarization.renameSpeakers(meetingId, names);
    if (!stored) throw new Error(`No speaker diarization is stored for meeting: ${meetingId}`);
    return {
      status: await this.statusWith(meetingId, stored),
      transcript: await this.deps.store.getTranscriptForMeeting(meetingId),
    };
  }

  /** Transcript wire overlay: segmentId → current display name for attributed segments. */
  async overlayLabels(meetingId: string): Promise<Map<string, string>> {
    return readSpeakerLabelOverlay(this.deps.storeRoot, meetingId);
  }

  private async persistAttribution(
    meetingId: string,
    recordingId: string,
    transcript: TranscriptState,
    turns: readonly SpeakerTurn[],
    chunkOffsets: readonly SourceChunkOffset[],
  ): Promise<StoredDiarization> {
    const logicalTurns = mapTurnsToLogicalTimeline(turns, chunkOffsets);
    const attributed = attributeSegments(
      transcript.checkpoints.map((checkpoint) => ({
        segmentId: checkpoint.range.segmentId,
        startMs: checkpoint.range.startMs,
        endMs: checkpoint.range.endMs,
        speakerLabel: checkpoint.speakerLabel,
      })),
      logicalTurns,
    );
    const segments: Record<string, string> = {};
    for (const segment of attributed) {
      const speakerId = (segment as { speakerId?: string }).speakerId;
      if (speakerId !== undefined) segments[segment.segmentId] = speakerId;
    }
    const defaults = defaultSpeakerNames(speakerAppearanceOrder(logicalTurns));
    const record: StoredDiarization = {
      version: 1,
      meetingId,
      recordingId,
      appliedAt: this.now(),
      speakers: [...defaults.entries()].map(([id, name]) => ({ id, name })),
      segments,
    };
    await this.diarization.save(record);
    return record;
  }

  private async statusWith(meetingId: string, stored: StoredDiarization): Promise<DiarizationStatusWire> {
    const status = await this.status(meetingId);
    return { ...status, applied: true, speakers: stored.speakers.map((speaker) => ({ ...speaker })) };
  }

  private async latestSavedRecording(meetingId: string) {
    const recordings = (await this.deps.store.listRecordings())
      .filter((recording) => recording.meetingId === meetingId && recording.status === "saved");
    return recordings.length > 0 ? recordings[recordings.length - 1]! : null;
  }

  private sessionDirectory(recordingId: string): string {
    return path.join(this.deps.storeRoot, "sessions", recordingId);
  }
}

async function sessionHasSystemChunks(sessionDirectory: string): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(sessionDirectory);
  } catch {
    return false;
  }
  return entries.some((name) => name.startsWith("chunk--system--"));
}
