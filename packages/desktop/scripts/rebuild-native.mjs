/**
 * Rebuild the desktop's native `better-sqlite3` addon for the Electron ABI.
 *
 * Why this is needed
 *   The monorepo's server package also depends on better-sqlite3, which pnpm
 *   would otherwise resolve to one shared physical copy compiled for the *Node*
 *   ABI. Electron 30 ships a different NODE_MODULE_VERSION (123 vs Node 22's
 *   127), so the shared addon fails to load at startup:
 *     "was compiled against a different Node.js version".
 *
 *   Desktop therefore pins its own better-sqlite3 version so pnpm gives it a
 *   separate store directory, and this script rebuilds that copy against the
 *   Electron ABI. It runs automatically as the desktop package's `postinstall`.
 *
 * Strategy
 *   1. Resolve the desktop-owned better-sqlite3 directory.
 *   2. Download the matching official `electron` prebuild via prebuild-install
 *      (retrying, because the GitHub release download is occasionally flaky).
 *   3. Fall back to a source build with node-gyp + Electron headers.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktopDir, 'package.json'));

/** Installed Electron version, i.e. the ABI we must target. */
function electronVersion() {
  try {
    return String(require('electron/package.json').version);
  } catch {
    return null;
  }
}

/** Physical better-sqlite3 directory the desktop package resolves to. */
function sqliteDir() {
  return dirname(require.resolve('better-sqlite3/package.json'));
}

function run(command, args, options = {}) {
  // `shell: false` is important: with a shell, Windows re-splits the absolute
  // paths above and prebuild-install silently fails instead of downloading.
  return spawnSync(command, args, { stdio: 'inherit', ...options });
}

const version = electronVersion();
if (!version) {
  console.log('[rebuild-native] electron is missing; skipping native rebuild');
  process.exit(0);
}

const target = sqliteDir();
// prebuild-install must run with the target package as cwd: it locates the
// package name/version by walking up for the nearest package.json. Run from the
// workspace root and it would target "@robrowser/desktop" instead.
const prebuildBin = join(dirname(target), 'prebuild-install', 'bin.js');
const args = [
  '--runtime=electron',
  `--target=${version}`,
  `--arch=${process.arch}`,
  '--force',
  '--verbose',
];

console.log(`[rebuild-native] better-sqlite3 : ${target}`);
console.log(`[rebuild-native] electron target: ${version}`);

if (existsSync(prebuildBin)) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log(`[rebuild-native] prebuild-install attempt ${attempt}/3`);
    const code = run(process.execPath, [prebuildBin, ...args], { cwd: target }).status;
    if (code === 0) {
      console.log('[rebuild-native] electron prebuild installed');
      process.exit(0);
    }
  }
}

console.log('[rebuild-native] prebuild unavailable; compiling from source');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const gyp = run(
  npx,
  [
    '--yes',
    'node-gyp',
    'rebuild',
    '--release',
    `--target=${version}`,
    '--dist-url=https://electronjs.org/headers',
    `--arch=${process.arch}`,
  ],
  { cwd: target },
);
process.exit(gyp.status ?? 1);
