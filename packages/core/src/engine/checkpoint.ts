/**
 * Checkpointing (spec 5.1).
 *
 * After every successful step the orchestrator writes `checkpoint.json` into the
 * run directory. The file records enough state to resume: the index path of the
 * last completed step plus a snapshot of variables.
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RoboError } from '../errors.js';

/** On-disk checkpoint shape. */
export interface Checkpoint {
  /** Version of the checkpoint format. */
  version: 1;
  runId: string;
  flowId: string;
  /** Index path of the last *completed* step, e.g. `[0, 2]` into nested lists. */
  path: number[];
  /** Id of the last completed step (for human readable resume). */
  stepId: string;
  /** Completed step count so far. */
  completed: number;
  /** Serialised variables at the time of the checkpoint. */
  variables: Record<string, unknown>;
  /** ISO timestamp. */
  updatedAt: string;
}

/** File name used inside the run directory. */
export const CHECKPOINT_FILENAME = 'checkpoint.json';

/** Persist a checkpoint, creating parent directories. */
export async function writeCheckpoint(runDir: string, checkpoint: Checkpoint): Promise<string> {
  const file = join(runDir, CHECKPOINT_FILENAME);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * Read a checkpoint from a run directory.
 *
 * @returns The checkpoint, or `null` when the file does not exist.
 * @throws {RoboError} When the file exists but cannot be parsed.
 */
export async function readCheckpoint(runDir: string): Promise<Checkpoint | null> {
  const file = join(runDir, CHECKPOINT_FILENAME);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Checkpoint;
    if (parsed.version !== 1) {
      throw new RoboError('CHECKPOINT_ERROR', `Unsupported checkpoint version: ${parsed.version}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof RoboError) throw error;
    throw new RoboError(
      'CHECKPOINT_ERROR',
      `Corrupt checkpoint at ${file}`,
      { path: file },
      {
        cause: error,
      },
    );
  }
}

/** Delete the checkpoint (called when a run completes). */
export async function clearCheckpoint(runDir: string): Promise<void> {
  await rm(join(runDir, CHECKPOINT_FILENAME), { force: true });
}

/**
 * Compare two index paths to decide identical / ordering.
 *
 * @returns negative when `a` precedes `b`, 0 when equal, positive otherwise.
 */
export function comparePaths(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}
