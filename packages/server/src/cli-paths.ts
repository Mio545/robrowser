/**
 * Resolve a CLI-supplied flow path.
 *
 * `pnpm --filter @robrowser/server cli run flows/demo.json` runs the script
 * with the *package* directory as cwd, so a repository-relative path like
 * `flows/demo.json` would otherwise resolve to `packages/server/flows/...` and
 * fail. Resolution order:
 *
 *   1. as given (absolute paths and cwd-relative paths);
 *   2. relative to the nearest ancestor that contains a `flows/` directory.
 *
 * The fallback is data-driven, so it works for a checkout in any location and
 * for the CLI, `serve` and exporter entry points alike.
 */
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

/** True when `candidate` exists and is a file. */
function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a flow path relative to the cwd, then to the workspace root.
 *
 * @param filePath - User-supplied path (absolute or relative).
 * @returns An absolute path that exists, or the cwd-relative path when neither
 *   candidate is present (so the caller can surface a precise error).
 */
export function resolveFlowPath(filePath: string): string {
  const direct = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (isFile(direct)) return direct;

  // Walk up from the cwd looking for a `flows/` directory. This is the
  // repository root in a pnpm workspace, and also works for a nested checkout
  // executed through `pnpm --filter`.
  let cursor = process.cwd();
  const root = parse(cursor).root;
  for (;;) {
    const candidate = join(cursor, filePath);
    if (isFile(candidate)) return candidate;
    if (cursor === root) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return direct;
}

/** True when a path exists (exported for tests). */
export { isFile };
