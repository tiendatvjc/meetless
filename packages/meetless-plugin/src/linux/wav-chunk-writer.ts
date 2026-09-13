import { createHash, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const LINUX_CHUNK_SAMPLE_RATE = 16_000 as const;
export const LINUX_CHUNK_CHANNELS = 1 as const;
export const LINUX_CHUNK_BYTES_PER_SECOND = LINUX_CHUNK_SAMPLE_RATE * 2 * LINUX_CHUNK_CHANNELS;
export const LINUX_CHUNK_PAYLOAD_BYTES = 30 * LINUX_CHUNK_BYTES_PER_SECOND;

export interface LinuxChunkEvent {
  id: string;
  source: "microphone" | "system";
  path: string;
  byteLength: number;
  sha256: string;
  logicalStartMs: number;
  durationMs: number;
  sampleRate: typeof LINUX_CHUNK_SAMPLE_RATE;
  channels: typeof LINUX_CHUNK_CHANNELS;
  format: "wav";
}

export function wavHeader(payloadBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + payloadBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(LINUX_CHUNK_CHANNELS, 22);
  header.writeUInt32LE(LINUX_CHUNK_SAMPLE_RATE, 24);
  header.writeUInt32LE(LINUX_CHUNK_BYTES_PER_SECOND, 28);
  header.writeUInt16LE(LINUX_CHUNK_CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(payloadBytes, 40);
  return header;
}

export class WavChunkWriter {
  private pending = Buffer.alloc(0);
  private pendingStartMs: number | null = null;
  private sequence = 0;

  constructor(private readonly options: {
    sessionDirectory: string;
    recordingId: string;
    source: "microphone" | "system";
    chunkPayloadBytes?: number;
  }) {}

  async append(pcm: Buffer, logicalNowMs: number): Promise<LinuxChunkEvent[]> {
    if (this.pending.length === 0) this.pendingStartMs = logicalNowMs;
    this.pending = Buffer.concat([this.pending, pcm]);
    const events: LinuxChunkEvent[] = [];
    const target = this.options.chunkPayloadBytes ?? LINUX_CHUNK_PAYLOAD_BYTES;
    while (this.pending.length >= target) {
      const payload = this.pending.subarray(0, target);
      this.pending = this.pending.subarray(target);
      const event = await this.commit(payload, this.pendingStartMs ?? logicalNowMs);
      this.pendingStartMs = this.pending.length > 0 ? logicalNowMs : null;
      events.push(event);
    }
    return events;
  }

  async flush(logicalNowMs: number): Promise<LinuxChunkEvent[]> {
    if (this.pending.length === 0) return [];
    const event = await this.commit(this.pending, this.pendingStartMs ?? logicalNowMs);
    this.pending = Buffer.alloc(0);
    this.pendingStartMs = null;
    return [event];
  }

  private async commit(payload: Buffer, logicalStartMs: number): Promise<LinuxChunkEvent> {
    this.sequence += 1;
    const fileName = `${this.options.recordingId}-${this.options.source}-${String(this.sequence).padStart(4, "0")}.wav`;
    const finalPath = path.join(this.options.sessionDirectory, fileName);
    const stagePath = `${finalPath}.${randomUUID()}.stage`;
    const bytes = Buffer.concat([wavHeader(payload.length), payload]);
    await writeFile(stagePath, bytes, { mode: 0o600 });
    await rename(stagePath, finalPath);
    return {
      id: randomUUID(),
      source: this.options.source,
      path: finalPath,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      logicalStartMs: Math.max(0, Math.round(logicalStartMs)),
      durationMs: Math.round((payload.length / LINUX_CHUNK_BYTES_PER_SECOND) * 1_000),
      sampleRate: LINUX_CHUNK_SAMPLE_RATE,
      channels: LINUX_CHUNK_CHANNELS,
      format: "wav",
    };
  }
}
