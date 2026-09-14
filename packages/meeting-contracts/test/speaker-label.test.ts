import { describe, expect, test } from "vitest";
import {
  TranscriptSegmentWireSchema,
  TranscriptWireSchema,
  type TranscriptWire,
} from "../src/index.js";

interface SegmentInput {
  range: { ordinal: number; startMs: number; endMs: number; segmentId: string };
  text: string;
  speakerLabel?: string;
  completedAt: string;
  detectedLanguages: string[];
}

function segment(overrides: Partial<SegmentInput> = {}): SegmentInput {
  return {
    range: { ordinal: 0, startMs: 0, endMs: 1_500, segmentId: "segment-1" },
    text: "Xin chào",
    completedAt: "2026-09-14T00:00:00.000Z",
    detectedLanguages: ["vi"],
    ...overrides,
  };
}

function transcript(segments: SegmentInput[]): TranscriptWire {
  return TranscriptWireSchema.parse({
    id: "t-1",
    meetingId: "m-1",
    recordingId: "r-1",
    status: "ready",
    plannerVersion: "m3-range-v1",
    audioDurationMs: 3_000,
    ranges: [
      { ordinal: 0, startMs: 0, endMs: 1_500, segmentId: "segment-1" },
      { ordinal: 1, startMs: 1_500, endMs: 3_000, segmentId: "segment-2" },
    ],
    segments,
    requestCount: segments.length,
    usage: null,
    detectedLanguages: ["vi"],
    failureReason: null,
  });
}

describe("transcript segment speaker labels", () => {
  test("legacy segments without speakerLabel keep parsing unchanged", () => {
    const parsed = TranscriptSegmentWireSchema.parse(segment());
    expect(parsed.text).toBe("Xin chào");
    expect(Object.prototype.hasOwnProperty.call(parsed, "speakerLabel")).toBe(false);
  });

  test("accepts speakerLabel, trimming surrounding whitespace", () => {
    const parsed = TranscriptSegmentWireSchema.parse(segment({ speakerLabel: "  Bạn  " }));
    expect(parsed.speakerLabel).toBe("Bạn");
    expect(TranscriptSegmentWireSchema.parse(segment({ speakerLabel: "Cuộc họp" })).speakerLabel)
      .toBe("Cuộc họp");
  });

  test("accepts exactly 80 characters and rejects one more", () => {
    const boundary = "a".repeat(80);
    expect(TranscriptSegmentWireSchema.parse(segment({ speakerLabel: boundary })).speakerLabel)
      .toHaveLength(80);
    expect(() => TranscriptSegmentWireSchema.parse(segment({ speakerLabel: ` ${boundary}x ` })))
      .toThrow();
  });

  test("rejects non-string labels and stays strict about unknown fields", () => {
    expect(() => TranscriptSegmentWireSchema.parse(segment({ speakerLabel: 7 }))).toThrow();
    expect(() => TranscriptSegmentWireSchema.parse(segment({ speaker: "Bạn" }))).toThrow();
  });

  test("the full transcript wire parses with mixed labelled and legacy segments", () => {
    const parsed = transcript([
      segment({ speakerLabel: "Bạn" }),
      segment({
        range: { ordinal: 1, startMs: 1_500, endMs: 3_000, segmentId: "segment-2" },
      }),
    ]);
    expect(parsed.segments[0]?.speakerLabel).toBe("Bạn");
    expect(Object.prototype.hasOwnProperty.call(parsed.segments[1]!, "speakerLabel")).toBe(false);
  });
});
