/**
 * Headless end-to-end Linux port proof (Task 9,
 * .superpowers/sdd/2026-09-13-ubuntu-port/task-9-brief.md).
 *
 * Evidence culture rules obeyed here:
 * - Every ok:true claim is backed by a real assertion (validator run, ffprobe
 *   read, header check, tool-list check) against bytes on disk or a live
 *   server. Nothing is asserted from hopes.
 * - Stage 0 (daemon probe) and stage 4 (MCP) are recorded evidence, not gates:
 *   a truthful failure or skip does not fail the proof; a faked pass would.
 * - The desktop stage (Task 12) is evidence-only too: it launches the DEV
 *   desktop (`npm run runtime:desktop`) under `timeout` with a tmp runtime
 *   root and reports process lifetime + renderer-origin HTTP truthfully; with
 *   no display (DISPLAY/WAYLAND_DISPLAY/xvfb-run) it records a skip reason.
 * - All session/store/key state lives in mkdtemp tmpdirs and is removed.
 * - No secrets: the OpenAI fetch is a stub; the key file holds a fixture key.
 *
 * Exit code: 0 iff the record + finalize + transcribe stages are all ok.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDist = path.join(repoRoot, "packages/meetless-plugin/dist/src");

const { CaptureHelper } = await import(path.join(pluginDist, "capture-helper.js"));
const { validateCommittedWavChunk } = await import(path.join(pluginDist, "chunk-validator.js"));
const { Mp3Finalizer } = await import(path.join(pluginDist, "finalizer.js"));
const { RecordingInventoryReconciler } = await import(path.join(pluginDist, "inventory.js"));
const { OpenAiByokTranscriptionProvider } = await import(path.join(pluginDist, "openai-byok-provider.js"));
const { startTranscriptMcp } = await import(path.join(pluginDist, "chat-service.js"));
const { OPENAI_TRANSCRIPTION_ENDPOINT, OPENAI_TRANSCRIPTION_MODEL } = await import(
  path.join(pluginDist, "transcription-provider.js")
);
const { MeetingStore } = await import(path.join(repoRoot, "packages/meeting-store/dist/index.js"));

const linuxHelperEntry = path.join(pluginDist, "linux/capture-helper-entry.js");
const runtimeCli = path.join(repoRoot, "packages/runtime/dist/cli.js");
const TRANSCRIPT_TEXT = "xin chào bằng chứng linux port";
const BYOK_FIXTURE_KEY = "sk-linux-port-proof-fixture";
const DAEMON_LISTEN = "127.0.0.1:18081";
const DAEMON_PORT = 18081;
const DESKTOP_LISTEN = "127.0.0.1:18085";
const DESKTOP_DAEMON_PORT = 18085;
const DESKTOP_RENDERER_ORIGIN = "http://127.0.0.1:18086";
const DESKTOP_RENDERER_PORT = 18086;
const RECORD_MS = 6_000;

/** Shared plumbing between stages (record -> finalize -> transcribe). */
const context = {
  storeRoot: null,
  recordingId: null,
  validatedChunks: [],
  mp3: null,
};
const stageDetails = {};
const tmpRoots = [];
const startedAtMs = Date.now();

await main();

async function main() {
  assertPreconditions();
  const runStamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "");
  const daemon = await runStage("daemon", probeDaemon);
  const record = await runStage("record", stageRecordFixture);
  const finalize = record.ok
    ? await runStage("finalize", stageFinalizeRealFinalizer)
    : skipped("finalize", `record stage failed: ${record.error}`);
  const transcribe = record.ok
    ? await runStage("transcribe", stageTranscribeByok)
    : skipped("transcribe", `record stage failed: ${record.error}`);
  const mcp = await runStage("mcp", stageTranscriptMcp);
  const desktopDisplay = resolveDesktopDisplay();
  const desktop = desktopDisplay.available
    ? await runStage("desktop", () => stageDesktopDev(desktopDisplay))
    : skipped("desktop", `no DISPLAY/WAYLAND_DISPLAY and xvfb-run unavailable: ${desktopDisplay.reason}`);

  const gatePassed = [record, finalize, transcribe].every((entry) => entry.ok);
  const summary = {
    ok: gatePassed,
    gate: ["record", "finalize", "transcribe"],
    evidenceOnly: ["daemon", "mcp", "desktop"],
    totalRuntimeMs: Date.now() - startedAtMs,
    exitCode: gatePassed ? 0 : 1,
  };

  const manifest = {
    proof: "linux-port-headless-e2e",
    runStamp,
    startedAt: new Date(startedAtMs).toISOString(),
    host: { platform: process.platform, node: process.version },
    stages: { daemon, record, finalize, transcribe, mcp, desktop },
    details: stageDetails,
    summary,
  };

  const manifestDirectory = path.join(repoRoot, ".artifacts/linux-proof");
  await mkdir(manifestDirectory, { recursive: true });
  const manifestPath = path.join(manifestDirectory, `manifest-${runStamp}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  for (const root of [...tmpRoots]) await rmTmp(root);

  console.log(JSON.stringify({ manifest: manifestPath }));
  console.log(JSON.stringify({ summary }));
  process.exitCode = gatePassed ? 0 : 1;
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

function skipped(stage, reason) {
  const entry = { stage, ok: false, skipped: true, reason: reason.slice(0, 300) };
  console.log(JSON.stringify(entry));
  return entry;
}

/**
 * Stage 0: dev-mode daemon probe. Attempts `cli.js daemon` against a tmp
 * runtime root and waits up to 8s for the TCP listener. Either outcome is
 * evidence; a non-listening daemon is reported as ok:false with its first
 * error line, not as proof failure.
 */
async function probeDaemon() {
  const runtimeRoot = await mkdtempTmp("meetless-proof-daemon-");
  const outputLines = [];
  const child = spawn(process.execPath, [runtimeCli, "daemon"], {
    cwd: repoRoot,
    env: { ...process.env, MEETLESS_RUNTIME_ROOT: runtimeRoot, MEETLESS_LISTEN: DAEMON_LISTEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (line.trim() && outputLines.length < 40) outputLines.push(line.trim());
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let listening = false;
  let stopResult = null;
  try {
    listening = await waitForTcp(DAEMON_PORT, 8_000);
  } finally {
    stopResult = await stopChild(child);
    stageDetails.daemon = {
      listen: DAEMON_LISTEN,
      listened: listening,
      stopped: stopResult.exited,
      exit: stopResult.result,
      output: outputLines,
    };
    await rmTmp(runtimeRoot);
  }

  if (listening) return { artifact: DAEMON_LISTEN, detail: { listened: true, outputLines: outputLines.length } };
  const firstError = outputLines.find((line) => /error|cannot|denied|throw|exception|not found/iu.test(line))
    ?? outputLines[0]
    ?? "daemon never accepted TCP within 8s and produced no output";
  throw new Error(firstError.slice(0, 300));
}

/**
 * Stage 1: fixture capture through the REAL CaptureHelper against the REAL
 * built linux helper entry, committing every validated chunk into a REAL
 * MeetingStore so stage 2 can run the production inventory path.
 */
async function stageRecordFixture() {
  const root = await mkdtempTmp("meetless-proof-store-");
  const store = new MeetingStore({ root });
  const meeting = await store.create({ title: "Linux port proof" });
  const recording = await store.startRecording({ meetingId: meeting.id });
  const sessionDirectory = path.join(root, "sessions", recording.id);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });

  const chunks = [];
  const failures = [];
  const helper = new CaptureHelper({
    executable: process.execPath,
    arguments: [linuxHelperEntry, "--fixture"],
    sessionDirectory,
    storeRoot: root,
    fixture: true,
    onChunk: async (chunk) => {
      chunks.push(chunk);
      await store.commitChunk(recording.id, chunk);
    },
    onFailure: async (reason) => { failures.push(reason); },
  });

  try {
    await helper.start();
    await delay(RECORD_MS);
    await helper.pause();
    await helper.resume(9_000);
    await helper.stop();
  } finally {
    await helper.terminate().catch(() => undefined);
  }

  if (failures.length > 0) throw new Error(`capture helper reported failure: ${failures[0]}`);
  if (chunks.length < 2) throw new Error(`expected >= 2 committed chunks across both sources, saw ${chunks.length}`);
  const sources = new Set(chunks.map((chunk) => chunk.source));
  if (!sources.has("microphone") || !sources.has("system")) {
    throw new Error(`expected both capture sources, saw ${[...sources].join(",")}`);
  }

  // Real evidence: re-validate every committed WAV on disk with the
  // production validator (CaptureHelper already validated each event claim).
  const wavNames = (await readdir(sessionDirectory)).filter((name) => name.endsWith(".wav")).sort();
  if (wavNames.length !== chunks.length) {
    throw new Error(`session holds ${wavNames.length} wav files for ${chunks.length} chunk events`);
  }
  const validated = [];
  for (const name of wavNames) {
    const chunk = await validateCommittedWavChunk({
      filePath: path.join(sessionDirectory, name),
      sessionDirectory,
      storeRoot: root,
    });
    if (chunk.sampleRate !== 16_000 || chunk.channels !== 1 || chunk.format !== "wav") {
      throw new Error(`validated chunk is not 16 kHz mono WAV: ${name}`);
    }
    validated.push({ id: chunk.id, source: chunk.source, byteLength: chunk.byteLength, sha256: chunk.sha256 });
  }

  context.storeRoot = root;
  context.recordingId = recording.id;
  context.validatedChunks = validated;
  const bytesPerSource = {};
  for (const chunk of validated) bytesPerSource[chunk.source] = (bytesPerSource[chunk.source] ?? 0) + chunk.byteLength;
  stageDetails.record = { storeRoot: root, recordingId: recording.id, sessionDirectory, chunks: validated };

  return { artifact: sessionDirectory, detail: { chunks: validated.length, sources: [...sources], bytesPerSource } };
}

/**
 * Stage 2: the REAL production finalization path — RecordingInventoryReconciler
 * (sidecar inventory over the committed session) then Mp3Finalizer.stage
 * (ffmpeg amix -> libmp3lame MP3 + canonical managed WAV), verified with the
 * real ffprobe, then published with publishNoReplace.
 */
async function stageFinalizeRealFinalizer() {
  if (!context.storeRoot || !context.recordingId) throw new Error("finalize stage is missing the record stage context");
  const { storeRoot, recordingId } = context;

  const store = new MeetingStore({ root: storeRoot });
  const closed = await store.prepareInventoryRecovery(recordingId, "linux-port proof capture stopped");
  const pointer = await new RecordingInventoryReconciler(storeRoot, store).reconcile(closed);

  const exportRoot = await mkdtempTmp("meetless-proof-exports-");
  const ffmpegCommands = [];
  const finalizer = new Mp3Finalizer({
    ffmpeg: process.env.MEETLESS_FFMPEG ?? "ffmpeg",
    ffprobe: process.env.MEETLESS_FFPROBE ?? "ffprobe",
    exportRoot,
    storeRoot,
    observeCommand: (executable, args) => { ffmpegCommands.push([executable, ...args].join(" ")); },
  });

  const staged = await finalizer.stage(recordingId, pointer);
  try {
    const destination = await finalizer.nextDestination();
    await finalizer.publishNoReplace(staged.stagePath, destination);
    const verification = await finalizer.verify(destination);
    const published = await stat(destination);
    const mp3Sha256 = await sha256File(destination);
    const managedWav = await stat(staged.managedTimeline.path);
    const managedWavSha256 = await sha256File(staged.managedTimeline.path);

    if (mp3Sha256 !== staged.identity.sha256 || published.size !== staged.identity.byteLength) {
      throw new Error("published MP3 identity does not match the staged identity");
    }
    if (managedWavSha256 !== staged.managedTimeline.identity.sha256) {
      throw new Error("managed WAV identity does not match the staged identity");
    }
    if (!(verification.durationSeconds > 0)) throw new Error("ffprobe reported no MP3 duration");

    context.mp3 = {
      path: destination,
      byteLength: published.size,
      sha256: mp3Sha256,
      durationSeconds: verification.durationSeconds,
    };
    stageDetails.finalize = {
      method: "RecordingInventoryReconciler.reconcile + Mp3Finalizer.stage + publishNoReplace",
      pointer: {
        chunkCount: pointer.chunkCount,
        microphoneCount: pointer.microphoneCount,
        systemCount: pointer.systemCount,
      },
      ffmpegCommands,
      mp3: { ...context.mp3 },
      managedWav: {
        path: staged.managedTimeline.path,
        byteLength: managedWav.size,
        sha256: managedWavSha256,
        endMs: staged.managedTimeline.endMs,
      },
      timelineEvidence: staged.timelineEvidence,
    };
    return {
      artifact: destination,
      sha256: mp3Sha256,
      detail: {
        mp3Bytes: published.size,
        durationSeconds: Number(verification.durationSeconds.toFixed(3)),
        managedWavBytes: managedWav.size,
        chunks: pointer.chunkCount,
      },
    };
  } finally {
    // The managed WAV stage is consumed here; the published MP3 tmpdir must
    // survive until the transcribe stage has read it, so exportRoot is only
    // removed with the other tmpdirs at the end of main().
    await staged.managedTimeline.cleanup().catch(() => undefined);
  }
}

/**
 * Stage 3: BYOK transcription through the real provider with a real temp key
 * file (real readByokKey file read) and a stubbed fetch. Asserts the endpoint,
 * method, Bearer header, multipart body, and returned text.
 */
async function stageTranscribeByok() {
  const keyDirectory = await mkdtempTmp("meetless-proof-byok-");
  const configPath = path.join(keyDirectory, "byok.json");
  await writeFile(configPath, JSON.stringify({ version: 1, apiKey: BYOK_FIXTURE_KEY }), "utf8");

  let audioPath;
  let audioIdentity;
  if (context.mp3) {
    audioPath = context.mp3.path;
    audioIdentity = { byteLength: context.mp3.byteLength, sha256: context.mp3.sha256 };
  } else {
    // The finalize stage failed; fall back to a committed WAV chunk so the
    // transcription route itself still gets real evidence.
    const chunk = context.validatedChunks[0];
    if (!chunk) throw new Error("transcribe stage has neither a finalized MP3 nor a committed chunk");
    audioPath = path.join(context.storeRoot, "sessions", context.recordingId, `${chunk.id}.wav`);
    const info = await stat(audioPath);
    audioIdentity = { byteLength: info.size, sha256: chunk.sha256 };
  }

  const captured = {};
  const fetchImpl = async (input, init) => {
    captured.url = String(input);
    captured.method = init?.method;
    captured.authorization = init?.headers?.authorization;
    captured.body = init?.body;
    return { status: 200, ok: true, json: async () => ({ text: TRANSCRIPT_TEXT }) };
  };

  const provider = new OpenAiByokTranscriptionProvider({ configPath, fetchImpl });
  if ((await provider.status()) !== "configured") {
    throw new Error("BYOK provider did not report the temp key file as configured");
  }

  const result = await provider.transcribe({
    recordingId: context.recordingId ?? "linux-port-proof",
    audioPath,
    audioIdentity,
    range: { ordinal: 0, startMs: 0, endMs: 30_000, segmentId: "segment-proof-0" },
  });

  if (captured.url !== OPENAI_TRANSCRIPTION_ENDPOINT) throw new Error(`unexpected endpoint: ${captured.url}`);
  if (captured.method !== "POST") throw new Error(`unexpected method: ${captured.method}`);
  if (captured.authorization !== `Bearer ${BYOK_FIXTURE_KEY}`) {
    throw new Error(`unexpected authorization header: ${captured.authorization}`);
  }
  if (!(captured.body instanceof FormData)) throw new Error("BYOK request body is not multipart form data");
  if (captured.body.get("model") !== OPENAI_TRANSCRIPTION_MODEL) throw new Error("BYOK request used the wrong model");
  const file = captured.body.get("file");
  if (!(file instanceof Blob) || file.size !== audioIdentity.byteLength) {
    throw new Error("BYOK request did not upload the exact audio bytes");
  }
  if (result.text !== TRANSCRIPT_TEXT || result.text.trim().length === 0) {
    throw new Error("BYOK transcription returned unexpected text");
  }
  if (!result.detectedLanguages.includes("vi")) throw new Error("BYOK transcription lost the vi language marker");

  stageDetails.transcribe = {
    configPath,
    endpoint: captured.url,
    authorization: "Bearer <fixture key>",
    audio: { path: audioPath, byteLength: audioIdentity.byteLength },
    text: result.text,
    detectedLanguages: result.detectedLanguages,
  };
  return {
    artifact: audioPath,
    detail: { endpoint: captured.url, text: result.text, uploadedBytes: audioIdentity.byteLength },
  };
}

/**
 * Stage 4: real transcript MCP server with an honestly minimal transcript
 * fixture (same shape as the repository's own chat-service test fixture).
 * Evidence-only: recorded, not part of the exit gate.
 */
async function stageTranscriptMcp() {
  const segmentId = "segment-proof-0";
  const range = { ordinal: 0, startMs: 0, endMs: 30_000, segmentId };
  const transcript = {
    id: "transcript-linux-proof",
    meetingId: "meeting-linux-proof",
    recordingId: "recording-linux-proof",
    status: "ready",
    plannerVersion: "m3-range-v1",
    rangeMs: 30_000,
    maxAttempts: 1,
    audio: { destination: "meetings/proof.mp3", byteLength: 1, sha256: "proof", durationMs: 30_000 },
    ranges: [range],
    checkpoints: [{
      range,
      attempts: 1,
      text: TRANSCRIPT_TEXT,
      usage: null,
      detectedLanguages: ["vi"],
      completedAt: new Date().toISOString(),
    }],
    attemptsByOrdinal: { "0": 1 },
    requestCount: 1,
    usage: null,
    detectedLanguages: ["vi"],
    failureReason: null,
    publication: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const retrieved = [];
  const resource = await startTranscriptMcp({
    provider: "codex",
    model: "gpt-5",
    messages: [],
    transcript,
    recordRetrieved: async (ids) => { retrieved.push(...ids); },
  });
  try {
    const rpc = async (id, method, params) => {
      const response = await fetch(resource.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });
      if (response.status !== 200) throw new Error(`MCP ${method} answered HTTP ${response.status}`);
      return await response.json();
    };

    const initialized = await rpc(1, "initialize", { protocolVersion: "2025-03-26" });
    if (initialized.result?.serverInfo?.name !== "meetless-meeting-retrieval") {
      throw new Error("MCP initialize returned an unexpected server identity");
    }
    const listed = await rpc(2, "tools/list", {});
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    for (const required of ["search_meeting_transcript", "get_meeting_segments"]) {
      if (!names.includes(required)) throw new Error(`MCP tools/list is missing ${required}`);
    }
    const searched = await rpc(3, "tools/call", {
      name: "search_meeting_transcript",
      arguments: { query: "bằng chứng" },
    });
    const segments = searched.result?.structuredContent?.segments ?? [];
    if (segments.length !== 1 || segments[0].segmentId !== segmentId || segments[0].text !== TRANSCRIPT_TEXT) {
      throw new Error(`MCP search returned unexpected segments: ${JSON.stringify(segments)}`);
    }
    const fetchedById = await rpc(4, "tools/call", {
      name: "get_meeting_segments",
      arguments: { segmentIds: [segmentId] },
    });
    const byId = fetchedById.result?.structuredContent?.segments ?? [];
    if (byId.length !== 1 || byId[0].segmentId !== segmentId) {
      throw new Error(`MCP get_meeting_segments returned unexpected segments: ${JSON.stringify(byId)}`);
    }
    if (retrieved.join(",") !== [segmentId, segmentId].join(",")) {
      throw new Error(`MCP retrieval callback saw unexpected ids: ${retrieved.join(",")}`);
    }

    stageDetails.mcp = { url: resource.url, tools: names, retrieved };
    return { artifact: resource.url, detail: { tools: names } };
  } finally {
    await resource.close();
  }
}

/**
 * Stage 5 (Task 12, evidence-only): DEV desktop launch. Spawns
 * `npm run runtime:desktop` under `timeout -k 5 30` with a tmp runtime root
 * and dedicated daemon/renderer ports, then polls the renderer origin the dev
 * desktop serves (dev mode spawns the expo web server at
 * MEETLESS_RENDERER_ORIGIN). Success = the renderer origin answered HTTP 200
 * OR the launcher stayed alive >= 15s. Truthful capture either way: a failure
 * here is recorded as ok:false with the first output line, not as proof
 * failure, mirroring the daemon probe.
 */
async function stageDesktopDev(display) {
  const runtimeRoot = await mkdtempTmp("meetless-proof-desktop-");
  const outputLines = [];
  const startedAt = Date.now();
  const launcher = display.xvfb ? "xvfb-run" : "timeout";
  const launcherArgs = display.xvfb
    ? ["-a", "timeout", "-k", "5", "30", "npm", "run", "runtime:desktop"]
    : ["-k", "5", "30", "npm", "run", "runtime:desktop"];
  // detached:true gives the launcher its own session so the proof can stop the
  // whole desktop tree with a group signal; `timeout` (non-foreground mode)
  // additionally signals its child group at the 30s bound.
  const child = spawn(launcher, launcherArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      MEETLESS_RUNTIME_ROOT: runtimeRoot,
      MEETLESS_LISTEN: DESKTOP_LISTEN,
      MEETLESS_RENDERER_ORIGIN: DESKTOP_RENDERER_ORIGIN,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() }));
    child.once("error", (error) => resolve({ code: null, signal: null, at: Date.now(), error: error.message }));
  });
  const capture = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (line.trim() && outputLines.length < 80) outputLines.push(line.trim());
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let rendererFirst200Ms = null;
  let stopResult = null;
  try {
    rendererFirst200Ms = await waitForRendererHttp200(DESKTOP_RENDERER_ORIGIN, 32_000, child);
    // One run records both success facts: keep the desktop up through the 15s
    // liveness threshold once the renderer answered, then reap the tree.
    const remainingForAlive = 15_000 - (Date.now() - startedAt);
    if (rendererFirst200Ms !== null && remainingForAlive > 0 && child.exitCode === null && child.signalCode === null) {
      await delay(remainingForAlive);
    }
    stopResult = await stopProcessGroup(child, exitPromise);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      stopResult = (await stopProcessGroup(child, exitPromise).catch(() => "stop failed")) ?? stopResult;
    }
  }
  const exitInfo = await exitPromise;
  const aliveMs = exitInfo.at - startedAt;

  // The desktop CLI TERMs its detached daemon/renderer/electron children on
  // SIGTERM; give that a grace window and record what actually closed.
  const portsClosedAfterExit = await waitForPortsClosed([DESKTOP_DAEMON_PORT, DESKTOP_RENDERER_PORT], 6_000);
  stageDetails.desktop = {
    display: display.mode,
    runtimeRoot,
    listen: DESKTOP_LISTEN,
    rendererOrigin: DESKTOP_RENDERER_ORIGIN,
    rendererFirst200Ms,
    aliveMs,
    exit: stopResult,
    portsClosedAfterExit,
    output: outputLines,
  };
  await rmTmp(runtimeRoot);

  if (exitInfo.error) throw new Error(`desktop launcher failed to start: ${exitInfo.error}`);
  const ok = rendererFirst200Ms !== null || aliveMs >= 15_000;
  if (ok) {
    return {
      artifact: DESKTOP_RENDERER_ORIGIN,
      detail: {
        display: display.mode,
        rendererHttp200: rendererFirst200Ms !== null,
        rendererFirst200Ms,
        aliveMs,
        exit: stopResult,
      },
    };
  }
  const firstError = outputLines.find((line) => /error|cannot|denied|throw|exception|not found|failed/iu.test(line))
    ?? outputLines[0]
    ?? "desktop produced no output";
  throw new Error(`dev desktop stayed alive ${aliveMs}ms without serving the renderer; ${firstError}`.slice(0, 300));
}

/** Display availability for the desktop stage: real display or xvfb-run. */
function resolveDesktopDisplay() {
  if (process.env.DISPLAY) return { available: true, mode: `DISPLAY=${process.env.DISPLAY}` };
  if (process.env.WAYLAND_DISPLAY) return { available: true, mode: `WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY}` };
  if (commandExists("xvfb-run")) return { available: true, mode: "xvfb-run -a", xvfb: true };
  return { available: false, reason: "DISPLAY and WAYLAND_DISPLAY are unset and xvfb-run is not on PATH" };
}

async function waitForRendererHttp200(origin, timeoutMs, child) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return null;
    if (await httpOk(origin)) return Date.now() - startedAt;
    await delay(500);
  }
  return null;
}

async function httpOk(origin) {
  try {
    const response = await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(1_500) });
    return response.status === 200;
  } catch {
    return false;
  }
}

async function stopProcessGroup(child, exitPromise) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return describeObservedExit(await exitPromise);
  }
  signalBestEffort(child.pid, "SIGTERM");
  const graceful = await Promise.race([exitPromise.then(describeObservedExit), delay(3_000).then(() => null)]);
  if (graceful) return graceful;
  signalBestEffort(child.pid, "SIGKILL");
  const killed = await Promise.race([exitPromise.then(describeObservedExit), delay(3_000).then(() => null)]);
  return killed ?? "SIGKILL (exit unobserved)";
}

function signalBestEffort(pgid, signal) {
  for (const target of [-pgid, pgid]) {
    try {
      process.kill(target, signal);
    } catch { /* group or leader already gone */ }
  }
}

function describeObservedExit(exit) {
  if (exit.error) return `spawn error: ${exit.error}`;
  return exit.code !== null ? `exit ${exit.code}` : `signal ${exit.signal ?? "unknown"}`;
}

async function waitForPortsClosed(ports, timeoutMs) {
  const closed = {};
  const deadline = Date.now() + timeoutMs;
  do {
    for (const port of ports) closed[port] = !(await tcpConnects(port));
    if (ports.every((port) => closed[port])) return closed;
    await delay(300);
  } while (Date.now() < deadline);
  return closed;
}

function assertPreconditions() {
  if (process.platform !== "linux") throw new Error(`this proof targets linux; refusing to run on ${process.platform}`);
  for (const command of ["ffmpeg", "ffprobe", "/usr/bin/sort"]) {
    if (!commandExists(command)) throw new Error(`${command} is required for this proof`);
  }
}

function commandExists(command) {
  const probe = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim().length > 0;
}

async function mkdtempTmp(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

async function rmTmp(root) {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  const index = tmpRoots.indexOf(root);
  if (index >= 0) tmpRoots.splice(index, 1);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(filePath)) hash.update(data);
  return hash.digest("hex");
}

async function waitForTcp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpConnects(port)) return true;
    await delay(200);
  }
  return false;
}

function tcpConnects(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(400);
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, result: describeExit(child) };
  }
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve(describeExit({ exitCode: code, signalCode: signal })));
  });
  child.kill("SIGTERM");
  const graceful = await Promise.race([exit, delay(3_000).then(() => null)]);
  if (graceful) return { exited: true, result: graceful };
  child.kill("SIGKILL");
  const killed = await Promise.race([exit, delay(2_000).then(() => null)]);
  return { exited: killed !== null, result: killed ?? "SIGKILL (exit unobserved)" };
}

function describeExit(child) {
  return child.exitCode !== null ? `exit ${child.exitCode}` : `signal ${child.signalCode ?? "unknown"}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort synchronous tmp cleanup for anything not removed inline,
// including unexpected top-level failures.
process.on("exit", () => {
  for (const root of tmpRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
});
