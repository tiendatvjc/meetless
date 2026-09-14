import { describe, expect, test } from "vitest";
import {
  attributeSegments,
  defaultSpeakerNames,
  mapTurnsToLogicalTimeline,
  speakerAppearanceOrder,
  type AttributableSegment,
  type SpeakerTurn,
} from "../src/diarization/attribution.js";

function segment(startMs: number, endMs: number, speakerLabel?: string): AttributableSegment {
  return speakerLabel === undefined ? { startMs, endMs } : { startMs, endMs, speakerLabel };
}

function turn(speaker: string, startMs: number, endMs: number): SpeakerTurn {
  return { speaker, startMs, endMs };
}

describe("attributeSegments", () => {
  test("attributes a segment fully inside a single turn", () => {
    const result = attributeSegments([segment(1_000, 2_000)], [turn("S1", 0, 5_000)]);
    expect(result).toEqual([{ startMs: 1_000, endMs: 2_000, speakerId: "S1" }]);
  });

  test("attributes across an overlap boundary using the majority speaker", () => {
    const result = attributeSegments(
      [segment(0, 1_000)],
      [turn("S1", 0, 400), turn("S2", 400, 2_000)],
    );
    // S2 covers 600ms of the 1000ms segment (>= 50%); S1 covers only 40%.
    expect(result).toEqual([{ startMs: 0, endMs: 1_000, speakerId: "S2" }]);
  });

  test("a tie keeps the turn with the larger coverage, then the earlier turn", () => {
    const exact = attributeSegments(
      [segment(0, 1_000)],
      [turn("S2", 0, 500), turn("S1", 500, 1_000)],
    );
    // Both cover exactly 50%; the earlier turn (S2 starts first) wins.
    expect(exact).toEqual([{ startMs: 0, endMs: 1_000, speakerId: "S2" }]);

    const larger = attributeSegments(
      [segment(0, 1_000)],
      [turn("S2", 100, 700), turn("S1", 0, 500)],
    );
    // S2 covers 600ms, S1 covers 500ms — the larger coverage wins regardless of order.
    expect(larger).toEqual([{ startMs: 0, endMs: 1_000, speakerId: "S2" }]);
  });

  test("leaves a segment unchanged when no turn covers the threshold", () => {
    const original = segment(0, 1_000);
    const result = attributeSegments([original], [turn("S1", 900, 2_000), turn("S2", 5_000, 6_000)]);
    expect(result).toEqual([original]);
    expect(result[0]).toBe(original);
    expect("speakerId" in result[0]!).toBe(false);
  });

  test("microphone-labeled segments pass through untouched", () => {
    const original = segment(0, 1_000, "Bạn");
    const result = attributeSegments([original], [turn("S1", 0, 1_000)]);
    expect(result).toEqual([original]);
    expect(result[0]).toBe(original);
    expect("speakerId" in result[0]!).toBe(false);
  });

  test("zero turns return the segments unchanged", () => {
    const originals = [segment(0, 1_000), segment(1_000, 2_000, "Cuộc họp")];
    const result = attributeSegments(originals, []);
    expect(result).toEqual(originals);
    expect(result[0]).toBe(originals[0]);
    expect(result[1]).toBe(originals[1]);
  });

  test("honours a custom overlap threshold", () => {
    const lenient = attributeSegments([segment(0, 1_000)], [turn("S1", 0, 300)], { minOverlapRatio: 0.25 });
    expect(lenient).toEqual([{ startMs: 0, endMs: 1_000, speakerId: "S1" }]);
    const strict = attributeSegments([segment(0, 1_000)], [turn("S1", 0, 600)], { minOverlapRatio: 0.75 });
    expect(strict).toEqual([segment(0, 1_000)]);
  });
});

describe("mapTurnsToLogicalTimeline", () => {
  const chunkOffsets = [
    { chunkId: "chunk--system--000000", logicalStartMs: 0, timelineStartMs: 0, durationMs: 1_500 },
    { chunkId: "chunk--system--000001", logicalStartMs: 2_500, timelineStartMs: 1_500, durationMs: 500 },
  ];

  test("maps turn coordinates through the containing chunk offsets", () => {
    expect(mapTurnsToLogicalTimeline([turn("S1", 100, 1_000)], chunkOffsets))
      .toEqual([turn("S1", 100, 1_000)]);
    // The second chunk starts at timeline 1500 but logical 2500 (1000ms logical gap).
    expect(mapTurnsToLogicalTimeline([turn("S2", 1_600, 1_800)], chunkOffsets))
      .toEqual([turn("S2", 2_600, 2_800)]);
  });

  test("splits a turn spanning chunks so the logical gap is not bridged", () => {
    const mapped = mapTurnsToLogicalTimeline([turn("S1", 1_000, 1_800)], chunkOffsets);
    expect(mapped).toEqual([turn("S1", 1_000, 1_500), turn("S1", 2_500, 2_800)]);
  });

  test("drops turns outside every chunk and returns nothing without offsets", () => {
    expect(mapTurnsToLogicalTimeline([turn("S1", 2_500, 3_000)], chunkOffsets)).toEqual([]);
    expect(mapTurnsToLogicalTimeline([turn("S1", 0, 100)], [])).toEqual([]);
  });
});

describe("speaker naming", () => {
  test("orders speakers by first appearance and defaults S-ids to numbered names", () => {
    const order = speakerAppearanceOrder([
      turn("S2", 0, 100), turn("S1", 50, 60), turn("S2", 200, 300), turn("S1", 400, 500),
    ]);
    expect(order).toEqual(["S2", "S1"]);
    const names = defaultSpeakerNames(order);
    expect(names.get("S2")).toBe("Người 2");
    expect(names.get("S1")).toBe("Người 1");
  });

  test("falls back to appearance position for non-standard ids without colliding", () => {
    const names = defaultSpeakerNames(["SPEAKER_00", "S1"]);
    expect(names.get("SPEAKER_00")).toBe("Người 1");
    // S1 keeps its numbered name; the positional fallback disambiguates.
    expect(names.get("S1")).toBe("Người 1 (2)");
  });
});
