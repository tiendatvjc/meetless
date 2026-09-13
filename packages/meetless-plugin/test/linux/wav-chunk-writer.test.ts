import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WavChunkWriter } from "../../src/linux/wav-chunk-writer.js";

let sessionDirectory: string;

beforeAll(async () => {
  sessionDirectory = await mkdtemp(path.join(tmpdir(), "meetless-wav-"));
});
afterAll(async () => {
  await rm(sessionDirectory, { recursive: true, force: true });
});

function silence(payloadBytes: number): Buffer {
  return Buffer.alloc(payloadBytes);
}

describe("WavChunkWriter", () => {
  it("commits a 16 kHz mono WAV chunk with sha256 and logical timing", async () => {
    const writer = new WavChunkWriter({ sessionDirectory, recordingId: "rec-1", source: "microphone", chunkPayloadBytes: 100 });
    const events = await writer.append(silence(150), 0);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.source).toBe("microphone");
    expect(event.sampleRate).toBe(16_000);
    expect(event.channels).toBe(1);
    expect(event.format).toBe("wav");
    expect(event.byteLength).toBe(100 + 44);
    expect(event.durationMs).toBe(Math.round((100 / 32_000) * 1_000));
    const bytes = await readFile(event.path);
    expect(bytes.byteLength).toBe(event.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(event.sha256);
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    // data payload follows the 44-byte canonical header
    expect(bytes.subarray(44).byteLength).toBe(100);
  });

  it("flushes a trailing partial chunk once and leaves no stage files", async () => {
    const writer = new WavChunkWriter({ sessionDirectory, recordingId: "rec-2", source: "system", chunkPayloadBytes: 100 });
    const committed = await writer.append(silence(120), 0);
    const trailing = await writer.flush(10_000);
    expect(committed).toHaveLength(1);
    expect(trailing).toHaveLength(1);
    expect(trailing[0]!.byteLength).toBe(20 + 44);
    expect(await writer.flush(11_000)).toHaveLength(0);
    const files = await readdir(sessionDirectory);
    expect(files.every((name) => !name.endsWith(".stage"))).toBe(true);
    expect(files.some((name) => name.startsWith("rec-2-system-"))).toBe(true);
  });
});
