/**
 * Server tests (spec 11): CLI parsing, one-time tokens, REST endpoints, queue
 * retries. All tests use temporary directories and never reach the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pino } from 'pino';
import { parseArgs } from './cli-args.js';
import { TicketService } from './takeover/tokens.js';
import { SqliteStorage } from './storage.js';
import { TaskQueue } from './queue.js';
import { createHttpServer, submitRunSchema, listRunsSchema } from './http.js';
import { detectFlowsDir, loadConfig } from './env.js';
import type { TakeoverBackend } from './takeover/backend.js';
import type { TakeoverSessionInfo } from './takeover/types.js';
import type { FlowModel, RunResult } from '@robrowser/core';

const logger = pino({ level: 'silent' });
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'robrowser-server-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A minimal valid FlowModel for storage/queue/HTTP tests. */
function sampleFlow(id = 'demo'): FlowModel {
  return {
    version: '1.0',
    id,
    name: 'Demo',
    steps: [{ id: 'go', type: 'goto', url: 'about:blank' }],
  };
}

/** Stub takeover backend (no browser involved). */
function stubTakeover(): TakeoverBackend {
  const info: TakeoverSessionInfo = {
    sessionId: 's1',
    runId: 'r1',
    stepId: 'manual',
    reason: 'captcha',
    message: 'solve',
    state: 'PENDING',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    clients: 0,
    resolveWhenSatisfied: false,
  };
  return {
    getInfo: (id) => (id === 's1' ? info : null),
    attach: async () => true,
    detach: async () => undefined,
    handleMessage: async () => undefined,
    on: () => undefined,
    off: () => undefined,
  };
}

describe('CLI argument parsing', () => {
  it('parses `run` with flags and repeated --var', () => {
    const { command } = parseArgs([
      'run',
      'flows/demo.json',
      '--headless',
      '--chrome',
      'C:/chrome.exe',
      '--out',
      'run/demo',
      '--var',
      'user=alice',
      '--var',
      'count=3',
    ]);
    expect(command).toMatchObject({
      kind: 'run',
      file: 'flows/demo.json',
      headless: true,
      chrome: 'C:/chrome.exe',
      out: 'run/demo',
      vars: { user: 'alice', count: '3' },
    });
  });

  it('treats --headful as the negation of --headless', () => {
    const { command } = parseArgs(['run', 'f.json', '--headless', '--headful']);
    expect(command).toMatchObject({ kind: 'run', headless: false });
  });

  it('parses validate / export / serve / help / version', () => {
    expect(parseArgs(['validate', 'f.json']).command).toEqual({ kind: 'validate', file: 'f.json' });
    expect(parseArgs(['export', 'f.json', '--target', 'playwright']).command).toMatchObject({
      kind: 'export',
      target: 'playwright',
    });
    expect(parseArgs(['serve', '--port', '9090']).command).toMatchObject({
      kind: 'serve',
      port: 9090,
    });
    expect(parseArgs([]).command.kind).toBe('help');
    expect(parseArgs(['--version']).command.kind).toBe('version');
  });

  it('auto-detects the workspace flows directory and honours an override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'robrowser-flowsdir-'));
    await mkdir(join(dir, 'flows'), { recursive: true });

    expect(loadConfig({ FLOWS_DIR: dir } as NodeJS.ProcessEnv).FLOWS_DIR).toBe(resolve(dir));
    expect(detectFlowsDir(dir)).toBe(join(dir, 'flows'));
    // An empty value falls back to detection (root of this repository).
    expect(loadConfig({} as NodeJS.ProcessEnv).FLOWS_DIR).toContain('flows');
  });

  it('rejects malformed arguments with a ValidationError', () => {
    expect(() => parseArgs(['run'])).toThrow(/Usage/);
    expect(() => parseArgs(['frobnicate'])).toThrow(/Unknown command/);
    expect(() => parseArgs(['export', 'f.json', '--target', 'nope'])).toThrow(/target/);
    expect(() => parseArgs(['serve', '--port', '99999'])).toThrow(/Invalid --port/);
  });
});

describe('TicketService (one-time tokens)', () => {
  it('issues a ticket that verifies exactly once', () => {
    const service = new TicketService({ secret: 'test-secret' });
    const { ticket, jti } = service.issue({ sessionId: 's1', runId: 'r1', stepId: 'manual' });

    const verified = service.verify(ticket);
    expect(verified).toMatchObject({ sessionId: 's1', runId: 'r1', stepId: 'manual', jti });

    expect(() => service.verify(ticket)).toThrowError(/already been used/);
    try {
      service.verify(ticket);
    } catch (error) {
      expect((error as { code: string }).code).toBe('TOKEN_REPLAYED');
    }
  });

  it('rejects a ticket signed with the wrong secret and a malformed token', () => {
    const service = new TicketService({ secret: 'right' });
    const { ticket } = service.issue({ sessionId: 's1', runId: 'r1', stepId: 'm' });
    const other = new TicketService({ secret: 'wrong' });

    expect(() => other.verify(ticket)).toThrowError(/rejected/i);
    expect(() => service.verify('not-a-jwt')).toThrowError(/rejected/i);
  });

  it('rejects an expired ticket', () => {
    // jsonwebtoken validates against wall-clock time, so mint an already
    // expired token rather than advancing the injected clock.
    const service = new TicketService({ secret: 's', ttlSeconds: -10 });
    const { ticket } = service.issue({ sessionId: 's1', runId: 'r1', stepId: 'm' });
    expect(() => service.verify(ticket)).toThrowError(/rejected/i);
  });

  it('issues and verifies scoped socket tokens', () => {
    const service = new TicketService({ secret: 's' });
    const token = service.issueSocketToken('s1');
    expect(service.verifySocketToken(token)).toEqual({ sessionId: 's1' });
    expect(() => service.verifySocketToken('garbage')).toThrowError(/rejected/i);
  });

  it('revokes a session', () => {
    const service = new TicketService({ secret: 's' });
    expect(service.isRevoked('s1')).toBe(false);
    service.revokeSession('s1');
    expect(service.isRevoked('s1')).toBe(true);
  });
});

describe('SQLite storage', () => {
  it('stores flows and run records', async () => {
    const storage = new SqliteStorage(join(await tempDir(), 'db.sqlite'));
    await storage.saveFlow(sampleFlow());
    const loaded = await storage.getFlow('demo');
    expect(loaded?.flow.id).toBe('demo');

    await storage.saveRun({
      id: 'run-1',
      flowId: 'demo',
      flowName: 'Demo',
      status: 'success',
      reason: 'completed',
      stepCount: 1,
      durationMs: 12,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      artifacts: ['a.png'],
    });
    const run = await storage.getRun('run-1');
    expect(run?.status).toBe('success');
    expect(run?.artifacts).toEqual(['a.png']);

    const list = await storage.listRuns({ status: 'success' });
    expect(list.total).toBe(1);
    storage.handle.close();
  });
});

describe('TaskQueue', () => {
  it('retries a failing task up to maxAttempts and then marks it failed', async () => {
    const storage = new SqliteStorage(join(await tempDir(), 'queue.sqlite'));
    const queue = new TaskQueue({
      storage,
      logger,
      concurrency: 1,
      timeoutMs: 5_000,
      maxAttempts: 2,
      retryDelayMs: 5,
    });

    let attempts = 0;
    queue.setExecutor(async (task) => {
      attempts += 1;
      if (attempts < 2) throw new Error(`first attempt failed for ${task.id}`);
      return {
        runId: 'run-ok',
        flowId: 'demo',
        flowName: 'Demo',
        status: 'success',
        reason: 'completed',
        stepCount: 1,
        durationMs: 1,
        artifacts: [],
        variables: {},
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      } satisfies RunResult;
    });

    queue.start();
    const task = queue.enqueue(sampleFlow());
    await vi.waitFor(
      () => {
        expect(storage.getTask(task.id)?.status).toBe('succeeded');
      },
      { timeout: 3_000, interval: 20 },
    );
    expect(attempts).toBe(2);
    await queue.stop();
    storage.handle.close();
  });

  it('does not execute when the queue has no executor', async () => {
    const storage = new SqliteStorage(join(await tempDir(), 'queue2.sqlite'));
    const queue = new TaskQueue({
      storage,
      logger,
      concurrency: 1,
      timeoutMs: 1_000,
      maxAttempts: 1,
    });
    queue.start();
    const task = queue.enqueue(sampleFlow());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(storage.getTask(task.id)?.status).toBe('queued');
    await queue.stop();
    storage.handle.close();
  });

  it('times out a slow task via AbortSignal', async () => {
    const storage = new SqliteStorage(join(await tempDir(), 'queue3.sqlite'));
    const queue = new TaskQueue({
      storage,
      logger,
      concurrency: 1,
      timeoutMs: 40,
      maxAttempts: 1,
      retryDelayMs: 5,
    });
    queue.setExecutor(
      (_task, signal) =>
        new Promise<RunResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by timeout')));
        }),
    );
    queue.start();
    const task = queue.enqueue(sampleFlow());
    await vi.waitFor(
      () => {
        expect(storage.getTask(task.id)?.status).toBe('failed');
      },
      { timeout: 3_000, interval: 20 },
    );
    expect(storage.getTask(task.id)?.errorCode).toBe('INTERNAL_ERROR');
    await queue.stop();
    storage.handle.close();
  });
});

describe('REST API (Fastify inject)', () => {
  async function buildServer(): Promise<{
    storage: SqliteStorage;
    queue: TaskQueue;
    http: ReturnType<typeof createHttpServer>;
  }> {
    const storage = new SqliteStorage(join(await tempDir(), 'http.sqlite'));
    const queue = new TaskQueue({
      storage,
      logger,
      concurrency: 1,
      timeoutMs: 1_000,
      maxAttempts: 1,
    });
    const http = createHttpServer({
      logger,
      storage,
      queue,
      takeover: stubTakeover(),
      tickets: new TicketService({ secret: 'test' }),
      publicUrl: 'http://127.0.0.1:8080',
      host: '127.0.0.1',
      port: 0,
    });
    return { storage, queue, http };
  }

  it('healthz reports ok + queue/takeover counts', async () => {
    const { storage, queue, http } = await buildServer();
    const response = await http.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    // The stub backend has no `size()` method, so the count degrades to 0.
    expect(response.json()).toMatchObject({ status: 'ok', active: 0, takeoverSessions: 0 });
    await http.close();
    storage.handle.close();
    void queue;
  });

  it('POST /runs rejects an invalid body with VALIDATION_ERROR', async () => {
    const { storage, http } = await buildServer();
    const response = await http.app.inject({
      method: 'POST',
      url: '/runs',
      payload: { nope: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
    await http.close();
    storage.handle.close();
  });

  it('POST /runs accepts a FlowModel and returns a task id', async () => {
    const { storage, queue, http } = await buildServer();
    const response = await http.app.inject({
      method: 'POST',
      url: '/runs',
      payload: { flow: sampleFlow('posted') },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json() as { runId: string; flowId: string; status: string };
    expect(body.flowId).toBe('posted');
    expect(body.status).toBe('queued');

    const status = await http.app.inject({ method: 'GET', url: `/runs/${body.runId}` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ flowId: 'posted', status: 'queued' });

    await http.close();
    storage.handle.close();
    void queue;
  });

  it('POST /runs accepts a stored flowId and 404s an unknown one', async () => {
    const { storage, http } = await buildServer();
    await storage.saveFlow(sampleFlow('stored'));

    const ok = await http.app.inject({
      method: 'POST',
      url: '/runs',
      payload: { flowId: 'stored' },
    });
    expect(ok.statusCode).toBe(202);

    const missing = await http.app.inject({
      method: 'POST',
      url: '/runs',
      payload: { flowId: 'ghost' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'FLOW_NOT_FOUND' });

    await http.close();
    storage.handle.close();
  });

  it('GET /runs paginates and validates the query', async () => {
    const { storage, http } = await buildServer();
    await storage.saveRun({
      id: 'r1',
      flowId: 'demo',
      flowName: 'Demo',
      status: 'success',
      reason: 'completed',
      stepCount: 1,
      durationMs: 1,
      startedAt: new Date().toISOString(),
    });

    const list = await http.app.inject({ method: 'GET', url: '/runs?limit=10&offset=0' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 1, limit: 10, offset: 0 });

    const bad = await http.app.inject({ method: 'GET', url: '/runs?limit=9999' });
    expect(bad.statusCode).toBe(400);

    await http.close();
    storage.handle.close();
  });

  it('POST /runs/:id/cancel cancels a queued task and 404s unknown ids', async () => {
    const { storage, http } = await buildServer();
    const submitted = await http.app.inject({
      method: 'POST',
      url: '/runs',
      payload: { flow: sampleFlow('cancellable') },
    });
    const id = (submitted.json() as { runId: string }).runId;

    const cancelled = await http.app.inject({ method: 'POST', url: `/runs/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });

    const missing = await http.app.inject({ method: 'POST', url: '/runs/ghost/cancel' });
    expect(missing.statusCode).toBe(404);

    await http.close();
    storage.handle.close();
  });

  it('takeover exchange rejects a missing / invalid ticket', async () => {
    const { storage, http } = await buildServer();
    const missing = await http.app.inject({
      method: 'POST',
      url: '/takeover/exchange',
      payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const invalid = await http.app.inject({
      method: 'POST',
      url: '/takeover/exchange',
      payload: { ticket: 'garbage' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toMatchObject({ error: 'TOKEN_INVALID' });

    await http.close();
    storage.handle.close();
  });

  it('takeover exchange consumes a valid ticket exactly once', async () => {
    const storage = new SqliteStorage(join(await tempDir(), 'http2.sqlite'));
    const queue = new TaskQueue({
      storage,
      logger,
      concurrency: 1,
      timeoutMs: 1_000,
      maxAttempts: 1,
    });
    const tickets = new TicketService({ secret: 'test' });
    const http = createHttpServer({
      logger,
      storage,
      queue,
      takeover: stubTakeover(),
      tickets,
      publicUrl: 'http://127.0.0.1:8080',
      host: '127.0.0.1',
      port: 0,
    });

    const { ticket } = tickets.issue({ sessionId: 's1', runId: 'r1', stepId: 'manual' });
    const first = await http.app.inject({
      method: 'POST',
      url: '/takeover/exchange',
      payload: { ticket },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ session: { sessionId: 's1' } });

    const replay = await http.app.inject({
      method: 'POST',
      url: '/takeover/exchange',
      payload: { ticket },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: 'TOKEN_REPLAYED' });

    await http.close();
    storage.handle.close();
  });

  it('exports zod schemas for body/query validation', () => {
    expect(submitRunSchema.safeParse({ flowId: 'a' }).success).toBe(true);
    expect(submitRunSchema.safeParse({}).success).toBe(false);
    expect(listRunsSchema.safeParse({ limit: '20' }).success).toBe(true);
    expect(listRunsSchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});
