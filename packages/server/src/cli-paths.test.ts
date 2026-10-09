/**
 * CLI path resolution (regression).
 *
 * \`pnpm --filter @robrowser/server cli run flows/demo.json\` executes with the
 * package directory as cwd, so repository-relative flow paths must be resolved
 * against the workspace root instead of the package. Without this the documented
 * acceptance command fails with FLOW_NOT_FOUND.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectFlowsDir } from './env.js';
import { isFile, resolveFlowPath } from './cli-paths.js';

describe('CLI flow path resolution', () => {
  it('resolves a workspace-relative flows/ path from a nested cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'robrowser-paths-'));
    await mkdir(join(root, 'flows'), { recursive: true });
    await mkdir(join(root, 'packages', 'server'), { recursive: true });
    await writeFile(join(root, 'flows', 'demo.json'), '{}', 'utf8');

    // detectFlowsDir walks up from the cwd, exactly like the CLI does.
    expect(detectFlowsDir(join(root, 'packages', 'server'))).toBe(join(root, 'flows'));

    const previous = process.cwd();
    process.chdir(join(root, 'packages', 'server'));
    try {
      expect(resolveFlowPath('flows/demo.json')).toBe(join(root, 'flows', 'demo.json'));
      // Missing files still report the cwd-relative candidate.
      expect(isFile(resolveFlowPath('flows/missing.json'))).toBe(false);
    } finally {
      process.chdir(previous);
    }
  });

  it('leaves absolute and existing cwd-relative paths untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'robrowser-paths-abs-'));
    const file = join(dir, 'flow.json');
    await writeFile(file, '{}', 'utf8');
    expect(resolveFlowPath(file)).toBe(resolve(file));
  });
});
