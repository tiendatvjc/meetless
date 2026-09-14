import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeChatAttempt,
  createMeetingChatThread,
  startChatQuestion,
  type ChatSelection,
  type MeetingChatThread,
  type TranscriptState,
} from "@meetless/meeting-domain";
import type { MeetingStore } from "@meetless/meeting-store";
import { ChatControlsCatalogWireSchema } from "@meetless/meeting-contracts";
import {
  MeetingChatService,
  PaseoMeetingChatAgentPort,
  type ChatExecutionInput,
} from "../src/chat-service.js";
import {
  devChatProviderCatalogId,
  findDevChatProvider,
  loadDevChatProviders,
  loadDevChatProvidersSafe,
  parseDevProviderAnswer,
  resolveDevChatProvidersPath,
  runDevProviderTurn,
} from "../src/dev-chat-provider.js";

const roots: string[] = [];
const previousConfigPath = process.env.MEETLESS_DEV_CHAT_PROVIDERS;
let configPath = "";

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "meetless-dev-chat-provider-"));
  roots.push(root);
  configPath = path.join(root, "chat-providers.json");
  process.env.MEETLESS_DEV_CHAT_PROVIDERS = configPath;
});

afterEach(async () => {
  if (previousConfigPath === undefined) delete process.env.MEETLESS_DEV_CHAT_PROVIDERS;
  else process.env.MEETLESS_DEV_CHAT_PROVIDERS = previousConfigPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const VALID_CONFIG = {
  version: 1,
  providers: [{
    id: "zai-glm",
    name: "GLM (Z.ai)",
    baseUrl: "https://api.z.ai/api/paas/v4/",
    apiKey: "dev-secret-key",
    models: [{ id: "glm-5.3", "label": "GLM 5.3" }, { id: "glm-5.3-air", label: "GLM 5.3 Air" }],
  }],
};

async function writeConfig(config: unknown): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

describe("dev chat provider loader", () => {
  test("loads a valid file and keeps the api key out of projections", async () => {
    await writeConfig(VALID_CONFIG);
    const providers = await loadDevChatProviders(configPath);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      id: "zai-glm", name: "GLM (Z.ai)", baseUrl: "https://api.z.ai/api/paas/v4/", apiKey: "dev-secret-key",
      models: [{ id: "glm-5.3", label: "GLM 5.3" }, { id: "glm-5.3-air", label: "GLM 5.3 Air" }],
    });
    expect(findDevChatProvider(providers, devChatProviderCatalogId("zai-glm"))).toBe(providers[0]);
    expect(findDevChatProvider(providers, "codex")).toBeNull();
  });

  test("missing file means no dev providers (darwin untouched)", async () => {
    await expect(loadDevChatProviders(configPath)).resolves.toEqual([]);
    expect(resolveDevChatProvidersPath({ MEETLESS_DEV_CHAT_PROVIDERS: configPath })).toBe(configPath);
    expect(resolveDevChatProvidersPath({})).toBe(
      path.join(await import("node:os").then((os) => os.homedir()), ".local", "share", "meetless", "chat-providers.json"),
    );
  });

  test.each([
    ["wrong version", { ...VALID_CONFIG, version: 2 }],
    ["unknown provider field", { ...VALID_CONFIG, providers: [{ ...VALID_CONFIG.providers[0], extra: true }] }],
    ["missing models", { version: 1, providers: [{ ...VALID_CONFIG.providers[0], models: [] }] }],
    ["relative id separator", { version: 1, providers: [{ ...VALID_CONFIG.providers[0], id: "zai:glm" }] }],
    ["non-http baseUrl", { version: 1, providers: [{ ...VALID_CONFIG.providers[0], baseUrl: "ftp://api.z.ai/v4" }] }],
    ["empty api key", { version: 1, providers: [{ ...VALID_CONFIG.providers[0], apiKey: "" }] }],
    ["duplicate provider ids", { version: 1, providers: [VALID_CONFIG.providers[0], VALID_CONFIG.providers[0]] }],
    ["not json", "definitely not json"],
  ])("rejects %s", async (_name, config) => {
    await writeConfig(config);
    await expect(loadDevChatProviders(configPath)).rejects.toThrow(/invalid|duplicate|JSON/iu);
    // The safe variant degrades to "absent" instead of throwing.
    await expect(loadDevChatProvidersSafe(configPath)).resolves.toEqual([]);
  });
});

describe("dev chat providers in the chat catalog", () => {
  test("appear in the same controls catalog beside agent providers and validate as selections", async () => {
    await writeConfig(VALID_CONFIG);
    const port = new PaseoMeetingChatAgentPort(fakePaseo(), "/tmp/irrelevant-execution-root");
    const controls = await port.getControls(null);
    expect(controls.catalogError).toBeNull();
    ChatControlsCatalogWireSchema.parse(controls.catalog);
    const dev = controls.catalog.providers.find((provider) => provider.id === "dev:zai-glm");
    expect(dev).toMatchObject({
      id: "dev:zai-glm", label: "GLM (Z.ai)", status: "ready", modes: [], defaultModeId: null, error: null,
      models: [
        { id: "glm-5.3", label: "GLM 5.3", isDefault: true, thinkingOptions: [], defaultThinkingOptionId: null },
        { id: "glm-5.3-air", label: "GLM 5.3 Air", isDefault: false, thinkingOptions: [], defaultThinkingOptionId: null },
      ],
    });
    expect(controls.catalog.providers.map((provider) => provider.id)).toEqual(["codex", "dev:zai-glm"]);

    const selection: ChatSelection = {
      provider: "dev:zai-glm", model: "glm-5.3", modeId: null, thinkingOptionId: null, featureValues: {},
    };
    await expect(port.validateSelection(selection)).resolves.toEqual(selection);
    await expect(port.discoverFeatures(selection)).resolves.toMatchObject({ status: "ready", features: [] });
    await expect(port.listProviders()).resolves.toMatchObject([
      { id: "codex", models: [{ id: "gpt-5" }] },
      {
        id: "dev:zai-glm", label: "GLM (Z.ai)",
        models: [
          { id: "glm-5.3", label: "GLM 5.3", isDefault: true },
          { id: "glm-5.3-air", label: "GLM 5.3 Air", isDefault: false },
        ],
      },
    ]);
  });

  test("an invalid config file never fails the agent catalog", async () => {
    await writeConfig({ version: 1, providers: [{ id: "broken" }] });
    const port = new PaseoMeetingChatAgentPort(fakePaseo(), "/tmp/irrelevant-execution-root");
    const controls = await port.getControls(null);
    expect(controls.catalogError).toBeNull();
    expect(controls.catalog.providers.map((provider) => provider.id)).toEqual(["codex"]);
    await expect(port.listProviders()).resolves.toMatchObject([{ id: "codex" }]);
  });

  test("a dev selection with agent-style controls is repaired against the catalog", async () => {
    await writeConfig(VALID_CONFIG);
    const port = new PaseoMeetingChatAgentPort(fakePaseo(), "/tmp/irrelevant-execution-root");
    await expect(port.validateSelection({
      provider: "dev:zai-glm", model: "glm-5.3", modeId: "worker", thinkingOptionId: "high", featureValues: {},
    })).rejects.toThrow(/no longer available|selection/iu);
    await expect(port.validateSelection({
      provider: "dev:zai-glm", model: "not-declared", modeId: null, thinkingOptionId: null, featureValues: {},
    })).rejects.toThrow(/no longer available|selection/iu);
  });
});

describe("dev chat provider turn runner", () => {
  test("runs a grounded answer with validated citations through the shared retrieval channel", async () => {
    await writeConfig(VALID_CONFIG);
    const provider = (await loadDevChatProviders(configPath))[0]!;
    const fetchImpl = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        outcome: "supported", text: "The team chose local-first.", citationSegmentIds: ["segment-1", "segment-2"],
      }) } }],
    }));
    const recordRetrieved = vi.fn(async () => undefined);
    const answer = await runDevProviderTurn(executionInput({ recordRetrieved }), provider, { fetchImpl });

    expect(answer).toEqual({
      outcome: "supported", text: "The team chose local-first.", citationSegmentIds: ["segment-1", "segment-2"],
    });
    expect(recordRetrieved).toHaveBeenCalledTimes(1);
    expect(recordRetrieved).toHaveBeenCalledWith(["segment-1", "segment-2"]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer dev-secret-key" });
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("glm-5.3");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]!.role).toBe("system");
    const prompt = body.messages[1]!.content;
    expect(prompt).toContain("[segment-1] 0:00-0:01 The team chose local-first.");
    expect(prompt).toContain("[segment-2] 0:01-0:02 Second segment.");
    expect(prompt).toContain("user: What did we choose?");
  });

  test("degrades a hallucinated segment citation to insufficient evidence without recording retrieval", async () => {
    await writeConfig(VALID_CONFIG);
    const provider = (await loadDevChatProviders(configPath))[0]!;
    const fetchImpl = vi.fn(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify({
        outcome: "supported", text: "Looks true", citationSegmentIds: ["segment-1", "segment-9"],
      }) } }],
    }));
    const recordRetrieved = vi.fn(async () => undefined);
    const answer = await runDevProviderTurn(executionInput({ recordRetrieved }), provider, { fetchImpl });
    expect(answer).toEqual({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] });
    expect(recordRetrieved).not.toHaveBeenCalled();
  });

  test("an explicit insufficient answer and a fenced answer both parse", async () => {
    await writeConfig(VALID_CONFIG);
    const provider = (await loadDevChatProviders(configPath))[0]!;
    const recordRetrieved = vi.fn(async () => undefined);
    const answer = await runDevProviderTurn(executionInput({ recordRetrieved }), provider, {
      fetchImpl: vi.fn(async () => jsonResponse({
        choices: [{ message: { content: "```json\n{\"outcome\":\"insufficient_evidence\",\"text\":null,\"citationSegmentIds\":[]}\n```" } }],
      })),
    });
    expect(answer).toEqual({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] });
    expect(recordRetrieved).not.toHaveBeenCalled();
    expect(parseDevProviderAnswer('  {"outcome":"insufficient_evidence","text":null,"citationSegmentIds":[]}  '))
      .toEqual({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] });
  });

  test.each([
    ["http error", vi.fn(async () => new Response("upstream exploded", { status: 502 }))],
    ["unparseable answer", vi.fn(async () => jsonResponse({ choices: [{ message: { content: "the answer is yes" } }] }))],
    ["schema violation", vi.fn(async () => jsonResponse({ choices: [{ message: { content: "{\"outcome\":\"supported\",\"text\":\"x\",\"citationSegmentIds\":[]}" } }] }))],
    ["empty content", vi.fn(async () => jsonResponse({ choices: [{ message: { content: null } }] }))],
    ["network failure", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); })],
  ])("turns %s into an operational failure", async (_name, fetchImpl) => {
    await writeConfig(VALID_CONFIG);
    const provider = (await loadDevChatProviders(configPath))[0]!;
    await expect(runDevProviderTurn(executionInput(), provider, { fetchImpl })).rejects.toThrow(
      /HTTP 502|schema validation|no answer content|request failed|unparseable/iu,
    );
  });

  test("refuses a model the provider does not declare", async () => {
    await writeConfig(VALID_CONFIG);
    const provider = (await loadDevChatProviders(configPath))[0]!;
    await expect(runDevProviderTurn(executionInput({ model: "gpt-4o" }), provider, {
      fetchImpl: vi.fn(async () => { throw new Error("fetch must not be called"); }),
    })).rejects.toThrow(/does not declare model: gpt-4o/u);
  });
});

describe("dev chat provider selection wiring", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("askWithSelection routes a dev selection through the built-in turn, never the agent runtime", async () => {
    await writeConfig(VALID_CONFIG);
    stubFetchAnswer();
    const store = fakeStore();
    const paseo = fakePaseo();
    const openSpy = vi.spyOn(paseo.workspaces, "open");
    openSpy.mockImplementation(async () => {
      throw new Error("the Paseo agent runtime must not be used for dev providers");
    });
    const port = new PaseoMeetingChatAgentPort(paseo as never, "/tmp/irrelevant-execution-root");
    const service = new MeetingChatService(store.port, port);
    const selection: ChatSelection = {
      provider: "dev:zai-glm", model: "glm-5.3", modeId: null, thinkingOptionId: null, featureValues: {},
    };

    await service.askWithSelection({ meetingId: "meeting-1", question: "What did we choose?", selection });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("ready"));

    expect(openSpy).not.toHaveBeenCalled();
    const completed = await service.get("meeting-1");
    expect(completed?.messages.at(-1)).toMatchObject({
      outcome: "supported", text: "The team chose local-first.",
      citations: [{ meetingId: "meeting-1", segmentId: "segment-1" }],
    });
    expect(completed?.selection).toEqual({ provider: "dev:zai-glm", model: "glm-5.3" });
  });

  test("the legacy ask path with a dev provider id also uses the built-in turn", async () => {
    await writeConfig(VALID_CONFIG);
    stubFetchAnswer();
    const store = fakeStore();
    const paseo = fakePaseo();
    vi.spyOn(paseo.workspaces, "open").mockImplementation(async () => {
      throw new Error("the Paseo agent runtime must not be used for dev providers");
    });
    const service = new MeetingChatService(store.port, new PaseoMeetingChatAgentPort(paseo as never, "/tmp/irrelevant-execution-root"));
    await service.ask({ meetingId: "meeting-1", question: "What did we choose?", provider: "dev:zai-glm", model: "glm-5.3" });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("ready"));
    expect((await service.get("meeting-1"))?.messages.at(-1)).toMatchObject({ outcome: "supported" });
  });

  test("a provider removed from the config after selection fails as a retryable operational failure", async () => {
    await writeConfig({ version: 1, providers: [] });
    stubFetchAnswer();
    const store = fakeStore();
    const service = new MeetingChatService(
      store.port,
      new PaseoMeetingChatAgentPort(fakePaseo() as never, "/tmp/irrelevant-execution-root"),
    );
    await service.ask({ meetingId: "meeting-1", question: "Question", provider: "dev:zai-glm", model: "glm-5.3" });
    await vi.waitFor(async () => expect((await service.get("meeting-1"))?.status).toBe("failed"));
    expect((await service.get("meeting-1"))?.failure).toEqual({
      message: "Meeting chat could not complete. Retry is available.", retryable: true,
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

/** Grounded stub for the wiring tests: cites segment-1 from the fixture transcript. */
function stubFetchAnswer(): void {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
    choices: [{ message: { content: JSON.stringify({
      outcome: "supported", text: "The team chose local-first.", citationSegmentIds: ["segment-1"],
    }) } }],
  })));
}

function executionInput(overrides: Partial<ChatExecutionInput> = {}): ChatExecutionInput {
  return {
    provider: "dev:zai-glm",
    model: "glm-5.3",
    messages: [{ role: "user", text: "What did we choose?" }],
    transcript: transcript(),
    recordRetrieved: async () => undefined,
    ...overrides,
  };
}

function transcript(): TranscriptState {
  const first = { ordinal: 0, startMs: 0, endMs: 1_000, segmentId: "segment-1" };
  const second = { ordinal: 1, startMs: 1_000, endMs: 2_000, segmentId: "segment-2" };
  const checkpoint = (range: typeof first) => ({
    range, attempts: 1, text: range.segmentId === "segment-1" ? "The team chose local-first." : "Second segment.",
    usage: null, detectedLanguages: ["en"], completedAt: "2026-08-21T00:00:00.000Z",
  });
  return {
    id: "transcript-1", meetingId: "meeting-1", recordingId: "recording-1", status: "ready",
    plannerVersion: "m3-range-v1", audio: { destination: "meetings/audio.mp3", byteLength: 100, sha256: "sha", durationMs: 2_000 },
    ranges: [first, second], checkpoints: [checkpoint(first), checkpoint(second)],
    requestCount: 1, activeRequest: null, usage: null, detectedLanguages: ["en"], failureReason: null,
    publication: { storageKey: "transcripts/transcript-1.json", digest: "digest", publishedAt: "2026-08-21T00:00:00.000Z" },
    createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

function fakePaseo() {
  return {
    providers: {
      waitForReady: async () => ({ entries: [{
        provider: "codex", enabled: true, status: "ready", label: "Codex",
        models: [{ provider: "codex", id: "gpt-5", label: "GPT-5", isDefault: true }],
      }] }),
    },
    workspaces: {
      open: vi.fn(async () => ({
        archive: async () => ({ archivedAt: new Date().toISOString(), error: null }),
        agents: {
          create: vi.fn(async () => ({
            waitForFinish: async () => ({
              status: "idle" as const, final: null, error: null,
              lastMessage: JSON.stringify({ outcome: "insufficient_evidence", text: null, citationSegmentIds: [] }),
            }),
            archive: async () => ({ archivedAt: new Date().toISOString() }),
          })),
        },
      })),
    },
    config: { get: async () => ({ requestId: "profiles-request", config: { agentProfiles: [] } }) },
  };
}

function fakeStore() {
  const state: {
    thread: MeetingChatThread | null;
    selection: ChatSelection | null;
    sequence: number;
    port: MeetingStore;
  } = { thread: createMeetingChatThread({ id: "thread-1", meetingId: "meeting-1", now: "2026-08-21T00:00:00.000Z" }), selection: null, sequence: 0, port: null as never };
  const available = transcript().checkpoints.map((checkpoint) => checkpoint.range.segmentId);
  state.port = {
    listChatThreads: async () => state.thread ? [state.thread] : [],
    reconcileChatAfterRestart: async () => state.thread ? [state.thread] : [],
    getChatThread: async () => state.thread,
    getTranscriptForMeeting: async () => transcript(),
    getChatSelection: async () => state.selection,
    setChatSelection: async (selection: ChatSelection) => {
      state.selection = selection;
      return selection;
    },
    startChatQuestion: async (input: any) => {
      state.thread = startChatQuestion(state.thread!, {
        ...input, userMessageId: `user-${++state.sequence}`, attemptId: `attempt-${state.sequence}`,
        now: "2026-08-21T00:02:00.000Z",
      });
      return state.thread;
    },
    startChatQuestionWithSelection: async (input: any) => {
      state.selection = input.selection;
      state.thread = startChatQuestion(state.thread!, {
        ...input, userMessageId: `user-${++state.sequence}`, attemptId: `attempt-${state.sequence}`,
        now: "2026-08-21T00:02:00.000Z",
      });
      return state.thread;
    },
    recordChatRetrieval: async (_meetingId: string, attemptId: string, segmentIds: string[]) => {
      const { recordChatRetrieval } = await import("@meetless/meeting-domain");
      state.thread = recordChatRetrieval(state.thread!, {
        attemptId, segmentIds, availableSegmentIds: available, now: "2026-08-21T00:03:00.000Z",
      });
      return state.thread;
    },
    completeChatTurn: async (_meetingId: string, input: any) => {
      state.thread = completeChatAttempt(state.thread!, {
        ...input, assistantMessageId: `assistant-${++state.sequence}`,
        availableSegmentIds: available, now: "2026-08-21T00:04:00.000Z",
      });
      return state.thread;
    },
    failChatTurn: async (_meetingId: string, attemptId: string, reason: string) => {
      const { failChatAttempt } = await import("@meetless/meeting-domain");
      state.thread = failChatAttempt(state.thread!, { attemptId, reason, now: "2026-08-21T00:04:00.000Z" });
      return state.thread;
    },
  } as unknown as MeetingStore;
  return state;
}
