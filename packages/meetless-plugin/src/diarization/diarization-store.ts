import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Speaker diarization stage B4 persistence: one small JSON per meeting under
 * <storeRoot>/diarization-names/<meetingId>.json holding the segment→speaker
 * attribution and the current display names. Deliberately outside meetings.json
 * and the immutable transcript publication sidecar, so attribution stays an
 * idempotent overlay (re-runs overwrite it) and renames never churn the domain.
 */

export interface StoredDiarizationSpeaker {
  readonly id: string;
  readonly name: string;
}

export interface StoredDiarization {
  readonly version: 1;
  readonly meetingId: string;
  readonly recordingId: string;
  readonly appliedAt: string;
  readonly speakers: readonly StoredDiarizationSpeaker[];
  /** Transcript segmentId → speaker id ("S1"...); only attributed segments. */
  readonly segments: Readonly<Record<string, string>>;
}

const StoredDiarizationSchema = z.object({
  version: z.literal(1),
  meetingId: z.string().trim().min(1),
  recordingId: z.string().trim().min(1),
  appliedAt: z.string().datetime(),
  speakers: z.array(z.object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).max(80),
  }).strict()),
  segments: z.record(z.string().trim().min(1), z.string().trim().min(1)),
}).strict();

const SAFE_MEETING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export class DiarizationStore {
  constructor(private readonly directory: string) {}

  async load(meetingId: string): Promise<StoredDiarization | null> {
    const filePath = this.filePath(meetingId);
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = StoredDiarizationSchema.parse(JSON.parse(contents));
      if (parsed.meetingId !== meetingId) throw new Error("meeting id mismatch");
      return parsed;
    } catch {
      // A corrupt overlay must never break transcript reads; treat it as absent.
      return null;
    }
  }

  async save(record: StoredDiarization): Promise<void> {
    const parsed = StoredDiarizationSchema.parse(record);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePath(parsed.meetingId);
    const temporaryPath = path.join(this.directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async renameSpeakers(meetingId: string, names: Readonly<Record<string, string>>): Promise<StoredDiarization | null> {
    const current = await this.load(meetingId);
    if (!current) return null;
    const renamed: StoredDiarization = {
      ...current,
      speakers: current.speakers.map((speaker) => {
        const name = names[speaker.id]?.trim();
        return name ? { ...speaker, name } : speaker;
      }),
    };
    await this.save(renamed);
    return renamed;
  }

  private filePath(meetingId: string): string {
    if (!SAFE_MEETING_ID.test(meetingId)) {
      throw new Error(`Diarization store meeting id is not path-safe: ${meetingId}`);
    }
    return path.join(this.directory, `${meetingId}.json`);
  }
}
