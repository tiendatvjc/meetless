import { describe, expect, it } from "vitest";
import { LogicalClock } from "../../src/linux/logical-clock.js";

describe("LogicalClock", () => {
  it("accumulates only while recording", () => {
    const clock = new LogicalClock();
    clock.start(0);
    expect(clock.logicalMs(1_000)).toBe(1_000);
    clock.pause(1_000);
    expect(clock.logicalMs(9_000)).toBe(1_000);
    clock.resume(9_000);
    expect(clock.logicalMs(10_000)).toBe(2_000);
  });

  it("is zero before start and unchanged by double pause", () => {
    const clock = new LogicalClock();
    expect(clock.logicalMs(5)).toBe(0);
    clock.start(0);
    clock.pause(100);
    clock.pause(200);
    expect(clock.logicalMs(300)).toBe(100);
  });
});
