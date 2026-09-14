import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, constants, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SpeakerTurn } from "./attribution.js";

/**
 * Speaker diarization stage B3: spawn the pyannote sidecar
 * (scripts/linux/pyannote/diarize.py) inside its uv-managed venv and parse its
 * turns JSON. The sidecar contract is pinned by its own tests: rc 0 ok,
 * rc 2 token missing (stderr DIARIZE_TOKEN_MISSING), rc 3 error
 * (stderr DIARIZE_ERROR: <msg>), and one {"progress":0..1} JSON per stderr line.
 */

export type DiarizerTurn = SpeakerTurn;

export type DiarizerUnavailableReason = "not_installed" | "token_missing";

export interface DiarizerAvailability {
  readonly ok: boolean;
  readonly reason?: DiarizerUnavailableReason;
}

export function diarizerAvailable(ok: true): DiarizerAvailability;
export function diarizerAvailable(reason: DiarizerUnavailableReason): DiarizerAvailability;
export function diarizerAvailable(value: true | DiarizerUnavailableReason): DiarizerAvailability {
  return value === true ? { ok: true } : { ok: false, reason: value };
}

/** The provider seam consumed by the meeting diarization service. */
export interface DiarizerProvider {
  available(): Promise<DiarizerAvailability>;
  run(systemWav: string, onProgress?: (fraction: number) => void): Promise<DiarizerTurn[]>;
}

export class DiarizerSidecarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiarizerSidecarError";
  }
}

export class DiarizerTokenMissingError extends DiarizerSidecarError {
  constructor(message = "Diarization HF token is missing") {
    super(message);
    this.name = "DiarizerTokenMissingError";
  }
}

export class DiarizerTimeoutError extends DiarizerSidecarError {
  constructor(timeoutMs: number) {
    super(`Diarization sidecar exceeded its ${timeoutMs}ms budget`);
    this.name = "DiarizerTimeoutError";
  }
}

export interface DiarizerSidecarPaths {
  /** venv python executable (defaults to the uv installer location). */
  readonly python: string;
  /** Sidecar script path (defaults to the repository checkout). */
  readonly script: string;
  /** HF token file passed via --hf-token-file. */
  readonly tokenFile: string;
}

export interface DiarizerSidecarPathOverrides extends Partial<DiarizerSidecarPaths> {
  /** Installer root that derives python (bin/python) and token (hf-token). */
  readonly toolsRoot?: string;
}

const SIDECAR_RELATIVE_PATH = path.join("scripts", "linux", "pyannote", "diarize.py");
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Resolve the sidecar paths: explicit overrides win, then MEETLESS_DIARIZATION_*
 * environment variables, then the installer-fixed defaults
 * (~/.local/share/meetless/tools/pyannote for python/token and the repository
 * checkout for the script). The repository root is found by walking up from
 * this module to the directory that actually contains the sidecar script, so
 * both the src and dist module layouts resolve identically.
 */
export function resolveDiarizerSidecarPaths(
  overrides?: DiarizerSidecarPathOverrides,
): DiarizerSidecarPaths {
  const toolsRoot = overrides?.toolsRoot ??
    process.env.MEETLESS_DIARIZATION_TOOLS_ROOT?.trim() ??
    path.join(os.homedir(), ".local/share/meetless/tools/pyannote");
  return {
    python: overrides?.python ??
      process.env.MEETLESS_DIARIZATION_PYTHON?.trim() ??
      path.join(toolsRoot, "bin", "python"),
    script: overrides?.script ??
      process.env.MEETLESS_DIARIZATION_SIDECAR?.trim() ??
      defaultSidecarScriptPath(),
    tokenFile: overrides?.tokenFile ??
      process.env.MEETLESS_DIARIZATION_TOKEN_FILE?.trim() ??
      path.join(toolsRoot, "hf-token"),
  };
}

function defaultSidecarScriptPath(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, SIDECAR_RELATIVE_PATH);
    // The bounded upward walk covers both the src and dist module layouts.
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..", SIDECAR_RELATIVE_PATH);
}

/**
 * Availability probe: the venv python and sidecar script must exist
 * (not_installed otherwise — including every non-linux platform, where the
 * uv installer never ran), then the token file must carry a non-empty first
 * line (token_missing otherwise). Never throws.
 */
export async function checkDiarizerAvailability(
  paths: DiarizerSidecarPaths = resolveDiarizerSidecarPaths(),
): Promise<DiarizerAvailability> {
  if (process.platform !== "linux") return diarizerAvailable("not_installed");
  try {
    await Promise.all([
      access(paths.python, constants.X_OK),
      access(paths.script, constants.R_OK),
    ]);
  } catch {
    return diarizerAvailable("not_installed");
  }
  try {
    const contents = await readFile(paths.tokenFile, "utf8");
    if (contents.split("\n").some((line) => line.trim())) return diarizerAvailable(true);
  } catch {
    // fall through to token_missing
  }
  return diarizerAvailable("token_missing");
}

const TurnsFileSchema = z.object({
  turns: z.array(z.object({
    speaker: z.string().trim().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  }).strict()),
}).strict();

export interface RunDiarizationSidecarOptions {
  readonly paths: DiarizerSidecarPaths;
  readonly audio: string;
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly chunkMinutes?: number;
  readonly onProgress?: (fraction: number) => void;
}

/** Spawn the sidecar, stream progress, enforce the timeout (SIGTERM → SIGKILL), and parse turns. */
export async function runDiarizationSidecar(options: RunDiarizationSidecarOptions): Promise<DiarizerTurn[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const chunkMinutes = options.chunkMinutes ?? 15;
  const staging = await mkdtemp(path.join(os.tmpdir(), "meetless-diarization-"));
  const outPath = path.join(staging, `turns-${randomUUID()}.json`);
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
      const child = spawn(
        options.paths.python,
        [
          options.paths.script,
          "--audio", options.audio,
          "--out", outPath,
          "--hf-token-file", options.paths.tokenFile,
          "--chunk-minutes", String(chunkMinutes),
        ],
        { stdio: ["ignore", "ignore", "pipe"], env: process.env },
      );
      let stderr = "";
      let stderrTail = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.once("exit", () => {
          if (!settled) {
            settled = true;
            reject(new DiarizerTimeoutError(timeoutMs));
          }
        });
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
        killTimer.unref();
      }, timeoutMs);
      timer.unref();
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-16 * 1024);
        stderrTail += chunk.toString("utf8");
        const lines = stderrTail.split(/\r?\n/u);
        stderrTail = lines.pop() ?? "";
        for (const line of lines) {
          const progress = parseProgressLine(line);
          if (progress !== null) options.onProgress?.(progress);
        }
      });
      child.on("error", (error) => {
        settled = true;
        clearTimeout(timer);
        reject(new DiarizerSidecarError(`Diarization sidecar could not start: ${describe(error)}`));
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stderr });
      });
    });
    // `await`, not a bare return: the finally-cleanup below runs before the
    // outer promise adopts this one, and a rejection during that window would
    // surface as an unhandled rejection before reaching the caller's catch.
    if (exit.code === 0) return await parseTurnsFile(outPath);
    if (exit.code === 2 || exit.stderr.includes("DIARIZE_TOKEN_MISSING")) {
      throw new DiarizerTokenMissingError("Diarization HF token is missing; run npm run diarization:install");
    }
    if (exit.code !== null) {
      throw new DiarizerSidecarError(sidecarFailureMessage(exit.stderr) ?? `Diarization sidecar exited with code ${exit.code}`);
    }
    throw new DiarizerSidecarError(`Diarization sidecar terminated by ${exit.signal ?? "an unknown signal"}`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseProgressLine(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const decoded: unknown = JSON.parse(trimmed);
    if (decoded && typeof decoded === "object" && typeof (decoded as { progress?: unknown }).progress === "number") {
      return Math.min(1, Math.max(0, (decoded as { progress: number }).progress));
    }
  } catch {
    return null;
  }
  return null;
}

function sidecarFailureMessage(stderr: string): string | null {
  const match = /^DIARIZE_ERROR:\s*(.+)$/mu.exec(stderr.trim());
  return match ? match[1]!.trim() : null;
}

async function parseTurnsFile(outPath: string): Promise<DiarizerTurn[]> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(outPath, "utf8"));
  } catch {
    throw new DiarizerSidecarError("Diarization sidecar output is not valid JSON");
  }
  const parsed = TurnsFileSchema.safeParse(decoded);
  if (!parsed.success) throw new DiarizerSidecarError("Diarization sidecar output does not match the turns contract");
  for (let index = 1; index < parsed.data.turns.length; index += 1) {
    const previous = parsed.data.turns[index - 1]!;
    const current = parsed.data.turns[index]!;
    if (previous.endMs > current.startMs) {
      throw new DiarizerSidecarError("Diarization sidecar turns overlap after merging");
    }
  }
  return parsed.data.turns.map((turn: DiarizerTurn) => ({ ...turn }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
