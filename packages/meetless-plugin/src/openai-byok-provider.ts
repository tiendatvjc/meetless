import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TranscriptionProvider, TranscriptionProviderStatus, TranscriptionRequest, TranscriptionResult } from "./transcription-provider.js";
import {
  OPENAI_TRANSCRIPTION_ENDPOINT,
  OPENAI_TRANSCRIPTION_LANGUAGES,
  OPENAI_TRANSCRIPTION_MODEL,
} from "./transcription-provider.js";

export interface ByokKeyFile { version: 1; apiKey: string }

/**
 * Reads the user-supplied OpenAI key from a versioned local file. A missing,
 * malformed, or empty key is reported as null so callers can treat BYOK as
 * simply not configured; key material is never logged.
 */
export async function readByokKey(
  configPath: string,
  read: (path: string) => Promise<string> = (target) => readFile(target, "utf8"),
): Promise<string | null> {
  let raw: string;
  try {
    raw = await read(configPath);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ByokKeyFile>;
    if (parsed.version !== 1 || typeof parsed.apiKey !== "string") return null;
    const key = parsed.apiKey.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export interface OpenAiByokTranscriptionProviderOptions {
  configPath: string;
  fetchImpl?: typeof fetch;
  /** Injectable key-file reader; defaults to readByokKey over configPath. */
  readKey?: (path: string) => Promise<string | null>;
}

/** Bring-your-own-key OpenAI transcription; free per docs/product/monetization.md. */
export class OpenAiByokTranscriptionProvider implements TranscriptionProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly readKey: (path: string) => Promise<string | null>;

  constructor(private readonly options: OpenAiByokTranscriptionProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.readKey = options.readKey ?? ((configPath: string) => readByokKey(configPath));
  }

  private key(): Promise<string | null> {
    return this.readKey(this.options.configPath);
  }

  async status(): Promise<TranscriptionProviderStatus> {
    return (await this.key()) !== null ? "configured" : "missing";
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const key = await this.key();
    if (!key) throw new Error("BYOK transcription is not configured: missing API key");
    const body = new FormData();
    const filename = path.basename(request.audioPath) || "audio.wav";
    body.append("file", new Blob([await readFile(request.audioPath)], { type: audioMimeTypeFor(request.audioPath) }), filename);
    body.append("model", OPENAI_TRANSCRIPTION_MODEL);
    body.append("response_format", "json");
    const response = await this.fetchImpl(OPENAI_TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body,
    });
    if (response.status === 401) throw new Error("BYOK transcription rejected the configured API key");
    if (!response.ok) throw new Error(`BYOK transcription failed with HTTP ${response.status}`);
    const payload = (await response.json()) as { text?: string };
    const text = (payload.text ?? "").trim();
    if (!text) throw new Error("BYOK transcription returned empty text");
    return { text, detectedLanguages: [...OPENAI_TRANSCRIPTION_LANGUAGES], usage: null };
  }
}

function audioMimeTypeFor(audioPath: string): string {
  switch (path.extname(audioPath).toLowerCase()) {
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".ogg": return "audio/ogg";
    case ".flac": return "audio/flac";
    case ".webm": return "audio/webm";
    default: return "audio/wav";
  }
}
