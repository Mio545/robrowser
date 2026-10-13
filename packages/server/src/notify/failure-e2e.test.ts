/**
 * End-to-end test: a run that stops without succeeding must actually reach a
 * configured notification channel (spec 8.7).
 *
 * The worker is driven in-process (no fork) against a real local Chromium and a
 * real HTTP receiver, so this covers the whole path the operator depends on:
 * flow -> orchestrator -> worker -> notifier -> HTTP webhook.
 *
 * Skipped (not failed) when no Chromium executable is installed, mirroring
 * `integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlowModel } from '@robrowser/core';
import { defaultChromiumCandidates } from '@robrowser/browser';
import { runTask } from '../worker.js';

// Vitest executes specs inside a tinypool child process, so `process.send`
// exists and vitest@ own IPC bridge would receive the worker messages. The
// scenarios below only care about the notification side effect, so the IPC
// channel is stubbed out.
process.send = (): boolean => true;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const chromium = defaultChromiumCandidates().find((candidate) => existsSync(candidate));

/** Per-test scratch directory (created in `beforeAll`). */
let runRoot = '';

/** An HTTP receiver that records every JSON body POSTed to it. */
interface Receiver {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const bodies: Array<Record<string, unknown>> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        bodies.push({ raw });
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/notify`,
    bodies,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/** A flow whose second step waits for a selector that never appears. */
function failingFlow(): FlowModel {
  return {
    version: '1.0',
    id: 'notify-e2e',
    name: 'Notify e2e',
    variables: {},
    steps: [
      { id: 'open', type: 'goto', url: 'about:blank', waitUntil: 'load' },
      {
        id: 'submit',
        type: 'waitForSelector',
        selector: { css: '#this-element-does-not-exist' },
        timeout: 750,
      },
    ],
  };
}

/** Options shared by both cases; only `notifyOnFailure` differs. */
function taskOptions(runId: string, webhookUrl: string, notifyOnFailure: boolean) {
  return {
    type: 'task' as const,
    taskId: runId,
    runId,
    flow: failingFlow(),
    vars: {},
    runDir: join(runRoot, runId),
    flowsDir: join(repoRoot, 'flows'),
    chromeArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
    chromePath: chromium!,
    headless: true,
    secret: 'notify-e2e-secret',
    notifyChannels: ['webhook'],
    webhookUrl,
    notifyOnFailure,
    publicUrl: 'http://127.0.0.1:1',
  };
}

describe.skipIf(!chromium)('worker run-failure notification', () => {
  let receiver: Receiver;

  beforeAll(async () => {
    runRoot = await mkdtemp(join(tmpdir(), 'robrowser-notify-'));
    receiver = await startReceiver();
  });

  afterAll(async () => {
    await receiver?.close();
    if (runRoot) await rm(runRoot, { recursive: true, force: true });
  });

  it('posts a run.failed payload naming the failing step', async () => {
    await runTask(taskOptions('notify-e2e', receiver.url, true));

    expect(receiver.bodies).toHaveLength(1);
    const body = receiver.bodies[0]!;
    expect(body.type).toBe('run.failed');
    expect(body.kind).toBe('run-failed');
    expect(String(body.runId)).toMatch(/^notify-e2e-/);
    expect(body.stepId).toBe('submit');
    expect(String(body.text)).toContain('Run stopped and needs attention');
    // The failing step is reported, and the payload carries a copy-pasteable
    // summary so a receiver needs no template.
    expect(body.reason).toBe('STEP_TIMEOUT');
  }, 60_000);

  it('stays silent when NOTIFY_ON_FAILURE is off', async () => {
    receiver.bodies.length = 0;

    await runTask(taskOptions('notify-e2e-off', receiver.url, false));

    expect(receiver.bodies).toHaveLength(0);
  }, 60_000);
});
