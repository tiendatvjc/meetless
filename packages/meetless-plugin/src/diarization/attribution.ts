import type { SourceChunkOffset } from "../source-timeline.js";

/**
 * Speaker attribution stage B3 (pure mapping): attribute transcript segments to
 * diarization speaker turns by temporal overlap, and map per-source WAV turn
 * coordinates back onto the shared logical meeting timeline. No I/O, no clock,
 * no store — every function here is deterministic and unit-testable.
 */

/** One diarization turn on some timeline; speakers are "S1", "S2", ... by first appearance. */
export interface SpeakerTurn {
  readonly speaker: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** A transcript-like segment carrying optional stage-A attribution state. */
export interface AttributableSegment {
  readonly startMs: number;
  readonly endMs: number;
  /** Stage-A two-source label; microphone segments ("Bạn") pass through untouched. */
  readonly speakerLabel?: string;
}

export interface AttributedSegment<S extends AttributableSegment> {
  readonly startMs: number;
  readonly endMs: number;
  readonly speakerLabel?: string;
  /** Diarization speaker id ("S1"...) when a turn matched; absent otherwise. */
  readonly speakerId?: string;
}

export interface AttributionOptions {
  /**
   * Minimum share of the segment duration that the winning turn must cover.
   * Defaults to 0.5 (≥50% overlap).
   */
  minOverlapRatio?: number;
}

export const MICROPHONE_SPEAKER_LABEL = "Bạn";
export const DEFAULT_MIN_OVERLAP_RATIO = 0.5;

/**
 * Attribute each segment to the speaker turn covering the largest portion of
 * it, requiring at least `minOverlapRatio` of the segment duration (ties keep
 * the turn that covers more, then the earlier turn, then the lower speaker id,
 * so results are deterministic). Segments already attributed to the microphone
 * source ("Bạn") and segments with no ≥threshold turn are returned untouched —
 * the same object reference, no `speakerId`. With zero turns every segment is
 * returned unchanged.
 */
export function attributeSegments<S extends AttributableSegment>(
  segments: readonly S[],
  turns: readonly SpeakerTurn[],
  options?: AttributionOptions,
): Array<S | (S & { speakerId: string })> {
  const minRatio = options?.minOverlapRatio ?? DEFAULT_MIN_OVERLAP_RATIO;
  if (turns.length === 0) return [...segments];
  return segments.map((segment) => {
    const durationMs = segment.endMs - segment.startMs;
    if (durationMs <= 0) return segment;
    if (segment.speakerLabel === MICROPHONE_SPEAKER_LABEL) return segment;
    let best: { overlapMs: number; turn: SpeakerTurn } | null = null;
    for (const turn of turns) {
      const overlapMs = Math.min(segment.endMs, turn.endMs) - Math.max(segment.startMs, turn.startMs);
      if (overlapMs <= 0) continue;
      if (!best || overlapMs > best.overlapMs ||
        (overlapMs === best.overlapMs && earlierTurnWins(turn, best.turn))) {
        best = { overlapMs, turn };
      }
    }
    if (!best || best.overlapMs < minRatio * durationMs) return segment;
    return { ...segment, speakerId: best.turn.speaker };
  });
}

function earlierTurnWins(candidate: SpeakerTurn, incumbent: SpeakerTurn): boolean {
  return candidate.startMs < incumbent.startMs ||
    (candidate.startMs === incumbent.startMs && candidate.speaker < incumbent.speaker);
}

/**
 * Map turns from the concatenated per-source WAV timeline onto the shared
 * logical meeting timeline through the chunk offsets. A turn spanning several
 * chunks is split at chunk boundaries so logical silence gaps between chunks
 * are never bridged as speech. Sub-turns stay sorted and non-overlapping.
 */
export function mapTurnsToLogicalTimeline(
  turns: readonly SpeakerTurn[],
  chunkOffsets: readonly SourceChunkOffset[],
): SpeakerTurn[] {
  if (chunkOffsets.length === 0) return [];
  const mapped: SpeakerTurn[] = [];
  for (const turn of turns) {
    for (const chunk of chunkOffsets) {
      const chunkTimelineEnd = chunk.timelineStartMs + chunk.durationMs;
      const overlapStart = Math.max(turn.startMs, chunk.timelineStartMs);
      const overlapEnd = Math.min(turn.endMs, chunkTimelineEnd);
      if (overlapEnd <= overlapStart) continue;
      mapped.push({
        speaker: turn.speaker,
        startMs: chunk.logicalStartMs + (overlapStart - chunk.timelineStartMs),
        endMs: chunk.logicalStartMs + (overlapEnd - chunk.timelineStartMs),
      });
    }
  }
  mapped.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs || left.speaker.localeCompare(right.speaker));
  return mapped;
}

/** Distinct speaker ids in order of first turn appearance. */
export function speakerAppearanceOrder(turns: readonly SpeakerTurn[]): string[] {
  const order: string[] = [];
  for (const turn of turns) {
    if (!order.includes(turn.speaker)) order.push(turn.speaker);
  }
  return order;
}

/**
 * Default display names: "S1" → "Người 1", ... by turn order. Ids that do not
 * follow the sidecar's S-numbering fall back to their appearance position.
 */
export function defaultSpeakerNames(speakerIds: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  speakerIds.forEach((speakerId, index) => {
    const numbered = /^S(\d+)$/u.exec(speakerId);
    let name = `Người ${numbered ? Number(numbered[1]) : index + 1}`;
    // The sidecar numbers speakers without gaps, so this only fires on malformed ids.
    if (used.has(name)) name = `${name} (${index + 1})`;
    used.add(name);
    names.set(speakerId, name);
  });
  return names;
}
