import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MeetingStore } from "@meetless/meeting-store";
import type { TranscriptState } from "@meetless/meeting-domain";
import {
  MeetingDiarizationService,
  readSpeakerLabelOverlay,
} from "../src/diarization/meeting-diarization.js";
import type { DiarizerProvider } from "../src/diarization/diarizer.js";
import type { SpeakerTurn } from "../src/diarization/attribution.js";

const linux = process.platform === "linux";
const ffmpeg = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout?.trim() ?? "";
const runnable = linux && ffmpeg;

const roots = new Set<string>();
const now = "2026-09-14T12:00:00.000Z";

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function fakeProvider(turns: SpeakerTurn[], available: DiarizerProvider["available"] = async () => ({ ok: true })) {
  return {
    available,
    run: vi.fn(async () => turns),
  };
}

/**
 * Session fixture with two system chunks: logical 0..1500ms (timeline
 * 0..1500ms) and logical 2500..3000ms (timeline 1500..2000ms), so the logical
 * 1500..2500ms gap exercises the turn mapping.
 */
async function writeSystemSessionChunks(storeRoot: string, recordingId: string): Promise<void> {
  const sessionDirectory = path.join(storeRoot, "sessions", recordingId);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    path.join(sessionDirectory, "chunk--system--000000--000000000000--000000024000--16000--1.wav"),
    pcmWav(24_000, -1_000),
  );
  await writeFile(
    path.join(sessionDirectory, "chunk--system--000001--000000040000--000000008000--16000--1.wav"),
    pcmWav(8_000, -2_000),
  );
}

async function readyTranscript(store: MeetingStore, meetingId: string, recordingId: string): Promise<TranscriptState> {
  await store.ensureTranscript({
    meetingId,
    recordingId,
    audio: { destination: `meetings/${recordingId}.mp3`, byteLength: 128, sha256: "audio-sha", durationMs: 3_000 },
    ranges: [
      { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-di-0" },
      { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-di-1" },
      { ordinal: 2, startMs: 2_500, endMs: 3_000, segmentId: "segment-di-2" },
    ],
  });
  const labels = ["Cuộc họp", "Bạn", "Cuộc họp"];
  const texts = ["system one", "microphone aside", "system two"];
  let transcript = await store.getTranscriptForMeeting(meetingId);
  for (let index = 0; index < 3; index += 1) {
    const next = await store.beginTranscriptRequest(transcript!.id);
    transcript = await store.checkpointTranscriptRange(transcript!.id, {
      range: next!.range,
      attempts: next!.attempt,
      text: texts[index]!,
      usage: null,
      speakerLabel: labels[index],
    });
  }
  return store.publishTranscript(transcript!.id);
}

async function createSavedRecording(store: MeetingStore, meetingId: string, recordingId: string): Promise<void> {
  await store.create({ id: meetingId, title: "Diarization meeting" });
  await store.startRecording({ id: recordingId, meetingId });
  await store.commitChunk(recordingId, {
    id: `${recordingId}-sys`, source: "system", storageKey: `sessions/${recordingId}/sys.chunk`,
    byteLength: 128, sha256: "chunk-sha", committedAt: now,
    logicalStartMs: 0, durationMs: 2_000, sampleRate: 16_000, channels: 1, format: "wav",
  });
  const recovered = await store.prepareInventoryRecovery(recordingId, "capture closed");
  await store.markInventoryScanning(recordingId);
  await store.publishInventory(recordingId, {
    storageKey: `sessions/${recordingId}/inventory.ndjson`, digest: "chunk-set-sha",
    chunkCount: recovered.inventory.knownChunkCount,
    microphoneCount: recovered.inventory.microphoneCount,
    systemCount: recovered.inventory.systemCount,
    publishedAt: now,
  });
  await store.beginFinalization(recordingId, {
    openChunksDurablyClosed: true, chunkSetDigest: "chunk-set-sha",
    destination: `meetings/${recordingId}.mp3`, expectedIdentity: { byteLength: 128, sha256: "audio-sha" },
  });
  await store.markRecordingSaved(recordingId, {
    destination: `meetings/${recordingId}.mp3`, identity: { byteLength: 128, sha256: "audio-sha" }, readable: true,
  });
}

function pcmWav(frameCount: number, marker: number): Buffer {
  const data = Buffer.alloc(44 + frameCount * 2);
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8, "ascii");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24);
  data.writeUInt32LE(32_000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii");
  data.writeUInt32LE(frameCount * 2, 40);
  for (let frame = 0; frame < frameCount; frame += 1) data.writeInt16LE(marker, 44 + frame * 2);
  return data;
}

(runnable ? describe : describe.skip)("meeting diarization service", () => {
  test("reports eligibility before running and refuses meetings without a ready transcript", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarization-status-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-1", "r-1");
    await writeSystemSessionChunks(root, "r-1");
    const service = new MeetingDiarizationService({
      storeRoot: root, store, provider: fakeProvider([]), ffmpeg, now: () => now,
    });

    const before = await service.status("m-1");
    expect(before).toMatchObject({ meetingId: "m-1", available: true, eligible: false, applied: false, running: false, speakers: [] });
    await expect(service.run("m-1")).rejects.toThrow(/ready transcript/u);

    await readyTranscript(store, "m-1", "r-1");
    const eligible = await service.status("m-1");
    expect(eligible.eligible).toBe(true);
    expect(eligible.applied).toBe(false);
  });

  test("runs the provider over the system timeline and persists an idempotent attribution overlay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarization-run-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-1", "r-1");
    await writeSystemSessionChunks(root, "r-1");
    const published = await readyTranscript(store, "m-1", "r-1");
    const provider = fakeProvider([
      { speaker: "S1", startMs: 0, endMs: 1_200 },      // timeline -> logical 0..1200 (chunk 1)
      { speaker: "S2", startMs: 1_500, endMs: 2_000 },  // timeline -> logical 2500..3000 (chunk 2)
    ]);
    const service = new MeetingDiarizationService({
      storeRoot: root, store, provider, ffmpeg, now: () => now,
    });

    const outcome = await service.run("m-1");

    expect(provider.run).toHaveBeenCalledTimes(1);
    // The concatenated system WAV is what the provider diarizes.
    expect(provider.run.mock.calls[0]![0]).toBe(path.join(root, "sessions", "r-1", "source-timelines", "system.wav"));
    expect(outcome.status).toMatchObject({
      meetingId: "m-1", applied: true, running: false, progress: 0,
      speakers: [{ id: "S1", name: "Người 1" }, { id: "S2", name: "Người 2" }],
    });
    // Mic-side segment keeps "Bạn"; system segments map to their speakers.
    const overlay = await service.overlayLabels("m-1");
    expect(overlay.get("segment-di-0")).toBe("Người 1");
    expect(overlay.has("segment-di-1")).toBe(false);
    expect(overlay.get("segment-di-2")).toBe("Người 2");

    // The durable transcript and its publication stay untouched.
    const durable = await store.getTranscriptForMeeting("m-1");
    expect(durable!.checkpoints.map((checkpoint) => checkpoint.speakerLabel)).toEqual(["Cuộc họp", "Bạn", "Cuộc họp"]);
    expect(durable!.publication).toEqual(published.publication);

    // Re-running re-attributes from fresh turns and overwrites the overlay.
    const second = await service.run("m-1");
    expect(second.status.applied).toBe(true);
    expect(provider.run).toHaveBeenCalledTimes(2);

    // The overlay survives a restart through the on-disk store.
    expect((await readSpeakerLabelOverlay(root, "m-1")).get("segment-di-0")).toBe("Người 1");
  });

  test("rename persists display names per meeting outside meetings.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarization-rename-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-1", "r-1");
    await writeSystemSessionChunks(root, "r-1");
    await readyTranscript(store, "m-1", "r-1");
    const service = new MeetingDiarizationService({
      storeRoot: root, store,
      provider: fakeProvider([{ speaker: "S1", startMs: 0, endMs: 1_200 }, { speaker: "S2", startMs: 1_500, endMs: 2_000 }]),
      ffmpeg, now: () => now,
    });
    await service.run("m-1");

    const renamed = await service.rename("m-1", { S1: "Renames Name X", S9: "ignored" });
    expect(renamed.status.speakers).toEqual([{ id: "S1", name: "Renames Name X" }, { id: "S2", name: "Người 2" }]);
    expect((await service.overlayLabels("m-1")).get("segment-di-0")).toBe("Renames Name X");

    // Stored under <storeRoot>/diarization/<meetingId>.json, not meetings.json.
    const storedPath = path.join(root, "diarization-names", "m-1.json");
    const stored = JSON.parse(await readFile(storedPath, "utf8")) as { speakers: Array<{ id: string; name: string }> };
    expect(stored.speakers[0]).toEqual({ id: "S1", name: "Renames Name X" });
    const meetingsJson = await readFile(path.join(root, "meetings.json"), "utf8");
    expect(meetingsJson.includes("Renames Name X")).toBe(false);

    await expect(service.rename("m-missing", { S1: "X" })).rejects.toThrow(/No speaker diarization/u);
  });

  test("token-missing providers surface through status without running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarization-token-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-1", "r-1");
    await writeSystemSessionChunks(root, "r-1");
    await readyTranscript(store, "m-1", "r-1");
    const provider = fakeProvider([], async () => ({ ok: false, reason: "token_missing" as const }));
    const service = new MeetingDiarizationService({ storeRoot: root, store, provider, ffmpeg, now: () => now });

    expect(await service.status("m-1")).toMatchObject({ available: false, unavailableReason: "token_missing" });
    const overlay = await readSpeakerLabelOverlay(root, "m-1");
    expect(overlay.size).toBe(0);
  });
});
