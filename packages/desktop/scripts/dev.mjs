/**
 * Desktop development launcher (spec 9).
 *
 * Runs the pieces a developer needs, without pulling in a process-manager
 * dependency:
 *
 *   1. `vite` serves the renderer on a fixed port (5273);
 *   2. `scripts/build-main.mjs` bundles main + preload to CJS;
 *   3. Electron starts with `VITE_DEV_SERVER_URL` pointing at Vite, which is
 *      exactly what `src/main/index.ts` checks to decide between `loadURL`
 *      (dev) and `loadFile` (packaged).
 *
 * Ctrl+C tears every child down. Any child exiting ends the group so a crashed
 * Electron window does not leave a stray Vite server behind.
 *
 * `pnpm --filter @robrowser/desktop build` is still the way to produce the
 * packaged renderer; this script is only for interactive development.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5273';
const children = [];
let shuttingDown = false;

/** Spawn a command in this package directory, inheriting stdio. */
function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  children.push(child);
  return child;
}

/** Resolve with the child's exit code. */
function exited(child) {
  return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 0)));
}

/** Poll the dev server until it answers, so Electron never loads a blank URL. */
async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok || response.status === 404) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline)
      throw new Error(`Vite dev server did not start within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const vite = run('pnpm', ['exec', 'vite']);
void exited(vite).then((code) => shutdown(code === 0 ? 0 : 1));

await waitForServer(DEV_SERVER_URL);

const build = run('node', ['scripts/build-main.mjs']);
const buildCode = await exited(build);
if (buildCode !== 0) {
  shutdown(buildCode);
} else {
  const electron = run('pnpm', ['exec', 'electron', '.'], {
    VITE_DEV_SERVER_URL: DEV_SERVER_URL,
    NODE_ENV: 'development',
  });
  void exited(electron).then((code) => shutdown(code));
}
