import { describe, expect, test, vi } from "vitest";
import type { Meeting, RecordingSession } from "@meetless/meeting-domain";
import { LinuxNoopPremiumAccess } from "../src/linux-premium-access.js";
import { TranscriptionRouteCoordinator, type TranscriptionRouteStore } from "../src/transcription-route.js";

describe("LinuxNoopPremiumAccess", () => {
  test("is always inactive and never throws on status", async () => {
    const access = new LinuxNoopPremiumAccess();
    expect(await access.status()).toEqual({ status: "inactive", reason: "linux-noop" });
    expect((await access.status()).status).not.toBe("active");
  });

  test("rejects purchase and restore with a BYOK pointer", async () => {
    const access = new LinuxNoopPremiumAccess();
    await expect(access.purchase()).rejects.toThrow(/BYOK/i);
    await expect(access.restore()).rejects.toThrow(/BYOK/i);
  });

  test("gates the managed transcription route without dispatching", async () => {
    const recording = {
      id: "r-linux",
      meetingId: "m-linux",
      status: "saved",
      savedOutput: { destination: "/tmp/r-linux.mp3", byteLength: 10, sha256: "a".repeat(64) },
    } as unknown as RecordingSession;
    const managed = vi.fn();
    const store: TranscriptionRouteStore = {
      list: async () => [meeting("m-linux")],
      listRecordings: async () => [recording],
      getTranscriptForMeeting: async () => null,
      grantTranscriptionConsent: async () => ({ status: "granted", grantedAt: "2026-09-13T00:00:00.000Z" }),
    };
    const route = new TranscriptionRouteCoordinator(store, new LinuxNoopPremiumAccess(), { transcribe: managed });

    const result = await route.start("m-linux");

    expect(result).toMatchObject({ route: "managed", outcome: "purchase_required", transcript: null });
    expect(managed).not.toHaveBeenCalled();
  });
});

function meeting(id: string): Meeting {
  return {
    id,
    title: id,
    status: "ready",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}
