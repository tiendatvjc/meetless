import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEETLESS_INSTALLATION_PATH, resolveRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  assertDesktopLaunchedByHost,
  assertSupervisorOwnedByHost,
  expectedHostConfiguration,
  isPackagedRuntime,
  MEETLESS_HOST_BUNDLE_ID,
  MEETLESS_HOST_INSTALL_PATH,
} from "../src/host.js";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Development-mode config on linux: the repository has no packaged runtime
 * manifest, so `resolveRuntimeConfig` yields packaged:false — exactly the
 * branch `npm run runtime:desktop` takes on the linux port.
 */
async function linuxDevConfig(): Promise<RuntimeConfig> {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "meetless-linux-dev-attest-"));
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

function withDarwinPlatform<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  return run().finally(() => {
    Object.defineProperty(process, "platform", original ?? { value: "linux", configurable: true });
  });
}

describe("linux dev-mode desktop host attestation bypass", () => {
  it("attests the unpackaged linux dev launch through the real supervising executable", async () => {
    const config = await linuxDevConfig();
    expect(process.platform).toBe("linux");
    expect(isPackagedRuntime(config)).toBe(false);

    const identity = await assertDesktopLaunchedByHost(config);

    expect(identity.bundleIdentifier).toBe(MEETLESS_HOST_BUNDLE_ID);
    expect(identity.designatedRequirement).toBe("linux-development-host");
    expect(identity.bundlePath).toBe(path.resolve(process.execPath));
    expect(identity.bundleRealPath).toBe(await import("node:fs/promises").then((fs) => fs.realpath(process.execPath)));
    expect(identity.cdHash).toMatch(/^[a-f0-9]{40}$/u);
    const executable = await readFile(identity.executablePath);
    expect(identity.binarySha256).toBe(createHash("sha256").update(executable).digest("hex"));
    expect(identity.configuration).toEqual(expectedHostConfiguration(config));
    // The dev bypass must never hand out the macOS install bundle as its host.
    expect(identity.bundlePath).not.toBe(MEETLESS_HOST_INSTALL_PATH);
  });

  it("keeps the darwin dev path failing closed without the installed macOS app bundle", async () => {
    const config = await linuxDevConfig();
    await withDarwinPlatform(() =>
      expect(assertDesktopLaunchedByHost(config)).rejects.toThrow(
        /Production Meetless host attestation failed closed/u,
      ),
    );
    expect(process.platform).toBe("linux");
  });

  it("keeps the full darwin attestation contract for injected inspection dependencies", async () => {
    const config = await linuxDevConfig();
    await expect(assertDesktopLaunchedByHost(config, process.pid, {
      inspectInstalled: async () => {
        throw new Error("darwin-contract-sentinel");
      },
      readRecorded: async () => {
        throw new Error("unused");
      },
      inspectProcess: async () => {
        throw new Error("unused");
      },
      inspectLiveHost: async () => {
        throw new Error("unused");
      },
    })).rejects.toThrow(/cannot attest the installed host.*darwin-contract-sentinel/us);
  });

  it("keeps the packaged linux path on the native packaged attestation (no dev bypass)", async () => {
    const config = await linuxDevConfig();
    const packagedConfig: RuntimeConfig = {
      ...config,
      packaged: true,
      endpoints: { ...config.endpoints, mode: "packaged" },
    };
    expect(isPackagedRuntime(packagedConfig)).toBe(true);
    await expect(assertDesktopLaunchedByHost(packagedConfig)).rejects.toThrow(
      /cannot read the native host identity/u,
    );
  });

  it("attests a linux dev daemon only when this desktop runtime owns it", async () => {
    const config = await linuxDevConfig();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "ignore" });
    try {
      const owned = await assertSupervisorOwnedByHost(config, child.pid!);
      expect(owned.identity.designatedRequirement).toBe("linux-development-host");
      expect(owned.desktopPid).toBe(process.pid);
      expect(owned.supervisorPid).toBe(child.pid);
    } finally {
      child.kill();
    }

    await expect(assertSupervisorOwnedByHost(config, process.ppid)).rejects.toThrow(
      /not owned by this desktop runtime/u,
    );
  });

  it("keeps the darwin install-path constants untouched by the bypass", async () => {
    expect(MEETLESS_HOST_INSTALL_PATH).toBe("/Applications/Meetless.app");
    expect(MEETLESS_INSTALLATION_PATH).toBe("/Applications/Meetless.app");
    const config = await linuxDevConfig();
    expect(config.host.bundle).toBe("/Applications/Meetless.app");
  });
});
