/**
 * URL normalisation shared by the engine, exporters and hosts.
 *
 * A flow that lives in a repository should be portable: `./fixtures/login.html`
 * must work from the CLI, the HTTP worker and the desktop app without the author
 * writing `file:///C:/...`. Resolution rules:
 *
 * - absolute http/https/file/data/about URLs are returned unchanged;
 * - a leading `/` is treated as a file-system absolute path;
 * - anything else is resolved relative to `baseDir` (the flow file directory)
 *   and converted to a `file://` URL.
 */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** URL schemes that are passed through untouched. */
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Resolve a flow-authored URL into something the browser can navigate to.
 *
 * @param url - Raw (already interpolated) URL from the flow.
 * @param baseDir - Directory used for relative paths; defaults to `process.cwd()`.
 * @returns An absolute URL usable by `Page.navigate`.
 */
export function resolveNavigationUrl(url: string, baseDir: string = flowBaseDir()): string {
  if (ABSOLUTE_URL.test(url)) return url;
  const absolutePath = isAbsolute(url) ? url : resolve(baseDir, url);
  return pathToFileURL(absolutePath).href;
}

/** Directory that relative flow URLs are resolved against (test/override hook). */
let baseDirOverride: string | undefined;

/** Override the base directory (used by the CLI before running a flow). */
export function setFlowBaseDir(dir: string | undefined): void {
  baseDirOverride = dir;
}

/** The current base directory. */
export function flowBaseDir(): string {
  return baseDirOverride ?? process.cwd();
}
