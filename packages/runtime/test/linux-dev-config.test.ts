import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LINUX_DEVELOPMENT_CAPTURE_HELPER_RELATIVE_PATH,
  captureHelperCommand,
  linuxDevelopmentCaptureHelperEntry,
  materializeLinuxDevelopmentCaptureHelper,
  prepareRuntime,
  resolveRuntimeConfig,
} from "../src/config.js";

/**
 * Linux-port dev wiring (Issues 1b + 2): the platform path functions gain real
 * callers — linux dev runtime root resolves through
 * platformUserSupportRelativePath("linux") — and the dev capture helper default
 * becomes the runtime-root wrapper materialized by prepareRuntime carrying
 * captureHelperCommand("linux").
 */

const linux = process.platform === "linux";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const roots: string[] = [];

beforeAll(() => {
  if (!linux) return;
  return Promise.resolve();
});
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
});

describe.runIf(linux)("captureHelperCommand", () => {
  it("returns the node-over-entry command for linux", () => {
    const command = captureHelperCommand("linux");
    expect(command).not.toBeNull();
    expect(command!.executable).toBe(process.execPath);
    expect(command!.arguments).toHaveLength(1);
    expect(command!.arguments[0]).toBe(linuxDevelopmentCaptureHelperEntry());
    expect(command!.arguments[0]).toBe(
      path.join(repoRoot, "packages/meetless-plugin/dist/src/linux/capture-helper-entry.js"),
    );
  });

  it("keeps the darwin native binary default (null) and rejects other platforms", () => {
    expect(captureHelperCommand("darwin")).toBeNull();
    expect(() => captureHelperCommand("win32" as NodeJS.Platform)).toThrow(/unsupported platform/i);
  });

  it("honors an explicit entry path", () => {
    expect(captureHelperCommand("linux", "/opt/other-entry.js")!.arguments).toEqual(["/opt/other-entry.js"]);
  });
});

describe.runIf(linux)("linux dev runtime roots (platform path wiring)", () => {
  it("defaults to ~/.local/share/meetless when MEETLESS_RUNTIME_ROOT is unset", () => {
    const config = resolveRuntimeConfig({ environment: {}, userHome: "/home/tester" });
    expect(config.paths.root).toBe(path.join("/home/tester", ".local/share/meetless"));
    expect(config.paths.recordingExports).toBe(path.join("/home/tester", "Documents/meetings"));
    expect(config.environment.MEETLESS_RUNTIME_ROOT).toBe(config.paths.root);
  });

  it("keeps an explicit MEETLESS_RUNTIME_ROOT override", () => {
    const config = resolveRuntimeConfig({
      environment: { MEETLESS_RUNTIME_ROOT: "/tmp/meetless-iso" },
      userHome: "/home/tester",
    });
    expect(config.paths.root).toBe("/tmp/meetless-iso");
  });

  it("points the dev capture helper default at the runtime-root wrapper", () => {
    const config = resolveRuntimeConfig({
      environment: { MEETLESS_RUNTIME_ROOT: "/tmp/meetless-iso" },
      userHome: "/home/tester",
    });
    expect(config.paths.captureHelper).toBe(path.join("/tmp/meetless-iso", LINUX_DEVELOPMENT_CAPTURE_HELPER_RELATIVE_PATH));
    expect(config.environment.MEETLESS_CAPTURE_HELPER).toBe(config.paths.captureHelper);
  });

  it("resolves the real home default for a bare run", () => {
    const config = resolveRuntimeConfig({ environment: {} });
    expect(config.paths.root).toBe(path.join(homedir(), ".local/share/meetless"));
  });
});

describe.runIf(linux)("prepareRuntime linux dev capture helper wrapper", () => {
  it("materializes an executable wrapper that runs the node entry", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-dev-wrapper-"));
    roots.push(root);
    const config = resolveRuntimeConfig({ runtimeRoot: root });
    await prepareRuntime(config);

    const wrapper = config.paths.captureHelper;
    expect(wrapper).toBe(path.join(root, LINUX_DEVELOPMENT_CAPTURE_HELPER_RELATIVE_PATH));
    const info = await stat(wrapper);
    expect(info.isFile()).toBe(true);
    expect((info.mode & 0o111) !== 0).toBe(true);
    const content = await readFile(wrapper, "utf8");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain(linuxDevelopmentCaptureHelperEntry());
    expect(content.endsWith('"$@"\n')).toBe(true);

    // The wrapper must carry captureHelperCommand exactly: node over entry,
    // with arguments (here --fixture) passed through.
    const command = captureHelperCommand("linux", linuxDevelopmentCaptureHelperEntry(repoRoot))!;
    expect(content).toContain(`exec '${command.executable}' '${command.arguments[0]!}' "$@"`);

    // End-to-end smoke through the real helper protocol.
    await expect(wrapperSpeaksFixtureProtocol(wrapper)).resolves.toBe(true);
  });

  it("fails closed when the plugin entry was never built", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-dev-wrapper-missing-"));
    roots.push(root);
    const config = resolveRuntimeConfig({ runtimeRoot: root });
    // Point the plugin tree at an unbuilt tmp repo so the resolved entry is
    // absent; the materializer must refuse instead of writing a broken wrapper.
    (config.paths as { plugin: string }).plugin = path.join(root, "unbuilt-repo", "packages", "meetless-plugin");
    await expect(materializeLinuxDevelopmentCaptureHelper(config)).rejects.toThrow(
      /Linux development capture helper entry is missing.*build:meetless/s,
    );
    await expect(stat(path.join(root, LINUX_DEVELOPMENT_CAPTURE_HELPER_RELATIVE_PATH))).rejects.toThrow(/ENOENT/);
  });
});

/** Spawns the wrapper in fixture mode and waits for the `started` event. */
async function wrapperSpeaksFixtureProtocol(wrapper: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn(wrapper, ["--fixture"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`wrapper produced no started event; stderr: ${stderr.slice(0, 300)}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      const line = stdout.slice(0, newline).trim();
      if (!line) return;
      try {
        const event = JSON.parse(line) as { event?: string; error?: string };
        if (event.event === "started") {
          clearTimeout(timer);
          child.stdin.end('{"version":1,"command":"stop"}\n');
          child.once("exit", () => resolve(true));
          return;
        }
        if (event.event === "error" || event.event === "captureFailed") {
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error(`helper failed: ${event.error}`));
        }
      } catch (error) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(`${JSON.stringify({ version: 1, command: "start", sessionDirectory: tmpdir(), elapsedMs: 0 })}\n`);
  });
}
