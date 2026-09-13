import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePackagedRendererForTest, startPackagedRendererForTest } from "../src/desktop.js";

const workspace = await mkdtemp(path.join(tmpdir(), "meetless-linux-boundary-"));
const rendererRoot = path.join(workspace, "renderer");
await mkdir(rendererRoot, { recursive: true });
await writeFile(path.join(rendererRoot, "index.html"), "<!doctype html><title>meetless</title>");

let server: Awaited<ReturnType<typeof startPackagedRendererForTest>>;
let origin: string;

beforeAll(async () => {
  server = await startPackagedRendererForTest(rendererRoot, "http://127.0.0.1:0", new AbortController().signal, {
    nativeSocket: undefined,
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound tcp address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await closePackagedRendererForTest(server).catch(() => undefined);
  await rm(workspace, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("linux capture permission boundary without a native socket", () => {
  it("reports both capture sources granted instead of 503", async () => {
    const response = await fetch(`${origin}/__meetless/capture-permissions`, { cache: "no-store" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ microphone: "authorized", systemAudio: "authorized" });
  });

  it("serves the renderer index for the app root", async () => {
    const response = await fetch(origin, { cache: "no-store" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
