import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ChatControlProviderWire } from "@meetless/meeting-contracts";
import type { AgentAnswer, ChatExecutionInput, ChatProviderOption } from "./chat-service.js";
import { z } from "zod";

/**
 * Phase C1 — developer-configured OpenAI-compatible chat providers.
 *
 * Optional file `~/.local/share/meetless/chat-providers.json` (override with
 * MEETLESS_DEV_CHAT_PROVIDERS) declares direct LLM endpoints that appear in the
 * SAME meeting-chat controls catalog as codex/claude/opencode under the ids
 * `dev:<providerId>`. Because these are agent-less endpoints, they cannot use
 * the MCP retrieval loop; instead their single turn inlines the immutable ready
 * transcript in the prompt and enforces the SAME answer contract: strict JSON
 * {outcome:"supported",text,citationSegmentIds} | insufficient_evidence, where
 * every cited segment id must exist in that transcript (hallucinated ids
 * degrade the whole answer to insufficient_evidence). Valid citations are
 * recorded through the same recordRetrieved channel, so the store's
 * same-run-retrieval gate stays truthful.
 *
 * Darwin is untouched by construction: the file simply does not exist there,
 * so no dev providers are appended to any catalog or provider list.
 */

export const DEV_CHAT_PROVIDER_PREFIX = "dev:";

/** Recommended file mode is 0600 (same as BYOK keys); not enforced on read. */
export const DEV_CHAT_PROVIDERS_FILENAME = "chat-providers.json";

const DevChatModelSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
}).strict();

const DevChatProviderSchema = z.object({
  /** Must stay routing-safe after the `dev:` prefix (no separators/colons). */
  id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().url().regex(/^https?:\/\//u),
  /** Read at request time; never projected into any catalog or wire. */
  apiKey: z.string().min(1),
  models: z.array(DevChatModelSchema).min(1),
}).strict();

const DevChatProvidersFileSchema = z.object({
  version: z.literal(1),
  providers: z.array(DevChatProviderSchema),
}).strict();

export interface DevChatProviderConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<{ id: string; label: string }>;
}

export interface DevChatTurnDeps {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function isDevChatProvider(providerId: string): boolean {
  return providerId.startsWith(DEV_CHAT_PROVIDER_PREFIX);
}

export function devChatProviderCatalogId(providerId: string): string {
  return `${DEV_CHAT_PROVIDER_PREFIX}${providerId}`;
}

export function resolveDevChatProvidersPath(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.MEETLESS_DEV_CHAT_PROVIDERS?.trim();
  if (override && path.isAbsolute(override)) return override;
  return path.join(homedir(), ".local", "share", "meetless", DEV_CHAT_PROVIDERS_FILENAME);
}

/**
 * Missing file → no providers (the feature is opt-in). A present-but-invalid
 * file throws with a descriptive message so operators can fix it; callers that
 * must never hard-fail (catalog reads) use loadDevChatProvidersSafe instead.
 */
export async function loadDevChatProviders(configPath: string): Promise<DevChatProviderConfig[]> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch {
    return [];
  }
  const parsed = DevChatProvidersFileSchema.safeParse(JSON.parse(contents));
  if (!parsed.success) {
    throw new Error(`Dev chat providers file is invalid (${configPath}): ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`);
  }
  const seen = new Set<string>();
  for (const provider of parsed.data.providers) {
    if (seen.has(devChatProviderCatalogId(provider.id))) {
      throw new Error(`Dev chat providers file declares duplicate provider id: ${provider.id}`);
    }
    seen.add(devChatProviderCatalogId(provider.id));
  }
  return parsed.data.providers.map((provider) => ({ ...provider, models: provider.models.map((model) => ({ ...model })) }));
}

/** Catalog-facing variant: a broken file degrades to "no dev providers" instead of failing chat controls. */
export async function loadDevChatProvidersSafe(configPath: string): Promise<DevChatProviderConfig[]> {
  try {
    return await loadDevChatProviders(configPath);
  } catch (error) {
    console.error("[meetless-chat] dev chat providers config ignored:", error);
    return [];
  }
}

/** Catalog projection appended beside codex/claude/opencode in the SAME picker. */
export function devChatProviderControls(providers: readonly DevChatProviderConfig[]): ChatControlProviderWire[] {
  return providers.map((provider) => ({
    id: devChatProviderCatalogId(provider.id),
    label: provider.name,
    status: "ready",
    models: provider.models.map((model, index) => ({
      id: model.id,
      label: model.label,
      isDefault: index === 0,
      thinkingOptions: [],
      defaultThinkingOptionId: null,
    })),
    modes: [],
    defaultModeId: null,
    error: null,
  }));
}

/** Legacy flat provider list projection (same shape as the agent providers). */
export function devChatProviderOptions(providers: readonly DevChatProviderConfig[]): ChatProviderOption[] {
  return providers.map((provider) => ({
    id: devChatProviderCatalogId(provider.id),
    label: provider.name,
    models: provider.models.map((model, index) => ({
      id: model.id,
      label: model.label,
      isDefault: index === 0,
    })),
  }));
}

export function findDevChatProvider(
  providers: readonly DevChatProviderConfig[],
  catalogProviderId: string,
): DevChatProviderConfig | null {
  if (!isDevChatProvider(catalogProviderId)) return null;
  const providerId = catalogProviderId.slice(DEV_CHAT_PROVIDER_PREFIX.length);
  return providers.find((provider) => provider.id === providerId) ?? null;
}

/**
 * Mirrors chat-service's private AgentAnswerSchema exactly. The
 * `satisfies`-style structural assignment onto AgentAnswer in the runner makes
 * tsc fail if the two shapes ever drift.
 */
const DevProviderAnswerSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("supported"),
    text: z.string().trim().min(1),
    citationSegmentIds: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  z.object({
    outcome: z.literal("insufficient_evidence"),
    text: z.null(),
    citationSegmentIds: z.array(z.never()).length(0),
  }).strict(),
]);

export function parseDevProviderAnswer(raw: string): AgentAnswer {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  return DevProviderAnswerSchema.parse(JSON.parse(stripped));
}

/**
 * Minimal built-in turn runner for agent-less OpenAI-compatible endpoints:
 * system prompt + inlined transcript + strict JSON output. The API key is read
 * from the freshly loaded config at request time only. Non-2xx responses and
 * unparseable replies throw (the chat service maps that to the retryable
 * operational failure, same as the agent path).
 */
export async function runDevProviderTurn(
  input: ChatExecutionInput,
  provider: DevChatProviderConfig,
  deps: DevChatTurnDeps = {},
): Promise<AgentAnswer> {
  const model = provider.models.find((candidate) => candidate.id === input.model);
  if (!model) {
    throw new Error(`Dev chat provider ${provider.id} does not declare model: ${input.model}`);
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? chatTurnTimeoutMs();
  const base = provider.baseUrl.replace(/\/+$/u, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: DEV_PROVIDER_SYSTEM_PROMPT },
          { role: "user", content: buildDevProviderPrompt(input) },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Dev chat provider request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Dev chat provider responded with HTTP ${response.status}`);
  }
  let content: unknown;
  try {
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    content = body.choices?.[0]?.message?.content;
  } catch (error) {
    throw new Error(`Dev chat provider returned an unparseable response body: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Dev chat provider returned no answer content");
  }
  let answer: AgentAnswer;
  try {
    answer = parseDevProviderAnswer(content);
  } catch (error) {
    throw new Error(`Dev chat provider answer failed schema validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (answer.outcome !== "supported") return answer;
  // Same rule as MCP answers: cited ids must exist in this transcript. A
  // hallucinated id means the model could not ground its answer — degrade the
  // whole turn to the explicit insufficient-evidence form.
  const known = new Set(input.transcript.checkpoints.map((checkpoint) => checkpoint.range.segmentId));
  if (answer.citationSegmentIds.some((segmentId) => !known.has(segmentId))) {
    return { outcome: "insufficient_evidence", text: null, citationSegmentIds: [] };
  }
  // The transcript was inlined this turn, so the cited segments count as
  // retrieved through the same channel the MCP tools use.
  await input.recordRetrieved(answer.citationSegmentIds);
  return answer;
}

const DEV_PROVIDER_SYSTEM_PROMPT = [
  "You are the Meetless meeting assistant.",
  "The transcript excerpt in the prompt is the only evidence authority.",
  "Do not use filesystem, shell, web, workspace, or external knowledge.",
  "A supported answer needs at least one exact segment citation from the excerpt.",
].join(" ");

export function buildDevProviderPrompt(input: ChatExecutionInput): string {
  return [
    "Answer the newest user question using only the transcript below.",
    'Supported form: {"outcome":"supported","text":"answer","citationSegmentIds":["segment-id-from-the-transcript"]}.',
    'Insufficient form: {"outcome":"insufficient_evidence","text":null,"citationSegmentIds":[]}.',
    "Return exactly one JSON object matching one of those forms. Do not use Markdown or code fences.",
    "Cite only segment IDs that appear in the transcript below.",
    "Transcript:",
    ...input.transcript.checkpoints.map((checkpoint) =>
      `[${checkpoint.range.segmentId}] ${formatMs(checkpoint.range.startMs)}-${formatMs(checkpoint.range.endMs)} ${checkpoint.text}`),
    "Conversation:",
    ...input.messages.map((message) => `${message.role}: ${message.text}`),
  ].join("\n");
}

function chatTurnTimeoutMs(): number {
  const configured = Number(process.env.MEETLESS_CHAT_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 180_000;
}

function formatMs(value: number): string {
  const totalSeconds = Math.floor(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = `${totalSeconds % 60}`.padStart(2, "0");
  return `${minutes}:${seconds}`;
}
