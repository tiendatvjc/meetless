import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MeetingStore } from "@meetless/meeting-store";
import type { TranscriptRange } from "@meetless/meeting-domain";
import type { SourceTimeline } from "../src/source-timeline.js";
import {
  buildTwoSourceTranscriptPlan,
  resolveTwoSourcePlan,
} from "../src/two-source-plan.js";
import { transcribeTwoSourceRecording } from "../src/transcription-service.js";

const roots = new Set<string>();
const now = "2026-09-14T10:00:00.000Z";

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function timeline(
  source: "microphone" | "system",
  chunkOffsets: Array<{ chunkId: string; logicalStartMs: number; timelineStartMs: number; durationMs: number }>,
): SourceTimeline {
  return {
    source,
    wavPath: `/tmp/meetless-test-sessions/r-1/source-timelines/${source}.wav`,
    durationMs: chunkOffsets.reduce((total, chunk) => total + chunk.durationMs, 0),
    chunkOffsets,
  };
}

const microphone = timeline("microphone", [
  { chunkId: "chunk--microphone--000000--000000000000--016000--16000--1", logicalStartMs: 0, timelineStartMs: 0, durationMs: 1_000 },
  { chunkId: "chunk--microphone--000001--000000032000--008000--16000--1", logicalStartMs: 2_000, timelineStartMs: 1_000, durationMs: 500 },
  { chunkId: "chunk--microphone--000002--000000048000--016000--16000--1", logicalStartMs: 3_000, timelineStartMs: 1_500, durationMs: 1_000 },
]);
const system = timeline("system", [
  { chunkId: "chunk--system--000000--000000000000--024000--16000--1", logicalStartMs: 0, timelineStartMs: 0, durationMs: 1_500 },
  { chunkId: "chunk--system--000001--000000040000--008000--16000--1", logicalStartMs: 2_500, timelineStartMs: 1_500, durationMs: 500 },
]);

describe("two-source transcript plan", () => {
  test("interleaves per-source windows on the logical timeline, microphone first on ties, with speaker labels", () => {
    const plan = buildTwoSourceTranscriptPlan({
      microphone, system, recordingId: "r-1", audioSha256: "audio-sha", rangeMs: 1_000,
    });

    expect(plan.ranges.map((range) => [range.startMs, range.endMs])).toEqual([
      [0, 1_000],       // microphone window 1
      [0, 1_000],       // system window 1 (tie -> microphone first)
      [1_000, 3_000],   // system window 2 spans the 1500..2500 logical gap
      [2_000, 3_500],   // microphone window 2 spans the 2500..3000 logical gap
      [3_500, 4_000],   // microphone window 3
    ]);
    expect(plan.ranges.map((range) => range.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(plan.entries.map((entry) => entry.speakerLabel)).toEqual(["Bạn", "Cuộc họp", "Cuộc họp", "Bạn", "Bạn"]);
    expect(plan.entries.map((entry) => entry.source)).toEqual(["microphone", "system", "system", "microphone", "microphone"]);
    // Timeline windows stay contiguous per source so range extraction slices real audio.
    expect(plan.entries.map((entry) => [entry.timelineStartMs, entry.timelineEndMs])).toEqual([
      [0, 1_000], [0, 1_000], [1_000, 2_000], [1_000, 2_000], [2_000, 2_500],
    ]);
    expect(new Set(plan.ranges.map((range) => range.segmentId)).size).toBe(plan.ranges.length);

    const rebuilt = buildTwoSourceTranscriptPlan({
      microphone, system, recordingId: "r-1", audioSha256: "audio-sha", rangeMs: 1_000,
    });
    expect(rebuilt).toEqual(plan);
  });

  test("dispatch decision falls back when a source, offsets, or an existing mixed plan is missing", () => {
    const planInput = { recordingId: "r-1", audioSha256: "audio-sha", rangeMs: 1_000 } as const;
    expect(resolveTwoSourcePlan({ ...planInput, microphone, system: null })).toBeNull();
    expect(resolveTwoSourcePlan({ ...planInput, microphone: null, system })).toBeNull();
    expect(resolveTwoSourcePlan({
      ...planInput,
      microphone: timeline("microphone", []),
      system,
    })).toBeNull();

    const planned = resolveTwoSourcePlan({ ...planInput, microphone, system });
    expect(planned!.ranges.length).toBe(5);
    // Matching an existing transcript resumes the same two-source plan.
    expect(resolveTwoSourcePlan({ ...planInput, microphone, system, existingRanges: planned!.ranges })).toEqual(planned);

    // A legacy planner transcript (30s logical windows) must resume via the mixed flow instead.
    const mixedRanges: TranscriptRange[] = [
      { ordinal: 0, startMs: 0, endMs: 30_000, segmentId: "segment-mixed-0" },
      { ordinal: 1, startMs: 30_000, endMs: 60_000, segmentId: "segment-mixed-1" },
    ];
    expect(resolveTwoSourcePlan({ ...planInput, microphone, system, existingRanges: mixedRanges })).toBeNull();
  });
});

describe("two-source transcription dispatch", () => {
  test("transcribes each source through its timeline windows and checkpoints interleaved labeled segments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-two-source-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-1", "r-1");
    await store.grantTranscriptionConsent();
    const plan = buildTwoSourceTranscriptPlan({
      microphone, system, recordingId: "r-1", audioSha256: "audio-sha", rangeMs: 1_000,
    });

    const extracts: Array<{ filePath: string; startMs: number; endMs: number }> = [];
    const providerRanges: TranscriptRange[] = [];
    const inspector = {
      initialize: vi.fn(async () => undefined),
      inspect: vi.fn(async () => ({ identity: { byteLength: 128, sha256: "audio-sha" }, durationMs: 4_000 })),
      extractRange: vi.fn(async (filePath: string, range: TranscriptRange) => {
        extracts.push({ filePath, startMs: range.startMs, endMs: range.endMs });
        const rangePath = path.join(root, `range-${range.ordinal}.mp3`);
        await import("node:fs/promises").then((fs) => fs.writeFile(rangePath, `range-${range.ordinal}`));
        return { path: rangePath, cleanup: async () => undefined };
      }),
    };
    const provider = {
      status: vi.fn(async () => "configured" as const),
      transcribe: vi.fn(async (request: { range: TranscriptRange }) => {
        providerRanges.push(request.range);
        return { text: `text-${request.range.ordinal}`, detectedLanguages: ["vi"], usage: null };
      }),
    };
    const stateEvents: string[] = [];

    const transcript = await transcribeTwoSourceRecording(store, provider, "r-1", { microphone, system }, {
      inspector,
      sourceSnapshots: passThroughSnapshots(),
      onStateChange: (state) => stateEvents.push(state.status),
      rangeMs: 1_000,
    });

    expect(transcript!.status).toBe("ready");
    expect(transcript!.ranges).toEqual(plan.ranges);
    expect(transcript!.checkpoints.map((checkpoint) => checkpoint.speakerLabel)).toEqual(
      plan.entries.map((entry) => entry.speakerLabel),
    );
    expect(transcript!.checkpoints.map((checkpoint) => checkpoint.text)).toEqual(
      plan.ranges.map((range) => `text-${range.ordinal}`),
    );
    expect(transcript!.requestCount).toBe(plan.ranges.length);
    expect(providerRanges).toEqual(plan.ranges);
    expect(extracts.map((extract) => path.basename(extract.filePath))).toEqual(
      plan.entries.map((entry) => `${entry.source}.wav`),
    );
    expect(extracts.map((extract) => [extract.startMs, extract.endMs])).toEqual(
      plan.entries.map((entry) => [entry.timelineStartMs, entry.timelineEndMs]),
    );
    expect(stateEvents).toEqual([...plan.ranges.map(() => "pending"), "ready"]);

    // Labels survive a store reload through the durable checkpoint schema.
    const reloaded = new MeetingStore({ root, now: () => now });
    const persisted = await reloaded.getTranscriptForMeeting("m-1");
    expect(persisted!.checkpoints.map((checkpoint) => checkpoint.speakerLabel)).toEqual(
      plan.entries.map((entry) => entry.speakerLabel),
    );
    expect(persisted!.publication).not.toBeNull();
  });

  test("returns null without touching provider work when an existing transcript follows the mixed planner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-two-source-fallback-"));
    roots.add(root);
    const store = new MeetingStore({ root, now: () => now });
    await createSavedRecording(store, "m-fallback", "r-fallback");
    await store.grantTranscriptionConsent();
    await store.ensureTranscript({
      meetingId: "m-fallback",
      recordingId: "r-fallback",
      audio: { destination: "meetings/r-fallback.mp3", byteLength: 128, sha256: "audio-sha", durationMs: 90_000 },
    });

    const transcribe = vi.fn();
    const result = await transcribeTwoSourceRecording(store, { status: async () => "configured", transcribe }, "r-fallback", {
      microphone, system,
    }, {
      inspector: {
        initialize: async () => undefined,
        inspect: vi.fn(async () => ({ identity: { byteLength: 128, sha256: "audio-sha" }, durationMs: 90_000 })),
        extractRange: vi.fn(),
      },
      sourceSnapshots: passThroughSnapshots(),
    });

    expect(result).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });
});

function passThroughSnapshots() {
  return {
    initialize: async () => undefined,
    create: vi.fn(async (sourcePath: string) => ({ path: sourcePath, cleanup: async () => undefined })),
  };
}

async function createSavedRecording(store: MeetingStore, meetingId: string, recordingId: string): Promise<void> {
  await store.create({ id: meetingId, title: "Two-source transcript" });
  await store.startRecording({ id: recordingId, meetingId });
  await store.commitChunk(recordingId, {
    id: `${recordingId}-mic`, source: "microphone", storageKey: `sessions/${recordingId}/mic.chunk`,
    byteLength: 128, sha256: "chunk-sha", committedAt: now,
    logicalStartMs: 0, durationMs: 1_000, sampleRate: 16_000, channels: 1, format: "wav",
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
