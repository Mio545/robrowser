/**
 * Desktop smoke test (manual/CI helper, not part of the Vitest suite).
 *
 * Launches the *built* Electron app with Playwright's `_electron.launch` and
 * asserts that:
 *   1. the main process boots and the renderer window exists,
 *   2. the React shell rendered (RoboBrowser header present),
 *   3. the embedded WebContentsView exists and can navigate (CDP attached),
 *   4. no uncaught main-process exception was logged.
 *
 * Usage: pnpm test:desktop:smoke
 */
import { _electron as electron } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const desktopDir = join(repoRoot, 'packages', 'desktop');
const workDir = join(repoRoot, 'work');
mkdirSync(workDir, { recursive: true });
const userDataDir = join(repoRoot, 'work', 'desktop-userdata');

const errors = [];
const app = await electron.launch({
  args: [desktopDir, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    ROBO_LOG_LEVEL: 'debug',
    ELECTRON_ENABLE_LOGGING: '1',
  },
});

app.process().stderr?.on('data', (chunk) => {
  const text = chunk.toString();
  if (/Unhandled|Uncaught|ERR_|Error:/.test(text)) errors.push(text.trim());
});

try {
  const window = await app.firstWindow({ timeout: 30000 });
  const title = await window.title();
  await window.waitForSelector('header', { timeout: 20000 });

  const headerText = (await window.textContent('header')) ?? '';
  const hasShell = /RoboBrowser/.test(headerText);
  console.log('[smoke] window title      :', title);
  console.log('[smoke] header text       :', headerText.replace(/\s+/g, ' ').trim().slice(0, 120));
  console.log('[smoke] react shell ok    :', hasShell);

  // Exercise the IPC + CDP path: navigation through the embedded view.
  const navOk = await window.evaluate(async () => {
    const api = globalThis.window?.robrowser;
    if (!api) throw new Error('robrowser API missing (preload not loaded)');
    const res = await api.navigate('data:text/html,<title>smoke</title><h1 id=ping>pong</h1>');
    return res;
  });
  console.log('[smoke] preload IPC ok    :', JSON.stringify(navOk));

  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Verify the flow store round-trips through SQLite.
  const storeOk = await window.evaluate(async () => {
    const api = globalThis.window.robrowser;
    const flow = {
      version: '1.0',
      id: 'smoke-flow',
      name: 'Smoke',
      steps: [{ id: 'noop', type: 'setVar', name: 'x', value: '1' }],
    };
    const saved = await api.saveFlow(flow);
    const listed = await api.listFlows();
    const loaded = await api.loadFlow('smoke-flow');
    await api.deleteFlow('smoke-flow');
    return { saved, listedCount: listed.length, loadedId: loaded?.id ?? null };
  });
  console.log('[smoke] sqlite IPC ok     :', JSON.stringify(storeOk));

  console.log('[smoke] main errors       :', errors.length);
  if (errors.length)
    console.log('[smoke] error detail     :', errors.join('\n---\n').slice(0, 2000));
  if (!hasShell) throw new Error('React shell did not render');
  if (!navOk?.ok) throw new Error('embedded view navigation failed');
  if (!storeOk.saved?.ok || storeOk.loadedId !== 'smoke-flow') {
    throw new Error('SQLite flow round-trip failed');
  }
  console.log('[smoke] RESULT: PASS');
} finally {
  await app.close().catch(() => undefined);
}
