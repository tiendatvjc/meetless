import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLinuxHelperCommand, resolveParecDevice } from "../../src/linux/capture-helper-linux.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const entry = path.join(repoRoot, "packages/meetless-plugin/dist/src/linux/capture-helper-entry.js");

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

  it("parses pause, resume, and stop commands", () => {
    expect(parseLinuxHelperCommand('{"version":1,"command":"pause"}\n')).toEqual({ version: 1, command: "pause" });
    expect(parseLinuxHelperCommand('{"version":1,"command":"resume","elapsedMs":9000}\n')).toEqual({
      version: 1, command: "resume", elapsedMs: 9000,
    });
    expect(parseLinuxHelperCommand('{"version":1,"command":"stop"}\n')).toEqual({ version: 1, command: "stop" });
  });

  it("returns null for partial lines and non-json lines", () => {
    expect(parseLinuxHelperCommand('{"version":1,"comm')).toBeNull();
    expect(parseLinuxHelperCommand("not json\n")).toBeNull();
  });

  it("returns null for json values that are not helper commands", () => {
    expect(parseLinuxHelperCommand('{"version":1,"command":"bogus"}\n')).toBeNull();
    expect(parseLinuxHelperCommand("42\n")).toBeNull();
    expect(parseLinuxHelperCommand('{"event":"started"}\n')).toBeNull();
  });
});

describe("resolveParecDevice", () => {
  it("uses the default source for the microphone device", async () => {
    const device = await resolveParecDevice("microphone", async () => "alsa_input.pcm\n");
    expect(device).toBe("alsa_input.pcm");
  });

  it("derives the system device from the default sink monitor", async () => {
    const commands: Array<[string, string[]]> = [];
    const device = await resolveParecDevice("system", async (command, args) => {
      commands.push([command, args]);
      return "alsa_output.pcm\n";
    });
    expect(device).toBe("alsa_output.pcm.monitor");
    expect(commands).toEqual([["pactl", ["get-default-sink"]]]);
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
    for (const chunk of chunks) {
      const typed = chunk as { id: string; durationMs: number };
      expect(typed.id).toMatch(/^chunk--(microphone|system)--\d{6}--\d{12}--\d{12}--16000--1$/u);
      expect(typed.durationMs).toBeGreaterThan(0);
    }
  }, 30_000);

  it("commits non-overlapping frame intervals across multiple chunks per source", async () => {
    // Regression: startFrame derived from wall-clock ms drifted by rounding and
    // produced overlapping intervals that inventory reconciliation rejects.
    // Drive the entry directly: the env knob must reach the helper process,
    // which CaptureHelper's minimal dev environment would strip.
    const { spawn } = await import("node:child_process");
    const sessionDirectory2 = await mkdtemp(path.join(tmpdir(), "meetless-multi-"));
    const childProcess = spawn(process.execPath, [entry, "--fixture"], {
      env: { ...process.env, MEETLESS_CHUNK_PAYLOAD_BYTES: String(96_000), PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const emitted: string[] = [];
    childProcess.stdout.setEncoding("utf8");
    childProcess.stdout.on("data", (data: string) => {
      for (const line of String(data).split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { event?: string; id?: string };
          if (event.event === "chunkCommitted" && event.id) emitted.push(event.id);
        } catch { /* non-json */ }
      }
    });
    childProcess.stdin.write(`${JSON.stringify({ version: 1, command: "start", sessionDirectory: sessionDirectory2, elapsedMs: 0 })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 9_000)); // ≥2 commits per source
    childProcess.stdin.write(`${JSON.stringify({ version: 1, command: "stop" })}\n`);
    await new Promise((resolve) => childProcess.once("exit", resolve));
    await rm(sessionDirectory2, { recursive: true, force: true });
    expect(emitted.length).toBeGreaterThanOrEqual(4);
    const perSource = new Map<string, Array<{ start: number; frames: number }>>();
    for (const id of emitted) {
      const match = /^chunk--(microphone|system)--\d{6}--(\d{12})--(\d{12})--16000--1$/u.exec(id);
      expect(match).not.toBeNull();
      const source = match![1]!;
      const list = perSource.get(source) ?? [];
      list.push({ start: Number(match![2]), frames: Number(match![3]) });
      perSource.set(source, list);
    }
    for (const [source, list] of perSource) {
      list.sort((a, b) => a.start - b.start);
      for (let i = 1; i < list.length; i += 1) {
        const previousChunk = list[i - 1]!;
        expect(previousChunk.start + previousChunk.frames).toBeLessThanOrEqual(list[i]!.start);
        void source;
      }
    }
  }, 30_000);
});
