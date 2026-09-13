import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTranscript, type Meeting, type RecordingSession, type TranscriptState } from "@meetless/meeting-domain";
import { OpenAiByokTranscriptionProvider, readByokKey } from "../src/openai-byok-provider.js";
import { TranscriptionRouteCoordinator, type TranscriptionRouteStore } from "../src/transcription-route.js";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((run) => run().catch(() => undefined)));
});

describe("readByokKey", () => {
  test("returns the trimmed key from a v1 file", async () => {
    const read = async () => '{"version":1,"apiKey":"  sk-test  "}\n';
    expect(await readByokKey("/x/byok.json", read)).toBe("sk-test");
  });

  test("returns null for missing, malformed, or empty keys without throwing", async () => {
    const missing = async () => { throw new Error("ENOENT"); };
    expect(await readByokKey("/x/byok.json", missing)).toBeNull();
    const malformed = async () => "not json";
    expect(await readByokKey("/x/byok.json", malformed)).toBeNull();
    const empty = async () => '{"version":1,"apiKey":"  "}';
    expect(await readByokKey("/x/byok.json", empty)).toBeNull();
    const wrongVersion = async () => '{"version":2,"apiKey":"sk-test"}';
    expect(await readByokKey("/x/byok.json", wrongVersion)).toBeNull();
    const nonStringKey = async () => '{"version":1,"apiKey":42}';
    expect(await readByokKey("/x/byok.json", nonStringKey)).toBeNull();
  });
});

describe("OpenAiByokTranscriptionProvider", () => {
  test("reports missing when no key is configured", async () => {
    const provider = new OpenAiByokTranscriptionProvider({
      configPath: "/x/byok.json",
      fetchImpl: (() => { throw new Error("must not fetch"); }) as typeof fetch,
    });
    expect(await provider.status()).toBe("missing");
  });

  test("transcribes through the gpt-transcribe endpoint with the user key", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meetless-byok-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const audioPath = path.join(directory, "audio.wav");
    await writeFile(audioPath, Buffer.from("RIFF fake wav payload for the multipart body"));
    let seenUrl = "";
    let seenAuth = "";
    let seenForm: FormData | null = null;
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>)["authorization"]);
      seenForm = init?.body as FormData;
      return new Response(JSON.stringify({ text: "xin chào thế giới" }), { status: 200 });
    }) as typeof fetch;
    const provider = new OpenAiByokTranscriptionProvider({
      configPath: "/x/byok.json",
      fetchImpl,
      readKey: async () => readByokKey("/x/byok.json", async () => '{"version":1,"apiKey":"sk-test"}'),
    });
    const result = await provider.transcribe({
      recordingId: "r1",
      audioPath,
      audioIdentity: { sha256: "a", byteLength: 1 } as never,
      range: { ordinal: 0, startMs: 0, endMs: 1_000 },
    });
    expect(result.text).toBe("xin chào thế giới");
    expect(seenUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(seenAuth).toBe("Bearer sk-test");
    expect(seenForm?.get("model")).toBe("gpt-transcribe");
    expect(seenForm?.get("response_format")).toBe("json");
    expect((seenForm?.get("file") as File).name).toBe("audio.wav");
    expect(result.detectedLanguages).toEqual(["en", "vi"]);
    expect(result.usage).toBeNull();
  });

  test("rejects when the configured key is refused", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "meetless-byok-401-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const audioPath = path.join(directory, "audio.wav");
    await writeFile(audioPath, Buffer.from("RIFF fake wav payload"));
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 })) as typeof fetch;
    const provider = new OpenAiByokTranscriptionProvider({
      configPath: "/x/byok.json",
      fetchImpl,
      readKey: async () => readByokKey("/x/byok.json", async () => '{"version":1,"apiKey":"sk-test"}'),
    });
    await expect(provider.transcribe({
      recordingId: "r1",
      audioPath,
      audioIdentity: { sha256: "a", byteLength: 1 } as never,
      range: { ordinal: 0, startMs: 0, endMs: 1_000 },
    })).rejects.toThrow(/rejected the configured API key/);
  });

  test("refuses to transcribe when no key is configured", async () => {
    const provider = new OpenAiByokTranscriptionProvider({
      configPath: "/x/byok.json",
      fetchImpl: (() => { throw new Error("must not fetch"); }) as typeof fetch,
    });
    await expect(provider.transcribe({
      recordingId: "r1",
      audioPath: "/x/a.wav",
      audioIdentity: { sha256: "a", byteLength: 1 } as never,
      range: { ordinal: 0, startMs: 0, endMs: 1_000 },
    })).rejects.toThrow(/missing API key/);
  });
});

describe("transcription route precedence", () => {
  test("a configured BYOK key routes the start locally without reading Premium", async () => {
    const recording = savedRecording("m-byok", "r-byok");
    const premiumStatus = vi.fn(async () => ({ status: "active" as const }));
    const managed = vi.fn();
    const pending = transcript("m-byok", "r-byok", "pending");
    const ready = { ...pending, status: "ready" as const };
    const byokTranscribe = vi.fn(async ({ onDurableStart }: {
      recordingId: string;
      onDurableStart(transcript: TranscriptState): void;
    }) => {
      onDurableStart(pending);
      return { transcript: ready };
    });
    const route = new TranscriptionRouteCoordinator(
      routeStore([recording], () => null),
      { status: premiumStatus },
      { transcribe: managed },
      { status: async () => "configured", transcribe: byokTranscribe },
    );

    const result = await route.start("m-byok");

    expect(result).toMatchObject({ route: "byok", outcome: "started", transcript: { status: "pending", recordingId: "r-byok" } });
    expect(premiumStatus).not.toHaveBeenCalled();
    expect(managed).not.toHaveBeenCalled();
    expect(byokTranscribe).toHaveBeenCalledOnce();
    expect(byokTranscribe).toHaveBeenCalledWith(expect.objectContaining({ recordingId: "r-byok" }));
  });

  test("a missing BYOK key keeps the managed route and its Premium gate unchanged", async () => {
    const recording = savedRecording("m-managed", "r-managed");
    const premiumStatus = vi.fn(async () => ({ status: "active" as const }));
    const pending = transcript("m-managed", "r-managed", "pending");
    const managed = vi.fn(async ({ onDurableStart }: {
      recordingId: string;
      onDurableStart(transcript: TranscriptState): void;
    }) => {
      onDurableStart(pending);
      return { transcript: { ...pending, status: "ready" as const } };
    });
    const byokTranscribe = vi.fn();
    const route = new TranscriptionRouteCoordinator(
      routeStore([recording], () => null),
      { status: premiumStatus },
      { transcribe: managed },
      { status: async () => "missing", transcribe: byokTranscribe },
    );

    const result = await route.start("m-managed");

    expect(result).toMatchObject({ route: "managed", outcome: "started" });
    expect(premiumStatus).toHaveBeenCalledOnce();
    expect(managed).toHaveBeenCalledOnce();
    expect(byokTranscribe).not.toHaveBeenCalled();
  });

  test("without any BYOK route an inactive Premium still gates the managed dispatch", async () => {
    const recording = savedRecording("m-gate", "r-gate");
    const managed = vi.fn();
    const route = new TranscriptionRouteCoordinator(
      routeStore([recording], () => null),
      { status: async () => ({ status: "inactive" as const }) },
      { transcribe: managed },
    );

    expect(await route.start("m-gate")).toMatchObject({ route: "managed", outcome: "purchase_required" });
    expect(managed).not.toHaveBeenCalled();
  });
});

function routeStore(recordings: RecordingSession[], readTranscript: (meetingId: string) => TranscriptState | null): TranscriptionRouteStore {
  return {
    list: async () => recordings.map((entry) => meeting(entry.meetingId)),
    listRecordings: async () => recordings,
    getTranscriptForMeeting: async (meetingId) => readTranscript(meetingId),
    grantTranscriptionConsent: async () => ({ status: "granted", grantedAt: "2026-09-13T00:00:00.000Z" }),
  };
}

function meeting(id: string): Meeting {
  return {
    id,
    title: id,
    status: "ready",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

function savedRecording(meetingId: string, id: string): RecordingSession {
  return {
    id,
    meetingId,
    status: "saved",
    savedOutput: { destination: `/tmp/${id}.mp3`, byteLength: 10, sha256: "a".repeat(64) },
  } as unknown as RecordingSession;
}

function transcript(meetingId: string, recordingId: string, status: TranscriptState["status"]): TranscriptState {
  const created = createTranscript({
    meetingId,
    recordingId,
    audio: { destination: `/tmp/${recordingId}.mp3`, byteLength: 10, sha256: "a".repeat(64), durationMs: 1_000 },
    now: "2026-09-13T00:00:00.000Z",
  });
  return status === "pending" ? created : { ...created, status };
}
