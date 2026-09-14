import {
  checkDiarizerAvailability,
  resolveDiarizerSidecarPaths,
  runDiarizationSidecar,
  type DiarizerAvailability,
  type DiarizerProvider,
  type DiarizerSidecarPaths,
  type DiarizerTurn,
} from "./diarizer.js";

/**
 * Speaker diarization stage B3: the pyannote-backed DiarizerProvider. Kept a
 * thin adapter over the generic sidecar runner so tests (and any future
 * provider swap) only need the DiarizerProvider seam.
 */
export class PyannoteDiarizerProvider implements DiarizerProvider {
  private readonly paths: DiarizerSidecarPaths;
  private readonly runOptions: { timeoutMs?: number; chunkMinutes?: number };

  constructor(
    paths?: Partial<DiarizerSidecarPaths>,
    runOptions?: { timeoutMs?: number; chunkMinutes?: number },
  ) {
    this.paths = resolveDiarizerSidecarPaths(paths);
    this.runOptions = runOptions ?? {};
  }

  available(): Promise<DiarizerAvailability> {
    return checkDiarizerAvailability(this.paths);
  }

  run(systemWav: string, onProgress?: (fraction: number) => void): Promise<DiarizerTurn[]> {
    return runDiarizationSidecar({
      paths: this.paths,
      audio: systemWav,
      onProgress,
      ...this.runOptions,
    });
  }
}
