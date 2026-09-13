const now = (): number => performance.now();

/** Recording-logical elapsed time: pauses do not advance the clock. */
export class LogicalClock {
  private accumulatedMs = 0;
  private lastResumeMs: number | null = null;
  private running = false;

  start(nowMs: number = now()): void {
    this.accumulatedMs = 0;
    this.lastResumeMs = nowMs;
    this.running = true;
  }

  pause(nowMs: number = now()): void {
    if (!this.running) return;
    this.accumulatedMs += nowMs - (this.lastResumeMs ?? nowMs);
    this.running = false;
    this.lastResumeMs = null;
  }

  resume(nowMs: number = now()): void {
    if (this.running) return;
    this.lastResumeMs = nowMs;
    this.running = true;
  }

  logicalMs(nowMs: number = now()): number {
    const live = this.running ? nowMs - (this.lastResumeMs ?? nowMs) : 0;
    return Math.max(0, Math.round(this.accumulatedMs + live));
  }
}
