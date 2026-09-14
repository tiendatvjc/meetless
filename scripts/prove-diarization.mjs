import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MeetingStore } from "@meetless/meeting-store";
import {
  MeetingDiarizationService,
  readSpeakerLabelOverlay,
} from "../packages/meetless-plugin/dist/src/diarization/meeting-diarization.js";

/**
 * Speaker diarization fixture proof (plan task B5): exercises the real
 * meeting-diarization pipeline end-to-end against a tmp store — saved
 * recording, concatenated system timeline (ffmpeg), attribution, overlay
 * persistence, rename round-trip — with a FAKE DiarizerProvider turning
 * fixture turns, so no pyannote model or HF token is needed.
 *
 * Manifest lines: one JSON object per stage ({stage, ok, ...}); exit 0 iff
 * every stage passed.
 */

const ffmpeg = process.platform === "linux" ? (spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout?.trim() ?? "") : "";
const now = "2026-09-14T12:00:00.000Z";
const meetingId = "m-proof-1";
const recordingId = "r-proof-1";
const tmpRoots = new Set();

const stages = [];
try {
  if (process.platform !== "linux" || !ffmpeg) {
    stages.push(await runStage("prerequisites", async () => {
      throw new Error(`speaker diarization proof requires linux + ffmpeg (platform: ${process.platform}, ffmpeg: ${ffmpeg || "missing"})`);
    }));
  } else {
    stages.push(await runStage("prerequisites", async () => ({ platform: process.platform, ffmpeg })));
    stages.push(...(await runProof()));
  }
} finally {
  await Promise.all([...tmpRoots].map((root) => rm(root, { recursive: true, force: true })));
}

const gatePassed = stages.every((stage) => stage.ok);
console.log(JSON.stringify({ proof: "diarization-fixture", summary: { ok: gatePassed, stages: stages.map((stage) => [stage.stage, stage.ok]) } }));
process.exitCode = gatePassed ? 0 : 1;

async function runProof() {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-proof-diarization-"));
  tmpRoots.add(root);
  const store = new MeetingStore({ root, now: () => now });

  let publicationBefore = null;
  let checkpointsBefore = null;

  const fixture = await runStage("fixture", async () => {
    await createSavedRecording(store);
    await writeSystemSessionChunks(root);
    const published = await readyTranscript(store);
    publicationBefore = JSON.stringify(published.publication);
    checkpointsBefore = JSON.stringify(published.checkpoints.map((checkpoint) => [checkpoint.range.segmentId, checkpoint.speakerLabel, checkpoint.text]));
    return {
      storeRoot: root,
      meetingId,
      recordingId,
      segments: 3,
      phaseALabels: ["Cuộc họp", "Bạn", "Cuộc họp"],
    };
  });
  if (!fixture.ok) return [fixture];

  const provider = fakeProvider([
    { speaker: "S1", startMs: 0, endMs: 1_200 },      // timeline → logical 0..1200 (chunk 1)
    { speaker: "S2", startMs: 1_500, endMs: 2_000 },  // timeline → logical 2500..3000 (chunk 2)
  ]);
  let service = new MeetingDiarizationService({ storeRoot: root, store, provider, ffmpeg, now: () => now });

  const run = await runStage("diarization-run", async () => {
    const outcome = await service.run(meetingId);
    if (provider.run.mock.calls.length !== 1) throw new Error(`provider ran ${provider.run.mock.calls.length} times, expected 1`);
    const diarizedPath = provider.run.mock.calls[0][0];
    if (diarizedPath !== path.join(root, "sessions", recordingId, "source-timelines", "system.wav")) {
      throw new Error(`provider diarized unexpected path: ${diarizedPath}`);
    }
    const overlayFile = JSON.parse(await readFile(path.join(root, "diarization-names", `${meetingId}.json`), "utf8"));
    if (overlayFile.speakers[0].name !== "Người 1" || overlayFile.speakers[1].name !== "Người 2") {
      throw new Error(`unexpected default speaker names: ${JSON.stringify(overlayFile.speakers)}`);
    }
    return {
      status: { applied: outcome.status.applied, eligible: outcome.status.eligible, available: outcome.status.available },
      speakers: outcome.status.speakers,
    };
  });
  if (!run.ok) return [fixture, run];

  const overlay = await runStage("overlay-labels", async () => {
    const labels = await service.overlayLabels(meetingId);
    const expect = [
      [labels.get("segment-proof-0"), "Người 1"],
      [labels.has("segment-proof-1"), false], // microphone side keeps its phase-A label
      [labels.get("segment-proof-2"), "Người 2"],
    ];
    for (const [actual, wanted] of expect) {
      if (actual !== wanted) throw new Error(`overlay mismatch: got ${String(actual)}, wanted ${String(wanted)} (${JSON.stringify([...labels.entries()])})`);
    }
    return { attributed: labels.size, micSegmentKept: "segment-proof-1" };
  });
  if (!overlay.ok) return [fixture, run, overlay];

  const rename = await runStage("rename-roundtrip", async () => {
    const first = await service.rename(meetingId, { S1: "Trưởng nhóm" });
    if (first.status.speakers.some((speaker) => speaker.id === "S1" && speaker.name !== "Trưởng nhóm")) {
      throw new Error(`rename did not apply: ${JSON.stringify(first.status.speakers)}`);
    }
    // Simulated restart: a fresh service instance (and the plain read helper)
    // must observe the renamed overlay from disk.
    const restarted = new MeetingDiarizationService({ storeRoot: root, store, provider, ffmpeg, now: () => now });
    const second = await restarted.rename(meetingId, { S2: "Khách hàng" });
    const names = Object.fromEntries(second.status.speakers.map((speaker) => [speaker.id, speaker.name]));
    if (names.S1 !== "Trưởng nhóm" || names.S2 !== "Khách hàng") {
      throw new Error(`rename round-trip lost a name: ${JSON.stringify(names)}`);
    }
    const diskOverlay = await readSpeakerLabelOverlay(root, meetingId);
    if (diskOverlay.get("segment-proof-0") !== "Trưởng nhóm" || diskOverlay.get("segment-proof-2") !== "Khách hàng") {
      throw new Error(`disk overlay names wrong after round-trip: ${JSON.stringify([...diskOverlay.entries()])}`);
    }
    return { speakers: names };
  });
  if (!rename.ok) return [fixture, run, overlay, rename];

  const publication = await runStage("publication-immutable", async () => {
    const durable = await store.getTranscriptForMeeting(meetingId);
    const publicationAfter = JSON.stringify(durable.publication);
    const checkpointsAfter = JSON.stringify(durable.checkpoints.map((checkpoint) => [checkpoint.range.segmentId, checkpoint.speakerLabel, checkpoint.text]));
    if (publicationAfter !== publicationBefore) {
      throw new Error("transcript publication changed after diarization + rename");
    }
    if (checkpointsAfter !== checkpointsBefore) {
      throw new Error("durable transcript checkpoints changed after diarization + rename");
    }
    return { byteIdentical: true };
  });

  return [fixture, run, overlay, rename, publication];
}

/** Runs a stage, printing its one-line manifest entry; never throws. */
async function runStage(stage, body) {
  const startedAt = Date.now();
  try {
    const result = (await body()) ?? {};
    const entry = { stage, ok: true, durationMs: Date.now() - startedAt, ...result };
    console.log(JSON.stringify(entry));
    return entry;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry = { stage, ok: false, durationMs: Date.now() - startedAt, error: message.slice(0, 300) };
    console.log(JSON.stringify(entry));
    return entry;
  }
}

function fakeProvider(turns) {
  const calls = [];
  const run = async (wavPath) => {
    calls.push([wavPath]);
    return turns;
  };
  run.mock = { calls };
  return {
    available: async () => ({ ok: true }),
    run,
  };
}

async function createSavedRecording(store) {
  await store.create({ id: meetingId, title: "Diarization proof meeting" });
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

/**
 * Two system chunks: logical 0..1500ms (timeline 0..1500ms) and logical
 * 2500..3000ms (timeline 1500..2000ms), so the logical 1500..2500ms gap
 * exercises the turn mapping (same shape as the vitest fixture).
 */
async function writeSystemSessionChunks(storeRoot) {
  const { mkdir, writeFile } = await import("node:fs/promises");
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

async function readyTranscript(store) {
  await store.ensureTranscript({
    meetingId,
    recordingId,
    audio: { destination: `meetings/${recordingId}.mp3`, byteLength: 128, sha256: "audio-sha", durationMs: 3_000 },
    ranges: [
      { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-proof-0" },
      { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-proof-1" },
      { ordinal: 2, startMs: 2_500, endMs: 3_000, segmentId: "segment-proof-2" },
    ],
  });
  const labels = ["Cuộc họp", "Bạn", "Cuộc họp"];
  const texts = ["system one", "microphone aside", "system two"];
  let transcript = await store.getTranscriptForMeeting(meetingId);
  for (let index = 0; index < 3; index += 1) {
    const next = await store.beginTranscriptRequest(transcript.id);
    transcript = await store.checkpointTranscriptRange(transcript.id, {
      range: next.range,
      attempts: next.attempt,
      text: texts[index],
      usage: null,
      speakerLabel: labels[index],
    });
  }
  return store.publishTranscript(transcript.id);
}

function pcmWav(frameCount, marker) {
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
