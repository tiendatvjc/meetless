import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  assertProductionHostProvenance,
  parseLinuxProcStatParentPid,
} from "../src/production-host.js";

/**
 * Linux-port dev provenance (mirrors packages/runtime/test/linux-desktop-attestation.test.ts
 * for the b89aefa runtime-side bypass): the plugin replaces the macOS
 * MeetlessHost env+codesign attestation with a /proc ppid-ownership proof.
 * Darwin keeps the full fail-closed contract.
 */

const linux = process.platform === "linux";

describe.runIf(linux)("linux development plugin provenance", () => {
  test("accepts a real owned dev process without MEETLESS_HOST_* attestation", async () => {
    await expect(assertProductionHostProvenance({}, process.pid)).resolves.toBeUndefined();
  });

  test("fails closed for a dead plugin PID (cannot inspect /proc)", async () => {
    const deadPid = await exitedChildPid();
    await expect(assertProductionHostProvenance({}, deadPid)).rejects.toThrow(
      /rejected before helper spawn.*cannot inspect linux dev plugin PID .* through \/proc.*Authority.*runtime:host/s,
    );
  });

  test("fails closed for the init process (no owning supervisor above it)", async () => {
    // PID 1's parent is 0: the adoption anchor itself has no owner, so an
    // (impossible) plugin there is unowned; this pins the ppid<=1 gate.
    await expect(assertProductionHostProvenance({}, 1)).rejects.toThrow(/has no owning supervisor process/);
  });

  test("keeps the full darwin fail-closed path with injected inspection dependencies", async () => {
    // Injected dependencies pin the darwin provenance contract: the linux dev
    // bypass must not absorb the attestation flow exercised by production-host.test.ts.
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      await expect(
        assertProductionHostProvenance({}, 400, {
          parentPid: () => 1,
          executable: () => {
            throw new Error("darwin executable inspection must run");
          },
          readIdentity: async () => {
            throw new Error("darwin identity read must run");
          },
          inspectCode: () => {
            throw new Error("darwin codesign inspection must run");
          },
        }),
      ).rejects.toThrow(/no complete MeetlessHost attestation/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  test("parses /proc stat field 4 after a comm containing spaces", () => {
    const stat = `1234 (meetless node wor) S 1 2345 2345 0 -1 4194560`;
    expect(parseLinuxProcStatParentPid(stat, 1234)).toBe(1);
    expect(parseLinuxProcStatParentPid(`42 (sh) R 7 1 1`, 42)).toBe(7);
    expect(() => parseLinuxProcStatParentPid("bad stat line", 99)).toThrow(/cannot read the parent PID/);
  });
});

/** Spawns a short-lived child and returns its (now dead) PID. */
async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

// A reparented-orphan fail-closed test is deliberately NOT asserted here: in
// this environment orphans are adopted by a live per-user subreaper (observed
// ppid 4500, systemd-based sandbox supervisor), and /proc ppid alone cannot
// distinguish adoption from real supervision. That residual is documented in
// the production-host.ts ownership-proof comment and the fix-wave report.
