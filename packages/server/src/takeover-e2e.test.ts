/**
 * Remote takeover end-to-end test (spec 8.2 / 8.3 / 8.6 / 8.9 / 11).
 *
 * Unlike the unit tests (which stub the takeover backend), this test wires the
 * *real* stack together:
 *
 *   real headless Chrome  <->  TakeoverService  <->  Fastify + @fastify/websocket
 *
 * and drives it through the operator WebSocket exactly like the bundled
 * `public/takeover` page does: one-time ticket -> POST /takeover/exchange ->
 * `GET /takeover/ws?token=...` -> mouse / text / complete messages.
 *
 * Everything is local (`file://` fixture, loopback HTTP) so the test never
 * touches the network. It is skipped when no Chromium executable is available.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pino } from 'pino';
import { WebSocket } from 'ws';
import type { PagePort } from '@robrowser/core';
import { defaultChromiumCandidates, RemoteBrowserAdapter, type CdpPage } from '@robrowser/browser';
import { createHttpServer, type HttpServer } from './http.js';
import { SqliteStorage } from './storage.js';
import { TaskQueue } from './queue.js';
import { TicketService } from './takeover/tokens.js';
import { TakeoverService } from './takeover/service.js';
import { Notifier } from './notify/notifier.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const logger = pino({ level: 'silent' });

function findChromium(): string | undefined {
  return defaultChromiumCandidates().find((candidate) => existsSync(candidate));
}

const chromium = findChromium();

interface ServerMessage {
  type?: string;
  [key: string]: unknown;
}

/** A tiny helper that resolves when a matching JSON message arrives. */
function waitForMessage(
  messages: ServerMessage[],
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 15_000,
): Promise<ServerMessage> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<ServerMessage>((resolvePromise, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = messages.find(predicate);
      if (match) {
        clearInterval(timer);
        resolvePromise(match);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }
    }, 50);
  });
}

interface SocketHandle {
  socket: WebSocket;
  messages: ServerMessage[];
  closeInfo?: { code: number; reason: string };
  readonly closed: Promise<{ code: number; reason: string }>;
}

/** Open a WebSocket and record every decoded server message. */
function openSocket(url: string): SocketHandle {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  const handle: SocketHandle = {
    socket,
    messages,
    closed: new Promise((resolvePromise) => {
      socket.on('close', (code, reason) => {
        handle.closeInfo = { code, reason: reason.toString() };
        resolvePromise(handle.closeInfo);
      });
    }),
  };
  socket.on('message', (raw: Buffer) => {
    const text = raw.toString('utf8');
    try {
      const parsed = JSON.parse(text) as ServerMessage;
      messages.push(parsed);
    } catch {
      // Ignore non-JSON payloads; the server never sends any.
    }
  });
  socket.on('error', () => undefined);
  return handle;
}

/** Wait until a WebSocket reaches OPEN. */
function waitForOpen(socket: WebSocket, timeoutMs = 10_000): Promise<void> {
  if (socket.readyState === socket.OPEN) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not open')), timeoutMs);
    socket.once('open', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe.skipIf(!chromium)('takeover e2e: real Chromium over WebSocket', () => {
  let runRoot = '';
  let adapter: RemoteBrowserAdapter | undefined;
  let page: CdpPage;
  let storage: SqliteStorage | undefined;
  let http: HttpServer | undefined;
  let takeover: TakeoverService | undefined;
  let tickets: TicketService | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    runRoot = await mkdtemp(join(tmpdir(), 'robrowser-takeover-'));

    adapter = new RemoteBrowserAdapter();
    await adapter.launch({ headless: true, executablePath: chromium! });
    const context = await adapter.newContext();
    page = (await context.newPage()) as CdpPage;
    await page.goto(pathToFileURL(join(repoRoot, 'fixtures', 'captcha.html')).href, {
      waitUntil: 'load',
    });

    tickets = new TicketService({ secret: 'takeover-e2e-secret', ttlSeconds: 600 });
    takeover = new TakeoverService({
      logger,
      tickets,
      notifier: new Notifier(logger),
      publicUrl: 'http://127.0.0.1:1',
      singleClient: true,
    });

    storage = new SqliteStorage(join(runRoot, 'takeover.sqlite'));
    const queue = new TaskQueue({
      storage,
      logger,
      concurrency: 1,
      timeoutMs: 5_000,
      maxAttempts: 1,
    });
    http = createHttpServer({
      logger,
      storage,
      queue,
      takeover,
      tickets,
      publicUrl: 'http://127.0.0.1:1',
      host: '127.0.0.1',
      port: 0,
    });
    baseUrl = await http.listen();
  }, 90_000);

  afterAll(async () => {
    await takeover?.abortAll('test teardown').catch(() => undefined);
    await http?.close().catch(() => undefined);
    await adapter?.close().catch(() => undefined);
    storage?.handle.close();
    if (runRoot) await rm(runRoot, { recursive: true, force: true });
  });

  afterEach(async () => {
    await takeover?.abortAll('test case finished').catch(() => undefined);
  });

  it('drives a real page end to end and resumes the manual step', async () => {
    const session = await takeover!.create({
      runId: 'run-e2e',
      stepId: 'human',
      reason: 'captcha',
      message: 'type the code',
      timeoutMs: 60_000,
      page: page as unknown as PagePort,
      resolveWhen: {
        name: 'verified',
        match: { any: [{ selector: 'body[data-verified="true"]', state: 'attached' }] },
      },
    });

    // The link handed to the operator points at the (placeholder) public URL;
    // in the test we talk to the ephemeral loopback server instead.
    const ticket = new URL(session.url).searchParams.get('ticket');
    expect(ticket).toBeTruthy();
    const exchange = await fetch(`${baseUrl}/takeover/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(exchange.status).toBe(200);
    const exchanged = (await exchange.json()) as {
      socketToken: string;
      session: { sessionId: string };
    };
    expect(exchanged.session.sessionId).toBe(session.sessionId);

    const handle = openSocket(
      `${baseUrl.replace('http', 'ws')}/takeover/ws?token=${exchanged.socketToken}`,
    );
    await waitForOpen(handle.socket);
    const hello = await waitForMessage(handle.messages, (message) => message.type === 'hello');
    expect(hello.operator).toBe(true);

    // A short round trip also proves the inbound message pipeline is live.
    handle.socket.send(JSON.stringify({ type: 'ping', t: 42 }));
    const pong = await waitForMessage(handle.messages, (message) => message.type === 'pong');
    expect(pong.t).toBe(42);

    // The screencast feeds the canvas; use its geometry as the client canvas.
    const frame = await waitForMessage(
      handle.messages,
      (message) => message.type === 'frame',
      20_000,
    );
    const metadata = frame.metadata as { deviceWidth: number; deviceHeight: number };
    const canvasWidth = metadata.deviceWidth;
    const canvasHeight = metadata.deviceHeight;

    // Locate the two controls via the real PagePort API (no hand-written
    // multi-line script: this also exercises the same query path the engine uses).
    const answer = await page.query({ testId: 'answer' });
    const verifyButton = await page.query({ testId: 'verify' });
    if (!answer || !verifyButton) throw new Error('captcha fixture controls not found');

    const click = (point: { x: number; y: number }): void => {
      for (const action of ['down', 'up'] as const) {
        handle.socket.send(
          JSON.stringify({
            type: 'mouse',
            action,
            x: point.x,
            y: point.y,
            button: 'left',
            clickCount: 1,
            canvasWidth,
            canvasHeight,
          }),
        );
      }
    };

    click(answer.box);
    handle.socket.send(JSON.stringify({ type: 'text', text: '7F3A' }));
    click(verifyButton.box);

    // Wait until the operator's click has actually been applied to the page.
    await expect
      .poll(
        async () => page.evaluate<string | null>('document.body.getAttribute("data-verified")'),
        {
          timeout: 10_000,
          interval: 100,
        },
      )
      .toBe('true');

    handle.socket.send(JSON.stringify({ type: 'complete' }));
    const result = await session.completed;
    expect(result).toEqual({ status: 'resolved', by: expect.stringMatching(/^client-/) });

    const resolved = await waitForMessage(
      handle.messages,
      (message) => message.type === 'resolved',
      10_000,
    );
    expect(resolved.by).toBe('operator');

    handle.socket.close();
  }, 90_000);

  it('rejects a WebSocket without a token', async () => {
    const handle = openSocket(`${baseUrl.replace('http', 'ws')}/takeover/ws`);
    const closed = await handle.closed;
    expect(closed.code).toBe(4401);
  });

  it('keeps a single operator: a second client is rejected while the first is active', async () => {
    const session = await takeover!.create({
      runId: 'run-single',
      stepId: 'human',
      reason: 'confirm',
      message: 'only one operator',
      timeoutMs: 30_000,
      page: page as unknown as PagePort,
    });
    const token = tickets!.issueSocketToken(session.sessionId);

    const first = openSocket(`${baseUrl.replace('http', 'ws')}/takeover/ws?token=${token}`);
    await waitForOpen(first.socket);
    await waitForMessage(first.messages, (message) => message.type === 'hello');

    const second = openSocket(`${baseUrl.replace('http', 'ws')}/takeover/ws?token=${token}`);
    const secondClosed = await second.closed;
    expect(secondClosed.code).toBe(4403);
    expect(second.messages.some((message) => message.type === 'error')).toBe(true);

    await first.socket.close();
  }, 60_000);
});

describe.skipIf(Boolean(chromium))('takeover e2e: real Chromium over WebSocket', () => {
  it('is skipped because no Chromium/Chrome executable was found', () => {
    expect(chromium).toBeUndefined();
  });
});
