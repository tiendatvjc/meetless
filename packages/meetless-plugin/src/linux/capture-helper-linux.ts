import { execFile, spawn, type ChildProcess } from "node:child_process";
import { rename } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import path from "node:path";
import { LogicalClock } from "./logical-clock.js";
import { WavChunkWriter, type LinuxChunkEvent } from "./wav-chunk-writer.js";

export const LINUX_FIXTURE_TICK_MS = 2_000;
export const LINUX_FIXTURE_TICK_BYTES = 64_000;

/** Canonical 44-byte RIFF/WAVE header written by `wavHeader`. */
const LINUX_WAV_HEADER_BYTES = 44;

export interface ChildProcessLike {
  stdout: Readable;
  kill(signal?: string): void;
}

export interface LinuxHelperCommand {
  version: number;
  command: "start" | "pause" | "resume" | "stop";
  sessionDirectory?: string;
  elapsedMs?: number;
}

export function parseLinuxHelperCommand(line: string): LinuxHelperCommand | null {
  try {
    const value = JSON.parse(line) as LinuxHelperCommand;
    if (typeof value?.command !== "string") return null;
    if (value.command !== "start" && value.command !== "pause" && value.command !== "resume" && value.command !== "stop") return null;
    return value;
  } catch {
    return null;
  }
}

export async function resolveParecDevice(
  kind: "microphone" | "system",
  run: (command: string, args: string[]) => Promise<string> = execCapture,
): Promise<string> {
  if (kind === "microphone") return (await run("pactl", ["get-default-source"])).trim();
  const sink = (await run("pactl", ["get-default-sink"])).trim();
  return `${sink}.monitor`;
}

async function execCapture(command: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(command, args);
  return stdout;
}

export function spawnParecSource(device: string): ChildProcessLike {
  const child: ChildProcess = spawn("parec", [
    "--format=s16le", "--rate=16000", "--channels=1", `--device=${device}`,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  return {
    stdout: child.stdout!,
    kill: (signal?: string) => { child.kill(signal as NodeJS.Signals | undefined); },
  };
}

export function spawnFixtureSource(tickMs: number, tickBytes: number): ChildProcessLike & { stop(): void } {
  const output = new Readable({ read() { /* pushed by timer */ } });
  const silence = Buffer.alloc(tickBytes);
  const timer = setInterval(() => { output.push(silence); }, tickMs);
  const stop = () => { clearInterval(timer); output.push(null); };
  return { stdout: output, kill: () => stop(), stop };
}

function emit(event: Record<string, unknown>, onFlushed?: () => void): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...event })}\n`, onFlushed);
}

interface SourceBinding {
  writer: WavChunkWriter | null;
  child: ChildProcessLike | null;
  /** Completion of the stdout read loop; stop awaits it before flushing. */
  loop: Promise<void> | null;
  /** Storage-contract chunk sequence for this source. */
  sequence: number;
  /** Carries a trailing odd byte so committed payloads stay sample-aligned. */
  carry: Buffer;
}

/**
 * The committed-chunk storage contract (`validateCommittedWavChunk`, matching the
 * macOS helper) encodes source, sequence, start frame, frame count, rate, and
 * channels in the chunk id/filename and derives logical start/duration from
 * those frames. `WavChunkWriter` stages and hashes the WAV bytes under its own
 * interim name, so the helper renames each committed file onto the contract
 * name and rewrites the identifying fields before emitting the event.
 */
async function toStorageContractChunk(
  kind: "microphone" | "system",
  binding: SourceBinding,
  event: LinuxChunkEvent,
): Promise<LinuxChunkEvent> {
  const frames = Math.floor((event.byteLength - LINUX_WAV_HEADER_BYTES) / 2);
  const startFrame = Math.round((event.logicalStartMs * event.sampleRate) / 1_000);
  binding.sequence += 1;
  const id = [
    "chunk", kind, String(binding.sequence).padStart(6, "0"), String(startFrame).padStart(12, "0"),
    String(frames).padStart(12, "0"), String(event.sampleRate), String(event.channels),
  ].join("--");
  const destination = path.join(path.dirname(event.path), `${id}.wav`);
  await rename(event.path, destination);
  return {
    ...event,
    id,
    path: destination,
    logicalStartMs: Math.floor((startFrame * 1_000) / event.sampleRate),
    durationMs: Math.max(1, Math.floor((frames * 1_000) / event.sampleRate)),
  };
}

async function commitChunkEvents(
  kind: "microphone" | "system",
  binding: SourceBinding,
  events: LinuxChunkEvent[],
): Promise<void> {
  for (const event of events) {
    emit({ event: "chunkCommitted", ...(await toStorageContractChunk(kind, binding, event)) });
  }
}

export async function runLinuxCaptureHelper(options: {
  args: string[];
  env?: NodeJS.ProcessEnv;
  spawnSource?: (kind: "microphone" | "system", device: string) => ChildProcessLike;
  nowMs?: () => number;
}): Promise<number> {
  const fixture = options.args.includes("--fixture") || options.env?.MEETLESS_CAPTURE_MODE === "fixture";
  const nowMs = options.nowMs ?? (() => performance.now());
  const spawnSource = options.spawnSource ?? ((_kind: "microphone" | "system", device: string) =>
    fixture ? spawnFixtureSource(LINUX_FIXTURE_TICK_MS, LINUX_FIXTURE_TICK_BYTES) : spawnParecSource(device));
  const clock = new LogicalClock();
  const sources = new Map<"microphone" | "system", SourceBinding>([
    ["microphone", { writer: null, child: null, loop: null, sequence: 0, carry: Buffer.alloc(0) }],
    ["system", { writer: null, child: null, loop: null, sequence: 0, carry: Buffer.alloc(0) }],
  ]);
  let recordingId = "";
  let stopped = false;

  const startSource = async (kind: "microphone" | "system", sessionDirectory: string): Promise<void> => {
    const binding = sources.get(kind)!;
    if (binding.child) return;
    binding.writer = new WavChunkWriter({ sessionDirectory, recordingId, source: kind });
    binding.sequence = 0;
    binding.carry = Buffer.alloc(0);
    const device = fixture ? "fixture" : await resolveParecDevice(kind);
    const child = spawnSource(kind, device);
    binding.child = child;
    binding.loop = (async () => {
      for await (const raw of child.stdout) {
        if (stopped) break;
        const bindingNow = sources.get(kind)!;
        const writer = bindingNow.writer;
        if (!writer) break;
        // Keep every committed payload a whole number of 16-bit mono samples.
        const combined = bindingNow.carry.length > 0
          ? Buffer.concat([bindingNow.carry, raw as Buffer])
          : raw as Buffer;
        const alignedBytes = combined.length - (combined.length % 2);
        bindingNow.carry = combined.subarray(alignedBytes);
        const events = await writer.append(combined.subarray(0, alignedBytes), clock.logicalMs(nowMs()));
        await commitChunkEvents(kind, bindingNow, events);
      }
      if (!stopped) {
        stopped = true;
        emit({ event: "captureFailed", error: `${kind} source ended before stop` }, () => { process.exit(1); });
      }
    })();
  };

  return await new Promise<number>((resolve) => {
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const command = parseLinuxHelperCommand(trimmed);
      if (!command) return;
      if (command.command === "start") {
        recordingId = `meetless-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const sessionDirectory = command.sessionDirectory ?? "";
        if (!sessionDirectory) { emit({ event: "error", error: "start requires sessionDirectory" }); return; }
        clock.start(nowMs());
        emit({ event: "started" });
        void startSource("microphone", sessionDirectory).catch((error: unknown) => {
          emit({ event: "captureFailed", error: `microphone source failed: ${String(error)}` });
        });
        void startSource("system", sessionDirectory).catch((error: unknown) => {
          emit({ event: "captureFailed", error: `system source failed: ${String(error)}` });
        });
        return;
      }
      if (command.command === "pause") { clock.pause(nowMs()); emit({ event: "paused" }); return; }
      if (command.command === "resume") { clock.resume(nowMs()); emit({ event: "resumed" }); return; }
      if (command.command === "stop") {
        stopped = true;
        void (async () => {
          for (const binding of sources.values()) binding.child?.kill("SIGTERM");
          for (const [kind, binding] of sources) {
            // The writer assumes a single consumer: let the read loop finish its
            // last append before flushing the trailing partial chunk.
            if (binding.loop) await binding.loop;
            if (binding.writer) await commitChunkEvents(kind, binding, await binding.writer.flush(clock.logicalMs(nowMs())));
          }
          emit({ event: "stopped" });
          // Release stdin so the process can exit once the parent stops reading.
          input.close();
          process.stdin.destroy();
          resolve(0);
        })();
        return;
      }
    });
    process.stdin.on("end", () => { if (!stopped) { stopped = true; resolve(0); } });
  });
}
