import {
  DEFAULT_TRANSCRIPT_RANGE_MS,
  type TranscriptRange,
  transcriptSegmentId,
} from "@meetless/meeting-domain";
import type { RecordingSource, SourceChunkOffset, SourceTimeline } from "./source-timeline.js";
import { MICROPHONE_SPEAKER_LABEL } from "./diarization/attribution.js";

/**
 * Speaker attribution stage A3: turn the two per-source capture timelines into
 * one deterministic transcript range plan on the shared logical meeting
 * timeline. Each planned range belongs to exactly one source, so its text can
 * be checkpointed with the matching speaker label and later rendered as a
 * chip in the meeting surface.
 */

export const SPEAKER_LABELS: Readonly<Record<RecordingSource, string>> = {
  microphone: MICROPHONE_SPEAKER_LABEL,
  system: "Cuộc họp",
};

/** Audio window on the concatenated per-source WAV for one planned range. */
export interface TwoSourceRangePlanEntry {
  readonly source: RecordingSource;
  readonly speakerLabel: string;
  readonly timelineStartMs: number;
  readonly timelineEndMs: number;
}

export interface TwoSourceTranscriptPlan {
  /** Deterministic logical-timeline ranges in interleaved checkpoint order. */
  readonly ranges: readonly TranscriptRange[];
  /** Source audio window per range, aligned with `ranges` by index. */
  readonly entries: readonly TwoSourceRangePlanEntry[];
}

interface PlannedSourceWindow {
  readonly source: RecordingSource;
  readonly speakerLabel: string;
  readonly timelineStartMs: number;
  readonly timelineEndMs: number;
  readonly logicalStartMs: number;
  readonly logicalEndMs: number;
}

/**
 * Merge per-source range windows into one checkpoint order: logical start
 * ascending, microphone before system on ties, then logical end and timeline
 * position so the order is total and rebuildable after a restart.
 */
function mergeTwoSourceRangePlans(
  microphone: readonly PlannedSourceWindow[],
  system: readonly PlannedSourceWindow[],
): PlannedSourceWindow[] {
  return [...microphone, ...system].sort((left, right) =>
    left.logicalStartMs - right.logicalStartMs ||
    sourceRank(left.source) - sourceRank(right.source) ||
    left.logicalEndMs - right.logicalEndMs ||
    left.timelineStartMs - right.timelineStartMs);
}

function sourceRank(source: RecordingSource): number {
  return source === "microphone" ? 0 : 1;
}

export function buildTwoSourceTranscriptPlan(input: {
  microphone: SourceTimeline;
  system: SourceTimeline;
  recordingId: string;
  audioSha256: string;
  rangeMs?: number;
}): TwoSourceTranscriptPlan {
  const rangeMs = input.rangeMs ?? DEFAULT_TRANSCRIPT_RANGE_MS;
  const merged = mergeTwoSourceRangePlans(
    planSourceWindows(input.microphone, rangeMs),
    planSourceWindows(input.system, rangeMs),
  );
  const ranges: TranscriptRange[] = merged.map((window, ordinal) => ({
    ordinal,
    startMs: window.logicalStartMs,
    endMs: window.logicalEndMs,
    segmentId: transcriptSegmentId({
      recordingId: input.recordingId,
      audioSha256: input.audioSha256,
      ordinal,
      startMs: window.logicalStartMs,
      endMs: window.logicalEndMs,
    }),
  }));
  return {
    ranges,
    entries: merged.map((window) => ({
      source: window.source,
      speakerLabel: window.speakerLabel,
      timelineStartMs: window.timelineStartMs,
      timelineEndMs: window.timelineEndMs,
    })),
  };
}

/**
 * Dispatch decision for the BYOK two-source route. Returns the plan to run,
 * or null when the caller must fall back to the existing mixed-audio flow:
 * a missing/empty source timeline, or an existing transcript that follows a
 * different (legacy planner) range plan.
 */
export function resolveTwoSourcePlan(input: {
  microphone: SourceTimeline | null;
  system: SourceTimeline | null;
  recordingId: string;
  audioSha256: string;
  rangeMs?: number;
  existingRanges?: readonly TranscriptRange[] | null;
}): TwoSourceTranscriptPlan | null {
  if (!input.microphone || !input.system) return null;
  // Preserved timelines (post chunk-cleanup) carry no per-chunk offsets;
  // treat the entire WAV as a single window per source.
  if (input.microphone.chunkOffsets.length === 0 && input.microphone.durationMs > 0) {
    return buildTwoSourceTranscriptPlan({
      ...input,
      microphone: { ...input.microphone, chunkOffsets: [{ chunkId: "preserved-microphone", logicalStartMs: 0, timelineStartMs: 0, durationMs: input.microphone.durationMs }] },
      system: { ...input.system, chunkOffsets: [{ chunkId: "preserved-system", logicalStartMs: 0, timelineStartMs: 0, durationMs: input.system.durationMs }] },
    });
  }
  if (input.microphone.chunkOffsets.length === 0) return null;
  if (input.system.chunkOffsets.length === 0) return null;
  const plan = buildTwoSourceTranscriptPlan({
    microphone: input.microphone,
    system: input.system,
    recordingId: input.recordingId,
    audioSha256: input.audioSha256,
    rangeMs: input.rangeMs,
  });
  if (input.existingRanges && !sameRangePlan(input.existingRanges, plan.ranges)) return null;
  return plan;
}

function sameRangePlan(left: readonly TranscriptRange[], right: readonly TranscriptRange[]): boolean {
  return left.length === right.length && left.every((range, index) => JSON.stringify(range) === JSON.stringify(right[index]));
}

/**
 * Plan half-open windows of `rangeMs` over the concatenated per-source WAV
 * (the same windowing discipline as the deterministic transcript planner) and
 * map each window onto the shared logical timeline through the chunk offsets,
 * so logical silence gaps between chunks stay inside one mapped range.
 */
function planSourceWindows(timeline: SourceTimeline, rangeMs: number): PlannedSourceWindow[] {
  const windows: PlannedSourceWindow[] = [];
  for (let startMs = 0; startMs < timeline.durationMs; startMs += rangeMs) {
    const endMs = Math.min(timeline.durationMs, startMs + rangeMs);
    windows.push({
      source: timeline.source,
      speakerLabel: SPEAKER_LABELS[timeline.source],
      timelineStartMs: startMs,
      timelineEndMs: endMs,
      logicalStartMs: timelineStartToLogicalMs(timeline.chunkOffsets, startMs),
      logicalEndMs: timelineEndToLogicalMs(timeline.chunkOffsets, endMs),
    });
  }
  return windows;
}

/**
 * Map an inclusive window start: a position sitting exactly on a chunk
 * boundary belongs to the chunk that starts there (its first millisecond of
 * audio). Chunk offsets are contiguous in timeline milliseconds, so the
 * containing chunk gives an exact linear mapping.
 */
function timelineStartToLogicalMs(chunkOffsets: readonly SourceChunkOffset[], positionMs: number): number {
  let mapped = chunkOffsets[0]!.logicalStartMs;
  for (const chunk of chunkOffsets) {
    if (positionMs < chunk.timelineStartMs + chunk.durationMs) {
      return chunk.logicalStartMs + (positionMs - chunk.timelineStartMs);
    }
    mapped = chunk.logicalStartMs + chunk.durationMs;
  }
  return mapped;
}

/**
 * Map an exclusive window end: a position sitting exactly on a chunk boundary
 * closes the chunk that ends there, keeping half-open logical ranges tight
 * around the audio the window actually carries. Positions past the final
 * chunk clamp to its logical end.
 */
function timelineEndToLogicalMs(chunkOffsets: readonly SourceChunkOffset[], positionMs: number): number {
  let mapped = chunkOffsets[0]!.logicalStartMs;
  for (const chunk of chunkOffsets) {
    if (positionMs > chunk.timelineStartMs) {
      mapped = chunk.logicalStartMs + Math.min(positionMs - chunk.timelineStartMs, chunk.durationMs);
    } else break;
  }
  return mapped;
}
