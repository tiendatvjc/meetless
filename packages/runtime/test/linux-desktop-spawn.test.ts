import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import { buildElectronSpawnOptions } from "../src/desktop.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Development-mode config on linux: the repository has no packaged runtime
 * manifest, so `resolveRuntimeConfig` yields packaged:false with
 * packageResources:null — exactly the branch `runMeetlessDesktop` takes for
 * `npm run runtime:desktop` on the linux port.
 */
async function linuxDevConfig(): Promise<RuntimeConfig> {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "meetless-linux-dev-spawn-"));
  fixtureRoots.push(runtimeRoot);
  return resolveRuntimeConfig({
    runtimeRoot,
    rendererOrigin: "http://127.0.0.1:18082",
    environment: {
      MEETLESS_RUNTIME_ROOT: runtimeRoot,
      MEETLESS_FFMPEG: process.execPath,
      MEETLESS_FFPROBE: process.execPath,
    },
  });
}

describe("buildElectronSpawnOptions on linux dev", () => {
  it("launches electron through the node dev shim without MAC chromium temp", async () => {
    const config = await linuxDevConfig();
    expect(config.packaged).toBe(false);
    expect(config.packageResources).toBeNull();

    const launch = buildElectronSpawnOptions(config, "http://127.0.0.1:18082/", {}, null);

    // Dev contract: node runs the electron module shim from node_modules, not a
    // packaged binary, and the repository bootstrap script follows it.
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(2);
    expect(launch.args[0]).toContain(path.join("electron", "cli.js"));
    expect(launch.args[1]).toContain("electron-bootstrap.mjs");

    // Dev contract: MAC_CHROMIUM_TMPDIR is a packaged-MAS-only requirement.
    expect(launch.options.env?.MAC_CHROMIUM_TMPDIR).toBeUndefined();
    expect(launch.options.env?.EXPO_DEV_URL).toBe("http://127.0.0.1:18082/");
  });
});
