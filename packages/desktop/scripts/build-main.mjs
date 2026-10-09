/**
 * Build the Electron main process and preload into self-contained CJS bundles.
 *
 * Why bundle instead of plain `tsc`?
 *   `@robrowser/core` and `@robrowser/browser` are pure-ESM packages
 *   ("type": "module"), while the Electron main process runs as CommonJS.
 *   `require()` cannot load ESM, so the host would crash with
 *   ERR_PACKAGE_PATH_NOT_EXPORTED at startup. esbuild inlines the workspace
 *   packages (and zod) and leaves only true externals - the Electron builtin,
 *   the native better-sqlite3 addon and pino - as runtime requires.
 *
 * Output matches electron-builder's `extraMetadata.main` (dist/main/index.js).
 */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Modules Electron ships or that must stay native/external at runtime. */
const external = ['electron', 'better-sqlite3', 'pino'];

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

await rm(resolve(desktopDir, 'dist/main'), { recursive: true, force: true });
await rm(resolve(desktopDir, 'dist/preload'), { recursive: true, force: true });

await build({
  ...shared,
  entryPoints: [resolve(desktopDir, 'src/main/index.ts')],
  outfile: resolve(desktopDir, 'dist/main/index.js'),
});

await build({
  ...shared,
  entryPoints: [resolve(desktopDir, 'src/preload/index.ts')],
  outfile: resolve(desktopDir, 'dist/preload/index.js'),
});
