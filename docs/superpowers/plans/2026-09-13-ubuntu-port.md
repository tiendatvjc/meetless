# Meetless Ubuntu Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chạy vòng lặp sản phẩm Meetless V1 (ghi âm PipeWire → ffmpeg finalize → transcript BYOK → web companion → MCP chat) trên Ubuntu 24.04+, headless + web.

**Architecture:** Giữ nguyên分层 runtime/plugin/store của upstream; thay 3 lớp macOS-specific bằng tương đương Linux: (1) capture helper Node nói đúng giao thức JSON-lines hiện có, spawn `parec` cho mic + sink-monitor; (2) đường dẫn config theo XDG-style `~/.local/share/meetless`; (3) transcription route thêm BYOK (key người dùng, không qua premium). Readiness thay attestation codesign bằng kiểm tra sha256 install-time. systemd user service thay LaunchServices/MeetlessHost.

**Tech Stack:** TypeScript (monorepo npm workspaces hiện có), vitest, Node 20+, PipeWire + pulseaudio-utils (`parec`, `pactl`), ffmpeg, Expo web (hiện có), systemd user units.

**Spec:** `docs/superpowers/specs/2026-09-13-ubuntu-port-design.md`

## Global Constraints

- Chỉ tạo/sửa trong `packages/`, `scripts/`, `docs/`, `package.json` ở repo chính — **không sửa** `vendor/paseo/**` hay `native/**` (macOS giữ nguyên).
- Mọi hành vi mới phải có test vitest pass bằng `npx vitest run --config vitest.config.ts <path>`; không chạy `npm test` (pretest gọi `build:native` swift).
- Chunk WAV: 16.000 Hz, 1 kênh, PCM s16le, header 44 bytes, sha256 toàn file — đúng `HelperEventSchema` trong `packages/meetless-plugin/src/capture-helper.ts:7-21`.
- Event helper: JSON một dòng trên stdout, strict schema version 1; command stdin: `{"version":1,"command":"start"|"pause"|"resume"|"stop",...}` (xem `capture-helper.ts:96-113`).
- Không bao giờ đọc/ghi `~/Documents/meetings` trong test — dùng thư mục tạm.
- Tiếng Việt cho prose docs mới; identifier/code tiếng Anh theo chuẩn repo.
- Commit mỗi task, nhánh `linux-port`, không push force.
- Key BYOK lưu `~/.local/share/meetless/byok-openai.json` mode 0600, schema `{"version":1,"apiKey":"sk-..."}` — không log key, không đưa key vào renderer state (ADR0003).

---

### Task 1: Đường dẫn config cho Linux

**Files:**
- Modify: `packages/runtime/src/config.ts:37-38` (hằng số `MEETLESS_USER_SUPPORT_RELATIVE_PATH`, `MEETLESS_RECORDING_EXPORTS_RELATIVE_PATH`)
- Test: `packages/runtime/test/linux-support-paths.test.ts`

**Interfaces:**
- Produces: `platformUserSupportRelativePath(platform: NodeJS.Platform): string` và `platformRecordingExportsRelativePath(platform: NodeJS.Platform): string` (export từ `config.ts`). Trên `darwin` trả giá trị hiện tại; trên `linux` trả `"meetless"` (được ghép với data root) và `"Documents/meetings"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  platformRecordingExportsRelativePath,
  platformUserSupportRelativePath,
} from "../src/config.js";

describe("platform support paths", () => {
  it("darwin keeps the macOS Application Support contract", () => {
    expect(platformUserSupportRelativePath("darwin")).toBe("Library/Application Support/Meetless");
    expect(platformRecordingExportsRelativePath("darwin")).toBe("Documents/meetings");
  });

  it("linux uses the XDG-style support root and keeps the exports contract", () => {
    expect(platformUserSupportRelativePath("linux")).toBe(".local/share/meetless");
    expect(platformRecordingExportsRelativePath("linux")).toBe("Documents/meetings");
  });

  it("rejects unsupported platforms loudly", () => {
    expect(() => platformUserSupportRelativePath("win32")).toThrow(/unsupported platform/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/runtime && npx vitest run test/linux-support-paths.test.ts`
Expected: FAIL — import lỗi "does not provide an export named 'platformUserSupportRelativePath'".

- [ ] **Step 3: Write minimal implementation**

Trong `config.ts`, ngay trên hai hằng số hiện tại (dòng 37-38), thêm và đổi chỗ-dùng (tìm mọi reference bằng `rg -n "MEETLESS_USER_SUPPORT_RELATIVE_PATH|MEETLESS_RECORDING_EXPORTS_RELATIVE_PATH" packages/`):

```ts
export function platformUserSupportRelativePath(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "Library/Application Support/Meetless";
  if (platform === "linux") return ".local/share/meetless";
  throw new Error(`unsupported Meetless platform: ${platform}`);
}

export function platformRecordingExportsRelativePath(platform: NodeJS.Platform): string {
  if (platform === "darwin" || platform === "linux") return "Documents/meetings";
  throw new Error(`unsupported Meetless platform: ${platform}`);
}

/** Kept for the packaged macOS runtime; Linux resolves through the functions above. */
export const MEETLESS_USER_SUPPORT_RELATIVE_PATH = platformUserSupportRelativePath("darwin");
export const MEETLESS_RECORDING_EXPORTS_RELATIVE_PATH = platformRecordingExportsRelativePath("darwin");
```

Tại mọi chỗ resolve runtimeRoot theo user home (tìm `rg -n "MEETLESS_USER_SUPPORT_RELATIVE_PATH" packages/runtime/src`), thay bằng `path.join(userHome, platformUserSupportRelativePath(process.platform))`. Nếu một call-site chỉ hợp trên macOS (ví dụ container MAS dòng 53-57), giữ nguyên.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/runtime && npx vitest run test/linux-support-paths.test.ts`
Expected: PASS 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/config.ts packages/runtime/test/linux-support-paths.test.ts
git commit -m "linux-port: platform-aware support and export paths"
```

---

### Task 2: Đọc argv process qua /proc cho Linux

**Files:**
- Modify: `packages/runtime/src/readiness.ts` (vùng ném lỗi `process.platform !== "darwin"` tại dòng ~916)
- Test: `packages/runtime/test/linux-proc-argv.test.ts`

**Interfaces:**
- Produces: `parseProcCmdline(buffer: Buffer): string[]` (export từ `readiness.ts`) và `readProcessArgv(pid: number): Promise<string[]>` — trên linux đọc `/proc/<pid>/cmdline` (split `\0`, bỏ rỗng), trên darwin giữ hành vi hiện tại.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProcCmdline } from "../src/readiness.js";

describe("parseProcCmdline", () => {
  it("splits NUL-separated argv and drops the trailing empty entry", () => {
    const raw = Buffer.from("node\0/home/x/dist/cli.js\0daemon\0\0", "utf8");
    expect(parseProcCmdline(raw)).toEqual(["node", "/home/x/dist/cli.js", "daemon"]);
  });

  it("returns an empty vector for an empty buffer", () => {
    expect(parseProcCmdline(Buffer.alloc(0))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/runtime && npx vitest run test/linux-proc-argv.test.ts`
Expected: FAIL — no export `parseProcCmdline`.

- [ ] **Step 3: Write minimal implementation**

Trong `readiness.ts`, thêm gần hàm inspect argv hiện tại (đoạn `if (process.platform !== "darwin") throw ...`):

```ts
export function parseProcCmdline(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter((entry) => entry.length > 0);
}

async function readLinuxProcessArgv(pid: number): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  return parseProcCmdline(await readFile(`/proc/${pid}/cmdline`));
}
```

Đổi hàm inspect argv hiện tại (tìm bằng `rg -n "meetless-process-argv|inspectNativeArgumentVector" packages/runtime/src/readiness.ts`): đầu hàm thêm

```ts
if (process.platform === "linux") return readLinuxProcessArgv(pid);
if (process.platform !== "darwin") throw new Error(`native argv inspection requires macOS or Linux, received ${process.platform}`);
```

giữ phần darwin nguyên vẹn.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/runtime && npx vitest run test/linux-proc-argv.test.ts`
Expected: PASS 2 tests. Chạy thêm `npx vitest run test/lifecycle.test.ts` để chắc không vỡ hành vi darwin hiện có (pass như trước).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/readiness.ts packages/runtime/test/linux-proc-argv.test.ts
git commit -m "linux-port: inspect process argv through /proc on linux"
```

---

### Task 3: Logical clock cho helper capture Linux

**Files:**
- Create: `packages/meetless-plugin/src/linux/logical-clock.ts`
- Test: `packages/meetless-plugin/test/linux/logical-clock.test.ts`

**Interfaces:**
- Produces: `class LogicalClock { start(nowMs?: number): void; pause(nowMs?: number): void; resume(nowMs?: number): void; logicalMs(nowMs?: number): number }` — thời gian ghi thực, không tính thời gian pause; dùng `performance.now()` mặc định.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { LogicalClock } from "../../src/linux/logical-clock.js";

describe("LogicalClock", () => {
  it("accumulates only while recording", () => {
    const clock = new LogicalClock();
    clock.start(0);
    expect(clock.logicalMs(1_000)).toBe(1_000);
    clock.pause(1_000);
    expect(clock.logicalMs(9_000)).toBe(1_000);
    clock.resume(9_000);
    expect(clock.logicalMs(10_000)).toBe(2_000);
  });

  it("is zero before start and unchanged by double pause", () => {
    const clock = new LogicalClock();
    expect(clock.logicalMs(5)).toBe(0);
    clock.start(0);
    clock.pause(100);
    clock.pause(200);
    expect(clock.logicalMs(300)).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/meetless-plugin && npx vitest run test/linux/logical-clock.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
const now = (): number => performance.now();

/** Recording-logical elapsed time: pauses do not advance the clock. */
export class LogicalClock {
  private accumulatedMs = 0;
  private lastResumeMs: number | null = null;
  private running = false;

  start(nowMs: number = now()): void {
    this.accumulatedMs = 0;
    this.lastResumeMs = nowMs;
    this.running = true;
  }

  pause(nowMs: number = now()): void {
    if (!this.running) return;
    this.accumulatedMs += nowMs - (this.lastResumeMs ?? nowMs);
    this.running = false;
    this.lastResumeMs = null;
  }

  resume(nowMs: number = now()): void {
    if (this.running) return;
    this.lastResumeMs = nowMs;
    this.running = true;
  }

  logicalMs(nowMs: number = now()): number {
    const live = this.running ? nowMs - (this.lastResumeMs ?? nowMs) : 0;
    return Math.max(0, Math.round(this.accumulatedMs + live));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/meetless-plugin && npx vitest run test/linux/logical-clock.test.ts`
Expected: PASS 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/meetless-plugin/src/linux/logical-clock.ts packages/meetless-plugin/test/linux/logical-clock.test.ts
git commit -m "linux-port: logical recording clock for the linux capture helper"
```

---

### Task 4: WAV chunk writer theo giao thức helper

**Files:**
- Create: `packages/meetless-plugin/src/linux/wav-chunk-writer.ts`
- Test: `packages/meetless-plugin/test/linux/wav-chunk-writer.test.ts`

**Interfaces:**
- Consumes: `LogicalClock` (Task 3).
- Produces: `interface LinuxChunkEvent { id: string; source: "microphone" | "system"; path: string; byteLength: number; sha256: string; logicalStartMs: number; durationMs: number; sampleRate: 16000; channels: 1; format: "wav" }`; `class WavChunkWriter { constructor(options: { sessionDirectory: string; recordingId: string; source: "microphone" | "system"; chunkPayloadBytes?: number }); append(pcm: Buffer, logicalNowMs: number): Promise<LinuxChunkEvent[]>; flush(logicalNowMs: number): Promise<LinuxChunkEvent[]> }`. Mặc định `chunkPayloadBytes = 960_000` (30s × 32.000 B/s). Mỗi chunk: file `<sessionDirectory>/<recordingId>-<source>-<seq:4>.wav` ghi bằng rename atomic từ `.stage`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/meetless-plugin && npx vitest run test/linux/wav-chunk-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/meetless-plugin && npx vitest run test/linux/wav-chunk-writer.test.ts`
Expected: PASS 2 tests. Chạy thêm `npx vitest run test/capture-helper.test.ts` (nếu tồn tại; nếu không: `npx vitest run` toàn package) — không test nào vỡ.

- [ ] **Step 5: Commit**

```bash
git add packages/meetless-plugin/src/linux/wav-chunk-writer.ts packages/meetless-plugin/test/linux/wav-chunk-writer.test.ts
git commit -m "linux-port: wav chunk writer matching the helper commit contract"
```

---

### Task 5: Helper capture Linux (giao thức stdin/stdout + nguồn parec + fixture)

**Files:**
- Create: `packages/meetless-plugin/src/linux/capture-helper-linux.ts`
- Create: `packages/meetless-plugin/src/linux/capture-helper-entry.ts`
- Test: `packages/meetless-plugin/test/linux/capture-helper-linux.test.ts`

**Interfaces:**
- Consumes: `WavChunkWriter`, `LinuxChunkEvent` (Task 4), `LogicalClock` (Task 3).
- Produces: `runLinuxCaptureHelper(options: { args: string[]; env?: NodeJS.ProcessEnv; spawnSource?: (device: string) => ChildProcessLike }): Promise<number>` — trả exit code; `interface ChildProcessLike { stdout: Readable; kill(signal?: string): void }`. Entry `capture-helper-entry.ts` là điểm `node dist/.../capture-helper-entry.js [--fixture]`. Nguồn thật: `resolveParecDevice(kind, run)` với `kind: "microphone" | "system"`; microphone = `pactl get-default-source`, system = `<pactl get-default-sink>.monitor`; spawn `parec --format=s16le --rate=16000 --channels=1 --device=<device>` (raw PCM ra stdout). Fixture: mỗi 1.000ms push 4.000 bytes silence (2s mỗi lần tick 2s cho test nhanh — hằng số `LINUX_FIXTURE_TICK_MS = 2_000`, `LINUX_FIXTURE_TICK_BYTES = 64_000`).

- [ ] **Step 1: Write the failing test**

Test bọc helper trong class `CaptureHelper` HIỆN CÓ (không đổi) qua entry fixture — đây là bằng chứng helper nói đúng giao thức. Kèm test unit cho parser command:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLinuxHelperCommand } from "../../src/linux/capture-helper-linux.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const entry = path.join(repoRoot, "packages/meetless-plugin/dist/linux/capture-helper-entry.js");

let sessionDirectory: string;

beforeAll(async () => {
  sessionDirectory = await mkdtemp(path.join(tmpdir(), "meetless-linux-helper-"));
});
afterAll(async () => {
  await rm(sessionDirectory, { recursive: true, force: true });
});

describe("parseLinuxHelperCommand", () => {
  it("parses start with a session directory and elapsed offset", () => {
    expect(parseLinuxHelperCommand('{"version":1,"command":"start","sessionDirectory":"/tmp/s","elapsedMs":250}\n')).toEqual({
      version: 1, command: "start", sessionDirectory: "/tmp/s", elapsedMs: 250,
    });
  });

  it("returns null for partial lines and non-json lines", () => {
    expect(parseLinuxHelperCommand('{"version":1,"comm')).toBeNull();
    expect(parseLinuxHelperCommand("not json\n")).toBeNull();
  });
});

describe("linux capture helper entry (fixture mode)", () => {
  it("speaks the helper line protocol end to end through CaptureHelper", async () => {
    const { CaptureHelper } = await import("../../src/capture-helper.js");
    const chunks: unknown[] = [];
    let failure: string | null = null;
    const helper = new CaptureHelper({
      executable: process.execPath,
      arguments: [entry, "--fixture"],
      sessionDirectory,
      storeRoot: path.dirname(sessionDirectory),
      fixture: true,
      onChunk: async (chunk) => { chunks.push(chunk); },
      onFailure: async (reason) => { failure = reason; },
    });
    await helper.start();
    await new Promise((resolve) => setTimeout(resolve, 4_500)); // > 2 fixture ticks
    await helper.pause();
    await helper.resume(9_000);
    await helper.stop();
    expect(failure).toBeNull();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const sources = new Set(chunks.map((chunk) => (chunk as { source: string }).source));
    expect(sources.has("microphone")).toBe(true);
    expect(sources.has("system")).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/meetless-plugin && npx vitest run test/linux/capture-helper-linux.test.ts`
Expected: FAIL — module not found (chưa có `capture-helper-linux.ts`).

- [ ] **Step 3: Write minimal implementation**

`capture-helper-linux.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { LogicalClock } from "./logical-clock.js";
import { LINUX_CHUNK_BYTES_PER_SECOND, WavChunkWriter, type LinuxChunkEvent } from "./wav-chunk-writer.js";

export const LINUX_FIXTURE_TICK_MS = 2_000;
export const LINUX_FIXTURE_TICK_BYTES = 64_000;

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

interface SourceBinding {
  writer: WavChunkWriter | null;
  child: ChildProcessLike | null;
  buffer: Buffer;
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
  const { promisify } = await import("node:util");
  const execFileAsync = promisify((await import("node:child_process")).execFile);
  const { stdout } = await execFileAsync(command, args);
  return stdout;
}

export function spawnParecSource(device: string): ChildProcessLike {
  const child: ChildProcess = spawn("parec", [
    "--format=s16le", "--rate=16000", "--channels=1", `--device=${device}`,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  return { stdout: child.stdout!, kill: (signal?: string) => child.kill(signal as never) };
}

export function spawnFixtureSource(tickMs: number, tickBytes: number): ChildProcessLike & { stop(): void } {
  const output = new Readable({ read() { /* pushed by timer */ } });
  const silence = Buffer.alloc(tickBytes);
  const timer = setInterval(() => { output.push(silence); }, tickMs);
  const stop = () => { clearInterval(timer); output.push(null); };
  return { stdout: output, kill: () => stop(), stop };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ version: 1, ...event })}\n`);
}

export async function runLinuxCaptureHelper(options: {
  args: string[];
  env?: NodeJS.ProcessEnv;
  spawnSource?: (kind: "microphone" | "system", device: string) => ChildProcessLike;
  nowMs?: () => number;
}): Promise<number> {
  const fixture = options.args.includes("--fixture") || options.env?.MEETLESS_CAPTURE_MODE === "fixture";
  const nowMs = options.nowMs ?? (() => performance.now());
  const spawnSource = options.spawnSource ?? ((kind, device) =>
    fixture ? spawnFixtureSource(LINUX_FIXTURE_TICK_MS, LINUX_FIXTURE_TICK_BYTES) : spawnParecSource(device));
  const clock = new LogicalClock();
  const sources = new Map<"microphone" | "system", SourceBinding>([
    ["microphone", { writer: null, child: null, buffer: Buffer.alloc(0) }],
    ["system", { writer: null, child: null, buffer: Buffer.alloc(0) }],
  ]);
  let recordingId = "";
  let stopped = false;

  const commitEvents = async (binding: SourceBinding, events: LinuxChunkEvent[]): Promise<void> => {
    for (const event of events) emit({ event: "chunkCommitted", ...event });
  };

  const startSource = async (kind: "microphone" | "system", sessionDirectory: string): Promise<void> => {
    const binding = sources.get(kind)!;
    if (binding.child) return;
    binding.writer = new WavChunkWriter({ sessionDirectory, recordingId, source: kind });
    binding.buffer = Buffer.alloc(0);
    const device = fixture ? "fixture" : await resolveParecDevice(kind);
    const child = spawnSource(kind, device);
    binding.child = child;
    for await (const raw of child.stdout) {
      if (stopped) break;
      const bindingNow = sources.get(kind)!;
      if (!bindingNow.writer) break;
      await commitEvents(bindingNow, await bindingNow.writer.append(raw as Buffer, clock.logicalMs(nowMs())));
    }
    if (!stopped) {
      stopped = true;
      emit({ event: "captureFailed", error: `${kind} source ended before stop` });
      process.exit(1);
    }
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
          for (const [kind, binding] of sources) {
            binding.child?.kill("SIGTERM");
            if (binding.writer) await commitEvents(binding, await binding.writer.flush(clock.logicalMs(nowMs())));
            void kind;
          }
          emit({ event: "stopped" });
          resolve(0);
        })();
        return;
      }
    });
    process.stdin.on("end", () => { if (!stopped) { stopped = true; resolve(0); } });
  });
}
```

`capture-helper-entry.ts`:

```ts
import { runLinuxCaptureHelper } from "./capture-helper-linux.js";

process.exitCode = await runLinuxCaptureHelper({ args: process.argv.slice(2) });
```

Thêm vào `packages/meetless-plugin/package.json` → `scripts.build` (giữ lệnh tsc hiện có, chỉ chắc chắn dist có file mới — không cần đổi nếu build đã là `tsc -p .`). Build trước khi test: `cd packages/meetless-plugin && npm run build`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/meetless-plugin && npm run build && npx vitest run test/linux/capture-helper-linux.test.ts`
Expected: PASS (parser 2 tests + e2e fixture 1 test, ≥2 chunks, đủ 2 nguồn, không failure).

- [ ] **Step 5: Commit**

```bash
git add packages/meetless-plugin/src/linux packages/meetless-plugin/test/linux/capture-helper-linux.test.ts
git commit -m "linux-port: pipeWire capture helper speaking the existing line protocol"
```

---

### Task 6: BYOK OpenAI transcription provider + route precedence

**Files:**
- Create: `packages/meetless-plugin/src/openai-byok-provider.ts`
- Modify: `packages/meetless-plugin/src/transcription-route.ts` (mở rộng route union + chọn route)
- Test: `packages/meetless-plugin/test/openai-byok-provider.test.ts`

**Interfaces:**
- Consumes: `TranscriptionProvider`, `TranscriptionRequest`, `TranscriptionResult`, `OPENAI_TRANSCRIPTION_ENDPOINT`, `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_TRANSCRIPTION_LANGUAGES` từ `transcription-provider.ts`.
- Produces: `interface ByokKeyFile { version: 1; apiKey: string }`; `readByokKey(configPath: string, readFile?: (p: string) => Promise<string>): Promise<string | null>` (trim; trả null khi thiếu/invalid — không throw); `class OpenAiByokTranscriptionProvider implements TranscriptionProvider` với `constructor(options: { configPath: string; fetchImpl?: typeof fetch })`; `status()` → configured/missing theo key; `transcribe(request)` → POST multipart (`file`, `model=gpt-transcribe`, `response_format=json`), trả `{ text, detectedLanguages, usage: null }`; lỗi 401 → status invalid.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  OpenAiByokTranscriptionProvider,
  readByokKey,
} from "../src/openai-byok-provider.js";

describe("readByokKey", () => {
  it("returns the trimmed key from a v1 file", async () => {
    const read = async () => '{"version":1,"apiKey":"  sk-test  "}\n';
    expect(await readByokKey("/x/byok.json", read)).toBe("sk-test");
  });

  it("returns null for missing, malformed, or empty keys without throwing", async () => {
    const missing = async () => { throw new Error("ENOENT"); };
    expect(await readByokKey("/x/byok.json", missing)).toBeNull();
    const malformed = async () => "not json";
    expect(await readByokKey("/x/byok.json", malformed)).toBeNull();
    const empty = async () => '{"version":1,"apiKey":"  "}';
    expect(await readByokKey("/x/byok.json", empty)).toBeNull();
  });
});

describe("OpenAiByokTranscriptionProvider", () => {
  it("reports missing when no key is configured", async () => {
    const provider = new OpenAiByokTranscriptionProvider({
      configPath: "/x/byok.json",
      fetchImpl: (() => { throw new Error("must not fetch"); }) as typeof fetch,
    });
    expect(await provider.status()).toBe("missing");
  });

  it("transcribes through the gpt-transcribe endpoint with the user key", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)["authorization"]);
      return new Response(JSON.stringify({ text: "xin chào thế giới" }), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAiByokTranscriptionProvider({ configPath: "/x/byok.json", fetchImpl });
    const read = async () => '{"version":1,"apiKey":"sk-test"}';
    // inject the key file reader the same way readByokKey does
    (provider as unknown as { keyReader: () => Promise<string | null> }).keyReader = () => read();
    const result = await provider.transcribe({
      recordingId: "r1",
      audioPath: "/x/a.wav",
      audioIdentity: { sha256: "a", byteLength: 1 } as never,
      range: { ordinal: 0, startMs: 0, endMs: 1_000 },
    });
    expect(result.text).toBe("xin chào thế giới");
    expect(seenUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seenAuth).toBe("Bearer sk-test");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/meetless-plugin && npx vitest run test/openai-byok-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
import { readFile } from "node:fs/promises";
import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResult } from "./transcription-provider.js";
import {
  OPENAI_TRANSCRIPTION_ENDPOINT,
  OPENAI_TRANSCRIPTION_MODEL,
  OPENAI_TRANSCRIPTION_LANGUAGES,
} from "./transcription-provider.js";

export interface ByokKeyFile { version: 1; apiKey: string }

export async function readByokKey(
  configPath: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string | null> {
  let raw: string;
  try {
    raw = await read(configPath);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ByokKeyFile>;
    if (parsed.version !== 1 || typeof parsed.apiKey !== "string") return null;
    const key = parsed.apiKey.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export class OpenAiByokTranscriptionProvider implements TranscriptionProvider {
  private keyReader: () => Promise<string | null>;

  constructor(private readonly options: { configPath: string; fetchImpl?: typeof fetch }) {
    this.keyReader = () => readByokKey(this.options.configPath);
  }

  private async key(): Promise<string | null> { return this.keyReader(); }

  async status(): Promise<"configured" | "missing" | "invalid"> {
    const key = await this.key();
    return key ? "configured" : "missing";
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const key = await this.key();
    if (!key) throw new Error("BYOK transcription is not configured: missing API key");
    const body = new FormData();
    body.append("file", new Blob([await readFile(request.audioPath)], { type: "audio/wav" }), "audio.wav");
    body.append("model", OPENAI_TRANSCRIPTION_MODEL);
    body.append("response_format", "json");
    const response = await (this.options.fetchImpl ?? fetch)(OPENAI_TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body,
    });
    if (response.status === 401) throw new Error("BYOK transcription rejected the configured API key");
    if (!response.ok) throw new Error(`BYOK transcription failed with HTTP ${response.status}`);
    const payload = (await response.json()) as { text?: string };
    const text = (payload.text ?? "").trim();
    if (!text) throw new Error("BYOK transcription returned empty text");
    return { text, detectedLanguages: [...OPENAI_TRANSCRIPTION_LANGUAGES], usage: null };
  }
}
```

Sau đó trong `transcription-route.ts`: tìm type có `readonly route: "managed"` (dòng ~23) và mọi chỗ khởi tạo route; mở rộng union thành `"managed" | "byok"` và thêm nhánh chọn theo monetization doc (BYOK configured → byok, không đụng premium; else giữ logic managed hiện tại nguyên vẹn). Vị trí chèn: đọc hàm dispatch quanh dòng 106-130 (`rg -n "route" packages/meetless-plugin/src/transcription-route.ts`); nhánh mới:

```ts
const byokProvider = new OpenAiByokTranscriptionProvider({ configPath: byokConfigPath });
if ((await byokProvider.status()) === "configured") {
  return { route: "byok" as const, provider: byokProvider, consent };
}
```

với `byokConfigPath` truyền từ config runtime (`~/.local/share/meetless/byok-openai.json` — cùng helper path của Task 1). Nếu cấu trúc hàm không cho phép trả trực tiếp, thêm thành nhánh đầu của selector hiện có và giữ nguyên mọi return path cũ.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/meetless-plugin && npx vitest run test/openai-byok-provider.test.ts && npx vitest run test 2>&1 | tail -5`
Expected: PASS test mới; toàn bộ test hiện có của package vẫn pass (route mặc định khi không có BYOK file = managed, giống trước).

- [ ] **Step 5: Commit**

```bash
git add packages/meetless-plugin/src/openai-byok-provider.ts packages/meetless-plugin/src/transcription-route.ts packages/meetless-plugin/test/openai-byok-provider.test.ts
git commit -m "linux-port: BYOK OpenAI transcription route with managed precedence preserved"
```

---

### Task 7: Premium no-op trên Linux + guard managed route

**Files:**
- Create: `packages/meetless-plugin/src/linux-premium-access.ts`
- Test: `packages/meetless-plugin/test/linux-premium-access.test.ts`

**Interfaces:**
- Consumes: `PREMIUM_ENTITLEMENT` từ `premium-service.ts`.
- Produces: `class LinuxNoopPremiumAccess implements TranscriptionPremiumAccess` (type import từ `transcription-route.ts`; nếu tên khác, `rg -n "interface.*PremiumAccess" packages/meetless-plugin/src`) — mọi lượt gọi trả inactive; `purchase`/`restore` throw lỗi tiếng Việt hướng dẫn: "Linux không hỗ trợ RevenueCat; dùng BYOK key hoặc macOS host cho managed transcription."

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { LinuxNoopPremiumAccess } from "../src/linux-premium-access.js";

describe("LinuxNoopPremiumAccess", () => {
  it("is always inactive and never throws on status", async () => {
    const access = new LinuxNoopPremiumAccess();
    expect(await access.status()).toEqual({ active: false, reason: "linux-noop" });
  });

  it("rejects purchase and restore with a BYOK pointer", async () => {
    const access = new LinuxNoopPremiumAccess();
    await expect(access.purchase()).rejects.toThrow(/BYOK/i);
    await expect(access.restore()).rejects.toThrow(/BYOK/i);
  });
});
```

(Chỉnh tên method `status/purchase/restore` khớp interface thật tìm được qua `rg` trên — giữ nguyên assertion `active: false` và message chứa `BYOK`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/meetless-plugin && npx vitest run test/linux-premium-access.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Linux has no RevenueCat SDK. Premium is permanently inactive here; managed
 * transcription must go through a macOS host or a self-hosted Convex deploy,
 * while BYOK transcription stays free per docs/product/monetization.md.
 */
export class LinuxNoopPremiumAccess {
  async status(): Promise<{ active: false; reason: "linux-noop" }> {
    return { active: false, reason: "linux-noop" };
  }

  async purchase(): Promise<never> {
    throw new Error("Linux không hỗ trợ RevenueCat Premium. Dùng BYOK OpenAI key (byok-openai.json) hoặc macOS host cho managed transcription.");
  }

  async restore(): Promise<never> {
    throw new Error("Linux không hỗ trợ RevenueCat Premium. Dùng BYOK OpenAI key (byok-openai.json) hoặc macOS host cho managed transcription.");
  }
}
```

Wire: tại nơi `premium-service` được khởi tạo theo platform (`rg -n "PremiumService|new .*Premium" packages/meetless-plugin/src packages/runtime/src`), thêm nhánh `process.platform === "linux"` dùng `LinuxNoopPremiumAccess`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/meetless-plugin && npx vitest run test/linux-premium-access.test.ts`
Expected: PASS 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/meetless-plugin/src/linux-premium-access.ts packages/meetless-plugin/test/linux-premium-access.test.ts
git commit -m "linux-port: premium no-op access keeping BYOK free"
```

---

### Task 8: build:native Linux + installer systemd + tài liệu

**Files:**
- Modify: `scripts/build-native.mjs` (nhánh linux bỏ swift)
- Create: `scripts/install-linux-host.mjs`
- Create: `systemd/meetless-daemon.service`
- Create: `docs/linux-development.md`
- Modify: `package.json` (script `host:linux:install`, `runtime:linux:status`)

**Interfaces:**
- Consumes: Task 1 paths (`~/.local/share/meetless`), Task 5 entry dist.
- Produces: `npm run host:linux:install` — build TS, verify `ffmpeg`/`parec`/`pactl` trong PATH (thiếu thì in lệnh apt và exit 1), ghi unit file, `systemctl --user daemon-reload && systemctl --user enable --now meetless-daemon`.

- [ ] **Step 1: Viết nhánh build-native**

Trong `scripts/build-native.mjs`, đầu file thêm:

```js
if (process.platform === "linux") {
  const { promisify } = await import("node:util");
  const { execFile } = await import("node:child_process");
  const run = promisify(execFile);
  for (const tool of ["ffmpeg", "parec", "pactl"]) {
    try {
      await run("which", [tool]);
    } catch {
      console.error(`Thiếu ${tool}. Cài: sudo apt install ${tool === "ffmpeg" ? "ffmpeg" : "pipewire-audio-utils"}`);
      process.exit(1);
    }
  }
  console.log("linux native prerequisites present (ffmpeg, parec, pactl)");
  process.exit(0);
}
```

(`parec`/`pactl` nằm trong gói `pipewire-audio-utils` trên Ubuntu 24.04.)

- [ ] **Step 2: Viết installer + unit**

`systemd/meetless-daemon.service`:

```ini
[Unit]
Description=Meetless meeting recorder daemon (linux-port)
Documentation=file://%h/.local/share/meetless/docs/linux-development.md

[Service]
Type=simple
Environment=MEETLESS_RUNTIME_ROOT=%h/.local/share/meetless
Environment=MEETLESS_LISTEN=127.0.0.1:8081
ExecStart=/usr/bin/env node %h/.local/share/meetless/runtime/cli.js daemon
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`scripts/install-linux-host.mjs` (khung chính — build, sao chép dist runtime + plugin entry vào `~/.local/share/meetless/runtime/`, render unit với đường dẫn thật, enable service, in URL web companion):

```js
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportRoot = path.join(homedir(), ".local/share/meetless");
const runtimeRoot = path.join(supportRoot, "runtime");

await run("npm", ["run", "build:meetless"], { cwd: repositoryRoot });
await mkdir(runtimeRoot, { recursive: true });
await copyFile(
  path.join(repositoryRoot, "packages/runtime/dist/cli.js"),
  path.join(runtimeRoot, "cli.js"),
);
await copyFile(
  path.join(repositoryRoot, "packages/meetless-plugin/dist/linux/capture-helper-entry.js"),
  path.join(runtimeRoot, "capture-helper-entry.js"),
);
const unit = (await readFile(path.join(repositoryRoot, "systemd/meetless-daemon.service"), "utf8"))
  .replace("%h/.local/share/meetless/runtime/cli.js", path.join(runtimeRoot, "cli.js"));
const unitPath = path.join(homedir(), ".config/systemd/user/meetless-daemon.service");
await mkdir(path.dirname(unitPath), { recursive: true });
await writeFile(unitPath, unit, { mode: 0o644 });
await run("systemctl", ["--user", "daemon-reload"]);
await run("systemctl", ["--user", "enable", "--now", "meetless-daemon.service"]);
console.log(`meetless daemon: systemctl --user status meetless-daemon`);
console.log(`web companion: npm run runtime:web (http://localhost:8082)`);
```

Thêm scripts vào `package.json`:

```json
"host:linux:install": "node scripts/install-linux-host.mjs",
"runtime:linux:status": "systemctl --user status meetless-daemon --no-pager || true"
```

- [ ] **Step 3: Viết docs `docs/linux-development.md`**

Nội dung: prerequisites (Ubuntu 24.04+, Node 20+, `sudo apt install ffmpeg pipewire-audio-utils`), các bước install/run/stop, cấu hình BYOK (`~/.local/share/meetless/byok-openai.json`), chạy web companion + pairing LAN, smoke test thật (`pw-play` một file wav trong khi record rồi kiểm tra `~/Documents/meetings/*.mp3`), khác biệt so với macOS (không RevenueCat/attestation, xem spec A1–A4).

- [ ] **Step 4: Verify trên máy thật**

Run: `node scripts/build-native.mjs && npm run build:paseo:types && npm run build:meetless && node scripts/install-linux-host.mjs && sleep 2 && npm run runtime:linux:status`
Expected: service active (running); `journalctl --user -u meetless-daemon -n 20` không có stack trace.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-native.mjs scripts/install-linux-host.mjs systemd docs/linux-development.md package.json
git commit -m "linux-port: systemd host install path and linux build prerequisites"
```

---

### Task 9: Proof end-to-end + hoàn thiện

**Files:**
- Create: `scripts/prove-linux-port.mjs`
- Modify: `package.json` (`proof:linux`)

**Interfaces:**
- Consumes: Task 5 helper (fixture), Task 6 BYOK provider (fixture injection qua env `MEETLESS_PROOF_BYOK=fixture` — provider test hook), finalizer ffmpeg hiện có, MCP server trong chat-service hiện có.

- [ ] **Step 1: Viết proof script theo văn hóa evidence của repo**

`scripts/prove-linux-port.mjs` thực hiện tuần tự và in manifest JSON bằng chứng:
1. Spawn entry helper fixture qua `CaptureHelper` (giữ logic giống test Task 5), ghi ~6s → stop.
2. Gọi finalizer hiện có (`finalizer.ts`, ffmpeg) trên các chunks → kiểm tra MP3 + WAV tồn tại trong thư mục tạm, đọc được bằng `ffprobe`.
3. Gọi `OpenAiByokTranscriptionProvider` với `fetchImpl` fake trả text cố định → transcript ≥1 segment.
4. Đánh giá MCP: khởi động `startTranscriptMcp` (nếu cần meeting store fixture tối thiểu) → `tools/list` chứa `search_meeting_transcript` + `get_meeting_segments`.
5. In manifest: `{ stage, ok, artifact, sha256 }` cho từng bước; exit 1 nếu bất kỳ bước nào fail.

Thêm script: `"proof:linux": "npm run build:meetless && node scripts/prove-linux-port.mjs"`.

- [ ] **Step 2: Chạy proof**

Run: `npm run proof:linux`
Expected: manifest in ra với mọi `ok: true`; exit 0.

- [ ] **Step 3: Chạy toàn bộ validation**

Run: `npm run build:paseo:types && npx tsc -b tsconfig.build.json --pretty false && npx vitest run --config vitest.config.ts 2>&1 | tail -8`
Expected: typecheck sạch; vitest pass toàn bộ (bao gồm test linux mới + test gốc; các test mac-specific packaged phải vẫn pass vì code darwin không đổi).

- [ ] **Step 4: Smoke thật (thủ công, ghi lại bằng chứng vào docs/linux-development.md)**

Phát audio test trong khi record: `pw-play /usr/share/sounds/alsa/Front_Left.wav` (lặp vài lần bằng vòng `for i in 1 2 3`), record qua web companion hoặc runtime CLI, stop, kiểm tra `ls -la ~/Documents/meetings/*.mp3` và nghe lại. Ghi kết quả + ngày vào `docs/linux-development.md` mục "Verified on".

- [ ] **Step 5: Commit + push**

```bash
git add scripts/prove-linux-port.mjs package.json docs/linux-development.md
git commit -m "linux-port: end-to-end proof and verified smoke evidence"
git push -u fork linux-port
```

---

### Task 10: Desktop Electron shell — nhánh dev Linux

> Thêm sau quyết định của chủ sở hữu 2026-09-13: phạm vi "Đầy đủ có app desktop". Dựa trên dữ kiện: `packages/runtime/src/desktop.ts:195-220` — nhánh dev spawn `process.execPath + [electron/cli.js, scripts/electron-bootstrap.mjs]`; yêu cầu `MAC_CHROMIUM_TMPDIR` chỉ áp dụng `isMacAppStoreDesktop`.

**Files:**
- Modify: `packages/runtime/src/desktop.ts` (chỉ nếu env/build nhánh linux thiếu)
- Test: `packages/runtime/test/linux-desktop-spawn.test.ts`

**Interfaces:**
- Produces: `buildElectronSpawnOptions` hoạt động trên linux không-MAS: không đòi `MAC_CHROMIUM_TMPDIR`, command = `process.execPath`, args = `[<electron/cli.js>, <scripts/electron-bootstrap.mjs>, ...]`. Test khoá hợp đồng này.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildElectronSpawnOptions } from "../src/desktop.js";

function linuxDevConfig(): Parameters<typeof buildElectronSpawnOptions>[0] {
  return {
    packageResources: null,
    paths: { electronUserData: "/tmp/meetless-electron" },
  } as never; // cấu hình dev tối thiểu — hiệu chỉnh theo type thật khi viết test
}

describe("buildElectronSpawnOptions on linux dev", () => {
  it("launches electron through the node dev shim without MAC chromium temp", () => {
    const options = buildElectronSpawnOptions(linuxDevConfig(), "http://127.0.0.1:8099/", {}, null);
    expect(options.command).toBe(process.execPath);
    expect(options.args.join(" ")).toContain("electron");
    expect(options.args.join(" ")).toContain("electron-bootstrap.mjs");
    expect(options.env.MAC_CHROMIUM_TMPDIR).toBeUndefined();
  });
});
```

(Hiệu chỉnh fixture config theo type `RuntimeConfig` thật — đọc `packages/runtime/src/desktop.ts:195-220` và `config.ts` để lấy trường bắt buộc; giữ nguyên 3 assertion.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/runtime && npx vitest run test/linux-desktop-spawn.test.ts`
Expected: FAIL hoặc throw vì fixture chưa khớp type / import.

- [ ] **Step 3: Implement/adjust**

Nếu test fail do nhánh MAS branch điều kiện: sửa điều kiện đầu hàm thành chỉ áp dụng khi `isMacAppStoreDesktop(config)` (đã đúng theo code hiện tại — chủ yếu là fixture). Không đổi logic darwin.

- [ ] **Step 4: Run test + smoke dev thật**

Run: `cd packages/runtime && npx vitest run test/linux-desktop-spawn.test.ts` → PASS.
Smoke (máy có display): `npm run build:paseo:types && npm run build:meetless && npm run build:app && MEETLESS_RUNTIME_ROOT=/tmp/meetless-dev npm run runtime:desktop` — cửa sổ Electron mở và tải renderer; Ctrl+C thoát sạch. Ghi kết quả vào `docs/linux-development.md`.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/test/linux-desktop-spawn.test.ts packages/runtime/src/desktop.ts docs/linux-development.md
git commit -m "linux-port: desktop electron dev launch contract on linux"
```

---

### Task 11: Đóng gói AppImage + deb

**Files:**
- Create: `scripts/package-linux.mjs`
- Create: `scripts/linux/electron-builder.meetless.yml`
- Modify: `package.json` (scripts `package:linux`)

**Interfaces:**
- Produces: `npm run package:linux` — build (paseo types + meetless + app export), render `release/linux/` chứa `Meetless-<version>-x86_64.AppImage` và `meetless_<version>_amd64.deb`; artifacts chạy được qua `--appimage-extract` check + `dpkg-deb --info`.

- [ ] **Step 1: Viết builder config `scripts/linux/electron-builder.meetless.yml`**

```yaml
appId: com.meetless.app
productName: Meetless
executableName: Meetless
directories:
  output: release/linux
files:
  - dist-meetless/runtime/**/*
  - dist-meetless/plugin/**/*
  - dist-meetless/renderer/**/*
  - scripts/electron-bootstrap.mjs
asarUnpack:
  - dist-meetless/runtime/**
extraResources: []
linux:
  target:
    - AppImage
    - deb
  category: Utility
  icon: scripts/linux/icon.png
```

(`scripts/linux/icon.png`: lấy từ `design/` assets hiện có — tìm `fd -e png . design/ | head`, chọn icon app, resize 512×512 nếu cần bằng `ffmpeg -i in.png -vf scale=512:512 out.png`.)

- [ ] **Step 2: Viết orchestration `scripts/package-linux.mjs`**

Khung: (1) chạy `npm run build:paseo:types`, `npm run build:meetless`, `npm run build:app`; (2) lắp `dist-meetless/` = `packages/runtime/dist` + `packages/meetless-plugin/dist` + `packages/meetless-app/dist` (renderer); (3) `npx electron-builder --config scripts/linux/electron-builder.meetless.yml --linux AppImage deb` (chạy trong `vendor/paseo/packages/desktop` để dùng devDependency `electron-builder` ở đó, trỏ `directories.output` về绝对路径 `release/linux` của repo meetless); (4) kiểm artifact tồn tại + in sha256.

- [ ] **Step 3: Chạy đóng gói**

Run: `npm run package:linux`
Expected: 2 artifacts trong `release/linux/` + manifest sha256 in ra.

- [ ] **Step 4: Kiểm chứng artifact**

Run: `cd release/linux && ./Meetless-*-x86_64.AppImage --appimage-extract >/dev/null && ls squashfs-root/ | head && dpkg-deb --info meetless_*_amd64.deb | head -8`
Expected: extract thành công có `Meetless` executable; metadata deb đúng appId/productName.

- [ ] **Step 5: Commit**

```bash
git add scripts/package-linux.mjs scripts/linux package.json release/.gitignore 2>/dev/null || git add scripts/package-linux.mjs scripts/linux package.json
git commit -m "linux-port: appimage and deb packaging for the meetless desktop app"
```

---

### Task 12: Proof desktop + validation cuối

**Files:**
- Modify: `scripts/prove-linux-port.mjs` (thêm stage desktop)
- Modify: `docs/linux-development.md` (bằng chứng verified-on)

**Interfaces:**
- Consumes: Task 9 proof (headless), Task 11 artifacts.

- [ ] **Step 1: Thêm stage desktop vào proof**

Stage 5 trong `prove-linux-port.mjs`: nếu có display (`process.env.DISPLAY` hoặc `WAYLAND_DISPLAY`) hoặc có `xvfb-run`: khởi AppImage qua `--ozone-platform=` an toàn hoặc `xvfb-run -a ./Meetless-*.AppImage --no-sandbox`, đợi 8s, kiểm process sống, TERM sạch; không display → stage `skipped` với lý do (không fail).

- [ ] **Step 2: Chạy proof đầy đủ**

Run: `npm run proof:linux`
Expected: mọi stage `ok: true` hoặc desktop `skipped` có lý do; exit 0.

- [ ] **Step 3: Validation tổng**

Run: `npm run build:paseo:types && npx tsc -b tsconfig.build.json --pretty false && npx vitest run --config vitest.config.ts 2>&1 | tail -8`
Expected: sạch và pass toàn bộ.

- [ ] **Step 4: Ghi bằng chứng smoke desktop vào docs**

Mở AppImage trên máy thật (hoặc `xvfb-run`), xác nhận: cửa sổ Meetless hiện, renderer tải, danh sách meetings từ daemon hiện. Ghi ngày + máy + kết quả vào `docs/linux-development.md` mục "Verified on".

- [ ] **Step 5: Commit + push**

```bash
git add scripts/prove-linux-port.mjs docs/linux-development.md
git commit -m "linux-port: desktop proof stage and final validation evidence"
git push fork linux-port
```

---

## Phạm vi kế hoạch sau (chưa làm trong plan này)

- Managed Convex self-host bật trên Linux.
- Capture helper native libpipewire (nếu `parec` monitor không đủ).
- Snap/Flatpak (chỉ AppImage + deb trong plan này).
- Rebase định kỳ từ `hoangnb24/meetless` upstream.
