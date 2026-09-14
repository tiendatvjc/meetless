import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseCanonicalPcmWav } from "@meetless/managed-transcription-foundation";

const execFileAsync = promisify(execFile);

/**
 * Speaker attribution stage A: rebuild one continuous WAV per capture source
 * (microphone/system) from the committed session chunks so each side can be
 * transcribed separately and later re-combined with speaker labels.
 *
 * Chunks of a source share one format (16 kHz mono s16le PCM WAV), so the
 * ffmpeg concat demuxer stream-copies them without re-encoding. The chunk
 * offset map translates positions on the concatenated per-source timeline
 * back to the shared logical meeting timeline (derived from each chunk's
 * filename startFrame), which is what survives gaps between chunks.
 */

export type RecordingSource = "microphone" | "system";

export interface SourceChunkOffset {
  readonly chunkId: string;
  /** Chunk position on the shared logical meeting timeline. */
  readonly logicalStartMs: number;
  /** Chunk position inside the concatenated per-source WAV. */
  readonly timelineStartMs: number;
  readonly durationMs: number;
}

export interface SourceTimeline {
  readonly source: RecordingSource;
  readonly wavPath: string;
  readonly durationMs: number;
  readonly chunkOffsets: readonly SourceChunkOffset[];
}

export interface SourceTimelines {
  /** Null when the session committed no chunks for that source. */
  readonly microphone: SourceTimeline | null;
  readonly system: SourceTimeline | null;
}

export interface SourceTimelineOptions {
  ffmpeg: string;
}

interface SessionChunk {
  readonly source: RecordingSource;
  readonly fileName: string;
  readonly sequence: number;
  readonly startFrame: number;
  readonly frameCount: number;
}

const SOURCE_DIRECTORY = "source-timelines";
const CHUNK_FILENAME_PATTERN = /^chunk--(microphone|system)--(\d{6})--(\d{12})--(\d{12})--(\d+)--(\d+)\.wav$/u;
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;

export function sourceTimelinePath(sessionDirectory: string, source: RecordingSource): string {
  return path.join(sessionDirectory, SOURCE_DIRECTORY, `${source}.wav`);
}

export async function buildSourceTimelines(
  sessionDirectory: string,
  recordingId: string,
  options?: SourceTimelineOptions,
): Promise<SourceTimelines> {
  const ffmpeg = (options?.ffmpeg ?? process.env.MEETLESS_FFMPEG)?.trim();
  if (!ffmpeg) {
    throw new Error("Source timeline concatenation requires the ffmpeg executable (options.ffmpeg or MEETLESS_FFMPEG)");
  }
  const chunks = await listSessionChunks(sessionDirectory);
  const outputDirectory = path.join(sessionDirectory, SOURCE_DIRECTORY);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const timelines = new Map<RecordingSource, SourceTimeline>();
  for (const source of ["microphone", "system"] as const) {
    const sourceChunks = chunks.filter((chunk) => chunk.source === source);
    if (sourceChunks.length === 0) continue;
    timelines.set(source, await concatenateSource(sessionDirectory, recordingId, source, sourceChunks, ffmpeg));
  }
  return {
    microphone: timelines.get("microphone") ?? null,
    system: timelines.get("system") ?? null,
  };
}

async function listSessionChunks(sessionDirectory: string): Promise<SessionChunk[]> {
  const chunks: SessionChunk[] = [];
  for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = CHUNK_FILENAME_PATTERN.exec(entry.name);
    if (!match) continue;
    const sequence = Number(match[2]);
    const startFrame = Number(match[3]);
    const frameCount = Number(match[4]);
    const sampleRate = Number(match[5]);
    const channels = Number(match[6]);
    if (
      !Number.isSafeInteger(sequence) || !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(frameCount) ||
      startFrame < 0 || frameCount <= 0
    ) {
      throw new Error(`Source timeline chunk has unsafe timeline metadata: ${entry.name}`);
    }
    if (sampleRate !== SAMPLE_RATE || channels !== CHANNELS) {
      throw new Error(`Source timeline requires ${SAMPLE_RATE} Hz mono PCM WAV chunks: ${entry.name}`);
    }
    chunks.push({ source: match[1] as RecordingSource, fileName: entry.name, sequence, startFrame, frameCount });
  }
  chunks.sort((left, right) =>
    left.startFrame - right.startFrame || left.sequence - right.sequence || left.fileName.localeCompare(right.fileName));
  for (const source of ["microphone", "system"] as const) {
    let previousEndFrame = 0;
    for (const chunk of chunks.filter((candidate) => candidate.source === source)) {
      if (chunk.startFrame < previousEndFrame) {
        throw new Error(`Source timeline chunks overlap on the logical timeline: ${chunk.fileName}`);
      }
      previousEndFrame = chunk.startFrame + chunk.frameCount;
    }
  }
  return chunks;
}

async function concatenateSource(
  sessionDirectory: string,
  recordingId: string,
  source: RecordingSource,
  chunks: readonly SessionChunk[],
  ffmpeg: string,
): Promise<SourceTimeline> {
  const outputDirectory = path.join(sessionDirectory, SOURCE_DIRECTORY);
  const token = randomUUID();
  const listPath = path.join(outputDirectory, `.meetless-${recordingId}-${token}-${source}.concat.txt`);
  const stagePath = path.join(outputDirectory, `.meetless-${recordingId}-${token}-${source}.wav.stage`);
  const wavPath = sourceTimelinePath(sessionDirectory, source);
  try {
    const list = chunks.map((chunk) => `file '${escapeConcatPath(path.join(sessionDirectory, chunk.fileName))}'`).join("\n");
    await writeFile(listPath, `${list}\n`, { mode: 0o600 });
    const args = [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-f", "wav", stagePath,
    ];
    await execFileAsync(ffmpeg, args, { timeout: 600_000, maxBuffer: 1024 * 1024 });
    const canonical = parseCanonicalPcmWav(await readFile(stagePath));
    const declaredFrames = chunks.reduce((total, chunk) => total + chunk.frameCount, 0);
    if (canonical.sampleCount !== declaredFrames) {
      throw new Error(
        `Source timeline duration mismatch for ${source}: concatenated ${canonical.sampleCount} frames but the chunks declare ${declaredFrames} (${recordingId})`,
      );
    }
    await rename(stagePath, wavPath);
    return {
      source,
      wavPath,
      durationMs: framesToMs(declaredFrames),
      chunkOffsets: chunkOffsets(chunks),
    };
  } finally {
    await Promise.all([
      rm(listPath, { force: true }).catch(() => undefined),
      rm(stagePath, { force: true }).catch(() => undefined),
    ]);
  }
}

function chunkOffsets(chunks: readonly SessionChunk[]): SourceChunkOffset[] {
  let timelineFrames = 0;
  return chunks.map((chunk) => {
    const offset: SourceChunkOffset = {
      chunkId: path.basename(chunk.fileName, ".wav"),
      logicalStartMs: framesToMs(chunk.startFrame),
      timelineStartMs: framesToMs(timelineFrames),
      durationMs: Math.max(1, framesToMs(chunk.frameCount)),
    };
    timelineFrames += chunk.frameCount;
    return offset;
  });
}

function framesToMs(frames: number): number {
  return Math.floor(frames * 1_000 / SAMPLE_RATE);
}

function escapeConcatPath(filePath: string): string {
  return filePath.replaceAll("'", `'\\''`);
}
