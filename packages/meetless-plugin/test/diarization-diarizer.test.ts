import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkDiarizerAvailability,
  DiarizerSidecarError,
  DiarizerTimeoutError,
  DiarizerTokenMissingError,
  resolveDiarizerSidecarPaths,
  runDiarizationSidecar,
} from "../src/diarization/diarizer.js";
import { PyannoteDiarizerProvider } from "../src/diarization/pyannote-provider.js";

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

/**
 * Fake sidecar: a Node module honouring the pinned sidecar contract — argv
 * --audio/--out/--hf-token-file/--chunk-minutes, progress JSON lines on stderr,
 * DIARIZE_TOKEN_MISSING / DIARIZE_ERROR markers, and rc 0/2/3. The `behavior`
 * binding is prepended by the caller.
 */
const FAKE_SIDECAR_BODY = `
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const out = flag("--out");
const audio = flag("--audio");
const fail = (code, message) => { process.stderr.write(message + "\\n"); process.exit(code); };
if (behavior !== "token" && !audio) fail(3, "DIARIZE_ERROR: missing --audio");
if (behavior === "token") fail(2, "DIARIZE_TOKEN_MISSING");
if (behavior === "error") fail(3, "DIARIZE_ERROR: model khong tai duoc");
if (behavior === "hang") {
  process.stderr.write(JSON.stringify({ progress: 0.1 }) + "\\n");
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(JSON.stringify({ progress: 0 }) + "\\n");
  process.stderr.write(JSON.stringify({ progress: 0.5 }) + "\\n");
  writeFileSync(out, JSON.stringify({
    turns: [
      { speaker: "S1", startMs: 0, endMs: 1500 },
      { speaker: "S2", startMs: 1500, endMs: 3000 },
    ],
  }, null, 2));
  process.stderr.write(JSON.stringify({ progress: 1 }) + "\\n");
}
`;

async function fakeSidecar(root: string, behavior: "ok" | "token" | "error" | "hang", withToken: boolean) {
  const toolsRoot = path.join(root, "tools", "pyannote");
  await mkdir(path.join(toolsRoot, "bin"), { recursive: true });
  // The "python" is node itself; the "script" is the fake sidecar module.
  const pythonPath = path.join(toolsRoot, "bin", "python");
  await writeFile(pythonPath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  await chmod(pythonPath, 0o755);
  const script = path.join(root, "diarize-fake.cjs");
  await writeFile(script, `const behavior = ${JSON.stringify(behavior)};${FAKE_SIDECAR_BODY}`, { mode: 0o644 });
  if (withToken) await writeFile(path.join(toolsRoot, "hf-token"), "hf_token_value\n", { mode: 0o600 });
  return { python: pythonPath, script, tokenFile: path.join(toolsRoot, "hf-token") };
}

describe("diarizer sidecar runner", () => {
  test("parses turns and streams progress lines on rc 0", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarizer-ok-"));
    roots.add(root);
    const paths = await fakeSidecar(root, "ok", true);
    const progress: number[] = [];
    const turns = await runDiarizationSidecar({
      paths,
      audio: path.join(root, "system.wav"),
      onProgress: (fraction) => progress.push(fraction),
    });
    expect(turns).toEqual([
      { speaker: "S1", startMs: 0, endMs: 1_500 },
      { speaker: "S2", startMs: 1_500, endMs: 3_000 },
    ]);
    expect(progress).toEqual([0, 0.5, 1]);
  });

  test("maps rc 2 with the token marker to the token-missing failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarizer-token-"));
    roots.add(root);
    const paths = await fakeSidecar(root, "token", false);
    await expect(runDiarizationSidecar({ paths, audio: path.join(root, "system.wav") }))
      .rejects.toBeInstanceOf(DiarizerTokenMissingError);
  });

  test("surfaces the DIARIZE_ERROR message on rc 3", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarizer-error-"));
    roots.add(root);
    const paths = await fakeSidecar(root, "error", true);
    const failure = runDiarizationSidecar({ paths, audio: path.join(root, "system.wav") });
    await expect(failure).rejects.toBeInstanceOf(DiarizerSidecarError);
    await expect(failure).rejects.not.toBeInstanceOf(DiarizerTokenMissingError);
    await expect(failure).rejects.toThrow("model khong tai duoc");
  });

  test("times a hanging sidecar out with SIGTERM and rejects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarizer-hang-"));
    roots.add(root);
    const paths = await fakeSidecar(root, "hang", true);
    const started = Date.now();
    await expect(runDiarizationSidecar({
      paths,
      audio: path.join(root, "system.wav"),
      timeoutMs: 800,
      killGraceMs: 400,
    })).rejects.toBeInstanceOf(DiarizerTimeoutError);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("diarizer availability", () => {
  test("reports ok only when venv python, sidecar, and token exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarizer-available-"));
    roots.add(root);
    const paths = await fakeSidecar(root, "ok", true);
    await expect(checkDiarizerAvailability(paths)).resolves.toEqual({ ok: true });

    const withoutToken = await fakeSidecar(path.join(root, "b"), "ok", false);
    await expect(checkDiarizerAvailability(withoutToken)).resolves.toEqual({ ok: false, reason: "token_missing" });

    await rm(paths.python, { force: true });
    await expect(checkDiarizerAvailability(paths)).resolves.toEqual({ ok: false, reason: "not_installed" });
  });

  test("resolves explicit overrides ahead of env and defaults", () => {
    const resolved = resolveDiarizerSidecarPaths({ python: "/explicit/python", tokenFile: "/explicit/token" });
    expect(resolved.python).toBe("/explicit/python");
    expect(resolved.tokenFile).toBe("/explicit/token");
    expect(path.isAbsolute(resolved.script)).toBe(true);
    expect(resolved.script.endsWith(path.join("scripts", "linux", "pyannote", "diarize.py"))).toBe(true);
  });
});

describe("pyannote provider", () => {
  test("delegates availability and runs through the sidecar", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meetless-diarizer-provider-"));
    roots.add(root);
    const sidecar = await fakeSidecar(root, "ok", true);
    const provider = new PyannoteDiarizerProvider(sidecar);
    await expect(provider.available()).resolves.toEqual({ ok: true });
    const progress: number[] = [];
    await expect(provider.run(path.join(root, "system.wav"), (fraction) => progress.push(fraction)))
      .resolves.toHaveLength(2);
    expect(progress).toEqual([0, 0.5, 1]);
  });
});
