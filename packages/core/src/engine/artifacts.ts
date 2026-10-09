/**
 * Run artefact management: screenshots, downloads and other produced files are
 * written under `<runDir>` and reported through the {@link RunArtifacts} port.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { RunArtifacts } from './context.js';
import { RoboError } from '../errors.js';

/** Default sub-directory layout inside a run directory. */
export const ARTIFACT_SUBDIRS = ['screenshots', 'downloads', 'logs'] as const;
export type ArtifactSubdir = (typeof ARTIFACT_SUBDIRS)[number];

/**
 * Create a {@link RunArtifacts} bound to `runDir`.
 *
 * @param runDir - Directory that receives all artefacts for the run.
 */
export function createRunArtifacts(runDir: string): RunArtifacts {
  const root = resolve(runDir);
  const recorded: string[] = [];

  const safeJoin = (filename: string): string => {
    const cleaned = normalize(filename).replace(/^([/\\])+/, '');
    const target = isAbsolute(filename) ? resolve(filename) : join(root, cleaned);
    if (!target.startsWith(root + sep) && target !== root) {
      throw new RoboError('STORAGE_ERROR', `Artefact path escapes the run directory: ${filename}`, {
        runDir: root,
        filename,
      });
    }
    return target;
  };

  return {
    runDir: root,
    async save(filename: string, data: Buffer | string): Promise<string> {
      const target = safeJoin(filename);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, data);
      if (!recorded.includes(target)) recorded.push(target);
      return target;
    },
    add(path: string): void {
      const target = isAbsolute(path) ? resolve(path) : join(root, path);
      if (!recorded.includes(target)) recorded.push(target);
    },
    list(): string[] {
      return [...recorded];
    },
  };
}

/**
 * Resolve a per-step artefact filename inside a sub-directory, ensuring the
 * result stays inside the run directory.
 */
export function artifactPath(runDir: string, subdir: ArtifactSubdir, filename: string): string {
  const cleaned = normalize(filename).replace(/^([/\\])+/, '');
  return join(runDir, subdir, cleaned);
}
