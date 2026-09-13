import { describe, expect, it } from "vitest";
import { parseProcCmdline } from "../src/readiness.js";

describe("parseProcCmdline", () => {
  it("splits NUL-separated argv and drops the trailing empty entry", () => {
    const raw = Buffer.from("node\0/home/x/dist/cli.js\0daemon\0\0", "utf8");
    expect(parseProcCmdline(raw)).toEqual(["node", "/home/x/dist/cli.js", "daemon"]);
  });

  it("returns an empty vector for an empty buffer", () => {
    expect(parseProcCmdline(Buffer.alloc(0))).toEqual([]);
  });
});
