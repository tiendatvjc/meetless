import { describe, expect, it } from "vitest";
import {
  platformRecordingExportsRelativePath,
  platformUserSupportRelativePath,
} from "../src/config.js";

describe("platform support paths", () => {
  it("darwin keeps the macOS Application Support contract", () => {
    expect(platformUserSupportRelativePath("darwin")).toBe("Library/Application Support/Meetless");
    expect(platformRecordingExportsRelativePath("darwin")).toBe("Documents/meetings");
  });

  it("linux uses the XDG-style support root and keeps the exports contract", () => {
    expect(platformUserSupportRelativePath("linux")).toBe(".local/share/meetless");
    expect(platformRecordingExportsRelativePath("linux")).toBe("Documents/meetings");
  });

  it("rejects unsupported platforms loudly", () => {
    expect(() => platformUserSupportRelativePath("win32")).toThrow(/unsupported platform/i);
  });
});
