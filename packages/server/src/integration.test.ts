/**
 * Integration test: run the real `flows/demo.json` against the local
 * `fixtures/*.html` files through Chrome over CDP (spec 11).
 *
 * No network access: every URL is `file://` inside this repository. The test is
 * skipped (not failed) when no Chromium executable can be found, so the suite
 * stays green on machines without a browser while CI (which installs one) still
 * exercises the full path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { loadFlow, type FlowModel } from '@robrowser/core';
import { defaultChromiumCandidates, RemoteBrowserAdapter, type CdpPage } from '@robrowser/browser';
import { createRuntime } from './runtime.js';
import { loadConfig } from './env.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const logger = pino({ level: 'silent' });

/** First existing Chromium candidate, or undefined when none is installed. */
function findChromium(): string | undefined {
  return defaultChromiumCandidates().find((candidate) => existsSync(candidate));
}

const chromium = findChromium();
const demoPath = join(repoRoot, 'flows', 'demo.json');

describe.skipIf(!chromium)('integration: demo flow on local fixtures', () => {
  let runRoot = '';

  beforeAll(async () => {
    runRoot = await mkdtemp(join(tmpdir(), 'robrowser-integration-'));
  });

  afterAll(async () => {
    if (runRoot) await rm(runRoot, { recursive: true, force: true });
  });

  it('runs goto → waitForPage → type ×2 → click → branch → extract/screenshot', async () => {
    const flow: FlowModel = await loadFlow(demoPath);
    const config = loadConfig({
      RUN_DIR: runRoot,
      CHROME_PATH: chromium!,
      HEADLESS: 'true',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);

    const runtime = createRuntime({ logger, config });
    try {
      await runtime.start();
      const result = await runtime.run(flow, {
        runId: 'integration-demo',
        vars: { username: 'alice', password: 's3cret' },
        runDir: join(runRoot, 'integration-demo'),
      });

      expect(result.status, JSON.stringify(result.error)).toBe('success');
      expect(result.variables.orders).toBe('128');
      expect(result.variables.activities).toEqual([
        'Order #1042 shipped',
        'Order #1041 delivered',
        'New customer signed up',
      ]);
      expect(result.variables.password).toBe('***');
      expect(result.artifacts.some((path) => path.endsWith('dashboard.png'))).toBe(true);
      const page = runtime.page() as CdpPage;
      expect(await page.url()).toContain('dashboard.html?username=alice');
    } finally {
      await runtime.stop().catch(() => undefined);
    }
  }, 90_000);

  it('runs the captcha fixture through a manual step with resolveWhen', async () => {
    const flow: FlowModel = {
      version: '1.0',
      id: 'captcha-flow',
      name: 'Captcha flow',
      variables: {
        fixtures: { type: 'const', value: `${join(repoRoot, 'fixtures')}/` },
      },
      steps: [
        { id: 'open', type: 'goto', url: '{{fixtures}}captcha.html', waitUntil: 'load' },
        { id: 'answer', type: 'type', selector: { testId: 'answer' }, value: '7F3A', clear: true },
        { id: 'verify', type: 'click', selector: { testId: 'verify' } },
        { id: 'human', type: 'manual', reason: 'captcha', message: 'confirm', timeoutMs: 10_000 },
        {
          id: 'check',
          type: 'branch',
          condition: { selectorExists: { css: 'body[data-verified="true"]' } },
          then: [{ id: 'ok', type: 'setVar', name: 'verified', value: true }],
          else: [{ id: 'no', type: 'setVar', name: 'verified', value: false }],
        },
      ],
    };

    const config = loadConfig({
      RUN_DIR: runRoot,
      CHROME_PATH: chromium!,
      HEADLESS: 'true',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);

    const runtime = createRuntime({
      logger,
      config,
      // The fixture is deterministic, so a scripted operator is enough here;
      // the real WebSocket takeover path is covered by the takeover tests.
      manual: { request: async () => ({ status: 'resolved', by: 'test' }) },
    });

    try {
      await runtime.start();
      const result = await runtime.run(flow, { runDir: join(runRoot, 'captcha') });
      expect(result.status, JSON.stringify(result.error)).toBe('success');
      expect(result.variables.verified).toBe(true);
    } finally {
      await runtime.stop().catch(() => undefined);
    }
  }, 90_000);

  it('connects a second time to an external --remote-debugging-port Chromium', async () => {
    const adapter = new RemoteBrowserAdapter();
    const externalRoot = await mkdtemp(join(tmpdir(), 'robrowser-external-'));
    try {
      await adapter.launch({
        headless: true,
        executablePath: chromium!,
        port: 0,
        userDataDir: externalRoot,
      });
      expect(adapter.connected).toBe(true);
      const port = adapter.debuggingPort;
      expect(port && port > 0).toBe(true);

      const second = new RemoteBrowserAdapter();
      await second.connect(`http://127.0.0.1:${port}`);
      const context = await second.newContext();
      const page = (await context.newPage()) as CdpPage;
      await page.goto('about:blank');
      expect(await page.url()).toContain('about:blank');
      await second.close();
    } finally {
      await adapter.close().catch(() => undefined);
      await rm(externalRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(Boolean(chromium))('integration: demo flow on local fixtures', () => {
  it('is skipped because no Chromium/Chrome executable was found', () => {
    expect(chromium).toBeUndefined();
  });
});
