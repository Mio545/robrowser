/**
 * Desktop manual-intervention end-to-end check (helper, not part of Vitest).
 *
 * Usage: pnpm test:desktop:manual   (requires `pnpm build` first)
 *
 * Drives the *built* Electron app through a real `manual` step and asserts:
 *   1. the embedded view navigates to the challenge page,
 *   2. `manual:request` surfaces the operator dialog,
 *   3. pressing "完成并继续" while `resolveWhen` is unsatisfied is REJECTED (the
 *      regression that let the run resume with no challenge solved),
 *   4. the dialog and its buttons are actually clickable - the native
 *      WebContentsView must not bury them (regression: real clicks timed out),
 *   5. after the "human" completes the challenge, the same button resumes the
 *      run, which finishes and is persisted as success.
 */
import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const desktopDir = join(repoRoot, 'packages', 'desktop');
const workDir = join(repoRoot, 'work');
mkdirSync(workDir, { recursive: true });

const CHALLENGE_URL =
  'data:text/html,' +
  encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
<title>Manual check</title></head><body>
<h1>Human check</h1><p>Enter the code to continue.</p>
<div id="state">waiting</div>
</body></html>`);

const FLOW = {
  version: '1.0',
  id: 'manual-e2e',
  name: 'Manual E2E',
  steps: [
    { id: 'open-challenge', type: 'goto', url: CHALLENGE_URL, waitUntil: 'load' },
    {
      id: 'solve-challenge',
      type: 'manual',
      reason: 'captcha',
      message: 'Please solve the human check in the embedded browser.',
      timeoutMs: 120000,
      resolveWhen: { name: 'solved', match: { all: [{ selector: '#verified' }] } },
    },
    { id: 'mark-done', type: 'setVar', name: 'result', value: 'resumed' },
  ],
};

const app = await electron.launch({
  args: [desktopDir],
  env: { ...process.env, ROBO_LOG_LEVEL: 'info' },
});

const failures = [];
const check = (label, condition) => {
  console.log(`[manual] ${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) failures.push(label);
};

async function capture(name) {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    return (await win.capturePage()).toPNG().toString('base64');
  });
  if (!base64) return;
  writeFileSync(join(workDir, `${name}.png`), Buffer.from(base64, 'base64'));
  console.log(`[manual] captured work/${name}.png`);
}

/** Run JS inside the embedded automation view (not the renderer window). */
async function embeddedEval(code) {
  return app.evaluate(async ({ webContents }, source) => {
    const all = webContents.getAllWebContents();
    const target = all.find((contents) => !contents.getURL().includes('dist/renderer'));
    if (!target) throw new Error('embedded view not found');
    if (target.isDestroyed()) throw new Error('embedded view destroyed');
    return target.executeJavaScript(source, true);
  }, code);
}

try {
  const window = await app.firstWindow({ timeout: 30000 });
  await window.waitForSelector('header', { timeout: 20000 });
  // The run button is disabled until the CDP bridge is ready; wait for it.
  await window.waitForFunction(
    () => {
      const button = [...document.querySelectorAll('header button')].find(
        (element) => element.textContent?.trim() === '运行',
      );
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 30000 },
  );
  check('host reported ready (run button enabled)', true);

  const saved = await window.evaluate((flow) => window.robrowser.saveFlow(flow), FLOW);
  check('flow saved to sqlite', saved.ok === true);

  const started = await window.evaluate((flow) => window.robrowser.startRun({ flow }), FLOW);
  check('run accepted', started.ok === true);

  await window.waitForSelector('.rb-manual', { timeout: 30000 });
  const dialogText = (await window.textContent('.rb-manual')) ?? '';
  check('manual dialog shown', /需要人工处理/.test(dialogText));
  check('dialog carries the step message', /human check/i.test(dialogText));
  check(
    'embedded view on challenge page',
    String(await embeddedEval('location.href')).startsWith('data:text/html'),
  );
  await capture('manual-dialog-open');

  // --- real clickability: the native view must not cover the buttons ---
  const continueButton = window.locator('.rb-manual button.rb-primary');
  const box = await continueButton.boundingBox();
  const nativeLeft = await app.evaluate(({ BrowserWindow }) => {
    const size = BrowserWindow.getAllWindows()[0].getContentSize();
    return Math.round((size[0] ?? 1500) * 0.38) + 8;
  });
  check(
    'dialog button is outside the native browser surface',
    box !== null && box.x + box.width <= nativeLeft,
  );

  // --- premature resume must be rejected, not silently accepted ---
  await continueButton.click({ timeout: 10000 });
  await window.waitForSelector('.rb-banner-error', { timeout: 20000 });
  const banner = (await window.textContent('.rb-banner-error')) ?? '';
  check('premature resume rejected with guidance', /校验尚未通过/.test(banner));
  check('dialog still open after rejection', await window.locator('.rb-manual').isVisible());
  await window.waitForFunction(
    () => {
      const button = document.querySelector('.rb-manual button.rb-primary');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    undefined,
    { timeout: 20000 },
  );
  check('continue button usable again after rejection', true);

  // --- the "human" solves the challenge inside the embedded view ---
  await embeddedEval(
    "document.body.insertAdjacentHTML('beforeend','<div id=\"verified\">ok</div>')",
  );
  check(
    'challenge solved in embedded view',
    (await embeddedEval("!!document.querySelector('#verified')")) === true,
  );

  await continueButton.click({ timeout: 10000 });
  await window.waitForSelector('.rb-manual', { state: 'detached', timeout: 30000 });
  check('dialog closed after successful resume', true);

  await window.waitForFunction(() => document.body.innerText.includes('运行成功'), undefined, {
    timeout: 40000,
  });
  check('run reported success in the UI', true);

  const runs = await window.evaluate(() => window.robrowser.listRuns(10));
  const record = runs.find((run) => run.flowId === 'manual-e2e');
  check('run persisted as success', record?.status === 'success');
  check('persisted step count is 3', record?.stepCount === 3);
  console.log('[manual] persisted record:', JSON.stringify(record ?? null));
  await capture('manual-after-resume');
} catch (error) {
  console.error('[manual] ERROR', error);
  failures.push(`exception: ${error.message}`);
} finally {
  await app.close().catch(() => undefined);
}

if (failures.length) {
  console.error('[manual] RESULT: FAIL');
  for (const failure of failures) console.error('  -', failure);
  process.exit(1);
}
console.log('[manual] RESULT: PASS');
