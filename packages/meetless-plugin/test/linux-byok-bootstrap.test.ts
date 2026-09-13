import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import WebSocket from "ws";
import {
  recordingRuntimeForTest,
  startRecordingRuntime,
  stopRecordingRuntime,
} from "../src/server.js";

/**
 * Linux-port Issue 1c: on linux dev, a configured BYOK key exempts the
 * recording runtime bootstrap and the production recording start from the
 * signed native capability socket requirements; the managed route keeps them
 * (darwin byte-identical, never exempt).
 */

const linux = process.platform === "linux";
const ffmpeg = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout?.trim() ?? "";
const ffprobe = spawnSync("which", ["ffprobe"], { encoding: "utf8" }).stdout?.trim() ?? "";
const runnable = linux && ffmpeg && ffprobe;

let root: string | null = null;
const savedEnv = new Map<string, string | undefined>();
const managedKeys = [
  "MEETLESS_STORE_ROOT",
  "MEETLESS_EXPORT_ROOT",
  "MEETLESS_CAPTURE_HELPER",
  "MEETLESS_FFMPEG",
  "MEETLESS_FFPROBE",
  "MEETLESS_RECORDING_SOCKET",
  "MEETLESS_TRANSCRIPTION_SOCKET",
  "MEETLESS_TRANSCRIPTION_STAGING",
  "MEETLESS_RUNTIME_ROOT",
  "MEETLESS_RUNTIME_ENDPOINTS",
  "MEETLESS_RUNTIME_PACKAGED",
  "MEETLESS_CAPTURE_MODE",
];

beforeAll(() => {
  if (!runnable) return;
  for (const key of managedKeys) savedEnv.set(key, process.env[key]);
});

afterEach(async () => {
  await stopRecordingRuntime().catch(() => undefined);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe.runIf(runnable)("linux BYOK bootstrap exemption", () => {
  test("bootstraps the recording runtime without any native transcription socket", async () => {
    root = await mkdtemp(path.join(tmpdir(), "meetless-byok-bootstrap-"));
    await writeFile(path.join(root, "byok-openai.json"), JSON.stringify({ version: 1, apiKey: "sk-test-byok" }));
    setLinuxRuntimeEnv(root);
    delete process.env.MEETLESS_TRANSCRIPTION_SOCKET;
    delete process.env.MEETLESS_TRANSCRIPTION_STAGING;

    await expect(startRecordingRuntime(Date.now() + 20_000)).resolves.toBeUndefined();
    expect(recordingRuntimeForTest()).not.toBeNull();
  });

  test("keeps requiring the native capability socket when BYOK is not configured", async () => {
    root = await mkdtemp(path.join(tmpdir(), "meetless-byok-missing-"));
    setLinuxRuntimeEnv(root);
    // The versioned composition is absent and the legacy transcription socket
    // is absolute, so the remaining failing requirement is the staging/socket
    // contract, not endpoint resolution.
    process.env.MEETLESS_TRANSCRIPTION_SOCKET = path.join(root, "transcription.sock");
    delete process.env.MEETLESS_TRANSCRIPTION_STAGING;

    await expect(startRecordingRuntime(Date.now() + 20_000)).rejects.toThrow(
      "Production transcription requires the signed MeetlessHost native capability socket",
    );
  });

  test("exempts the production recording start from the native capture-permission socket", { timeout: 60_000 }, async () => {
    root = await mkdtemp(path.join(tmpdir(), "meetless-byok-start-"));
    await writeFile(path.join(root, "byok-openai.json"), JSON.stringify({ version: 1, apiKey: "sk-test-byok" }));
    setLinuxRuntimeEnv(root);
    delete process.env.MEETLESS_TRANSCRIPTION_SOCKET;
    delete process.env.MEETLESS_TRANSCRIPTION_STAGING;
    // A helper that exists but speaks nothing: authorizeProductionStart must
    // pass (BYOK exemption) and the failure must be the helper, not the
    // native capture-permission socket.
    process.env.MEETLESS_CAPTURE_HELPER = "/bin/false";

    await startRecordingRuntime(Date.now() + 20_000);
    const response = await controlCommand(path.join(root, "recording.sock"), "start", { title: "byok exemption" });
    expect(response.ok).toBe(false);
    expect(response.error).toBeTruthy();
    expect(response.error).not.toMatch(/native capture-permission/i);
    expect(response.error).toMatch(/capture helper/i);
  });

  test("keeps darwin on the managed-only native requirements even with a BYOK key", async () => {
    root = await mkdtemp(path.join(tmpdir(), "meetless-byok-darwin-"));
    await writeFile(path.join(root, "byok-openai.json"), JSON.stringify({ version: 1, apiKey: "sk-test-byok" }));
    setLinuxRuntimeEnv(root);
    delete process.env.MEETLESS_TRANSCRIPTION_STAGING;

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      await expect(startRecordingRuntime(Date.now() + 20_000)).rejects.toThrow(
        /no complete MeetlessHost attestation|signed MeetlessHost native capability socket/,
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});

function setLinuxRuntimeEnv(root: string): void {
  process.env.MEETLESS_RUNTIME_ROOT = root;
  process.env.MEETLESS_STORE_ROOT = path.join(root, "store");
  process.env.MEETLESS_EXPORT_ROOT = path.join(root, "exports");
  process.env.MEETLESS_FFMPEG = ffmpeg;
  process.env.MEETLESS_FFPROBE = ffprobe;
  process.env.MEETLESS_CAPTURE_HELPER = "/bin/true";
  process.env.MEETLESS_RECORDING_SOCKET = path.join(root, "recording.sock");
  process.env.MEETLESS_TRANSCRIPTION_SOCKET = path.join(root, "transcription.sock");
  delete process.env.MEETLESS_RUNTIME_ENDPOINTS;
  delete process.env.MEETLESS_RUNTIME_PACKAGED;
  delete process.env.MEETLESS_CAPTURE_MODE;
  void mkdir(path.join(root, "store"), { recursive: true });
}

interface ControlResponse {
  ok: boolean;
  error: string | null;
  status: { status?: string };
}

/** Sends one recording control command over the live runtime's socket. */
async function controlCommand(
  socketPath: string,
  command: "start",
  input: { title: string },
): Promise<ControlResponse> {
  const socket = new WebSocket("ws://localhost/ws", {
    createConnection: () => net.connect(socketPath),
  } as never);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error: Error) => reject(error));
    });
    const requestId = `byok-${process.pid}-${Date.now()}`;
    return await new Promise<ControlResponse>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("control command timed out")), 40_000);
      const onMessage = (data: unknown) => {
        try {
          const parsed = JSON.parse(String(data)) as ControlResponse & { requestId?: string; type?: string };
          if (parsed.requestId !== requestId) return; // status broadcasts carry no requestId correlation
          clearTimeout(timer);
          socket.off("message", onMessage);
          resolve(parsed);
        } catch (error) {
          clearTimeout(timer);
          socket.off("message", onMessage);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ version: 1, requestId, command, title: input.title }));
    });
  } finally {
    socket.close();
  }
}
