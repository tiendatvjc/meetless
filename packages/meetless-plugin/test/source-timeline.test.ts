import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildSourceTimelines } from "../src/source-timeline.js";

/**
 * Speaker attribution stage A: per-source timeline construction. Real 16 kHz
 * mono s16le WAV chunks are generated in a tmpdir session and concatenated
 * with the production ffmpeg, so the test exercises the actual demuxer path.
 */

const linux = process.platform === "linux";
const ffmpeg = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout?.trim() ?? "";
const runnable = linux && ffmpeg;

const roots = new Set<string>();
const savedFfmpegEnv = process.env.MEETLESS_FFMPEG;

afterEach(async () => {
  process.env.MEETLESS_FFMPEG = savedFfmpegEnv;
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

(runnable ? describe : describe.skip)("per-source timeline builder", () => {
  test("concatenates each source in timeline order and maps logical to timeline offsets", async () => {
    const sessionDir = await session();
    await writeChunk(sessionDir, "microphone", 0, 0, 16_000, 1_000);
    await writeChunk(sessionDir, "microphone", 1, 32_000, 8_000, 2_000);
    await writeChunk(sessionDir, "microphone", 2, 48_000, 16_000, 3_000);
    await writeChunk(sessionDir, "system", 0, 0, 24_000, -1_000);
    await writeChunk(sessionDir, "system", 1, 40_000, 8_000, -2_000);
    // Non-chunk session artefacts must be ignored, never concatenated.
    await writeFile(path.join(sessionDir, "inventory-deadbeef.ndjson"), "{}\n");
    await writeFile(path.join(sessionDir, "chunk--microphone--bogus.wav"), Buffer.alloc(64));

    const timelines = await buildSourceTimelines(sessionDir, "rec-timeline", { ffmpeg });

    expect(timelines.microphone).not.toBeNull();
    expect(timelines.microphone!.durationMs).toBe(2_500);
    expect(timelines.microphone!.chunkOffsets).toEqual([
      {
        chunkId: "chunk--microphone--000000--000000000000--000000016000--16000--1",
        logicalStartMs: 0,
        timelineStartMs: 0,
        durationMs: 1_000,
      },
      {
        chunkId: "chunk--microphone--000001--000000032000--000000008000--16000--1",
        logicalStartMs: 2_000,
        timelineStartMs: 1_000,
        durationMs: 500,
      },
      {
        chunkId: "chunk--microphone--000002--000000048000--000000016000--16000--1",
        logicalStartMs: 3_000,
        timelineStartMs: 1_500,
        durationMs: 1_000,
      },
    ]);
    expect(timelines.microphone!.wavPath).toBe(path.join(sessionDir, "source-timelines", "microphone.wav"));

    expect(timelines.system).not.toBeNull();
    expect(timelines.system!.durationMs).toBe(2_000);
    expect(timelines.system!.chunkOffsets).toEqual([
      {
        chunkId: "chunk--system--000000--000000000000--000000024000--16000--1",
        logicalStartMs: 0,
        timelineStartMs: 0,
        durationMs: 1_500,
      },
      {
        chunkId: "chunk--system--000001--000000040000--000000008000--16000--1",
        logicalStartMs: 2_500,
        timelineStartMs: 1_500,
        durationMs: 500,
      },
    ]);

    // The concatenated microphone WAV carries the chunk payloads in order.
    const microphone = pcmSamples(await readFile(timelines.microphone!.wavPath));
    expect(microphone.totalFrames).toBe(40_000);
    expect(microphone.sampleAt(0)).toBe(1_000);
    expect(microphone.sampleAt(16_000)).toBe(2_000);
    expect(microphone.sampleAt(24_000)).toBe(3_000);
    const system = pcmSamples(await readFile(timelines.system!.wavPath));
    expect(system.totalFrames).toBe(32_000);
    expect(system.sampleAt(0)).toBe(-1_000);
    expect(system.sampleAt(24_000)).toBe(-2_000);

    // Only the two published timelines remain in the staging directory.
    expect((await readdir(path.join(sessionDir, "source-timelines"))).sort()).toEqual(["microphone.wav", "system.wav"]);
  });

  test("reports a missing source as null so callers can fall back to the mixed transcript", async () => {
    const sessionDir = await session();
    await writeChunk(sessionDir, "microphone", 0, 0, 16_000, 1_000);

    const timelines = await buildSourceTimelines(sessionDir, "rec-single", { ffmpeg });

    expect(timelines.microphone).not.toBeNull();
    expect(timelines.microphone!.durationMs).toBe(1_000);
    expect(timelines.system).toBeNull();
  });

  test("rejects concatenated output whose duration disagrees with the declared frames", async () => {
    const sessionDir = await session();
    // Filename declares 32_000 frames but the payload carries only 16_000.
    await writeChunk(sessionDir, "microphone", 0, 0, 16_000, 1_000, "chunk--microphone--000000--000000000000--000000032000--16000--1.wav");

    await expect(buildSourceTimelines(sessionDir, "rec-skew", { ffmpeg }))
      .rejects.toThrow(/duration mismatch/u);
  });

  test("resolves ffmpeg from MEETLESS_FFMPEG at call time and fails without it", async () => {
    const sessionDir = await session();
    await writeChunk(sessionDir, "microphone", 0, 0, 16_000, 1_000);

    delete process.env.MEETLESS_FFMPEG;
    await expect(buildSourceTimelines(sessionDir, "rec-env")).rejects.toThrow(/ffmpeg/u);

    process.env.MEETLESS_FFMPEG = ffmpeg;
    const timelines = await buildSourceTimelines(sessionDir, "rec-env");
    expect(timelines.microphone!.durationMs).toBe(1_000);
  });
});

async function session(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-source-timeline-"));
  roots.add(root);
  return root;
}

async function writeChunk(
  sessionDirectory: string,
  source: "microphone" | "system",
  sequence: number,
  startFrame: number,
  frameCount: number,
  marker: number,
  overrideName?: string,
): Promise<void> {
  const name = overrideName ?? chunkName(source, sequence, startFrame, frameCount);
  await writeFile(path.join(sessionDirectory, name), pcmWav(frameCount, marker));
}

function chunkName(source: "microphone" | "system", sequence: number, startFrame: number, frameCount: number): string {
  return `chunk--${source}--${String(sequence).padStart(6, "0")}--${String(startFrame).padStart(12, "0")}--${String(frameCount).padStart(12, "0")}--16000--1.wav`;
}

function pcmWav(frameCount: number, marker: number): Buffer {
  const data = Buffer.alloc(44 + frameCount * 2);
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8, "ascii");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24);
  data.writeUInt32LE(32_000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii");
  data.writeUInt32LE(frameCount * 2, 40);
  for (let frame = 0; frame < frameCount; frame += 1) data.writeInt16LE(marker, 44 + frame * 2);
  return data;
}

function pcmSamples(bytes: Buffer): { totalFrames: number; sampleAt(frame: number): number } {
  if (bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WAVE") {
    throw new Error("concatenated timeline is not a RIFF/WAVE file");
  }
  let offset = 12;
  let payload: Buffer | null = null;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    if (kind === "data") payload = bytes.subarray(offset + 8, offset + 8 + size);
    offset = offset + 8 + size + (size % 2);
  }
  if (!payload || payload.length % 2 !== 0) throw new Error("concatenated timeline has no PCM payload");
  return {
    totalFrames: payload.length / 2,
    sampleAt: (frame: number) => payload!.readInt16LE(frame * 2),
  };
}
