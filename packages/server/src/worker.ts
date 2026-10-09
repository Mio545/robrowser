/**
 * Worker process (spec 7.3 / 7.4).
 *
 * Runs exactly one flow in its own OS process so that:
 * - a browser crash cannot take the HTTP server down;
 * - `--no-sandbox` / Xvfb configuration is scoped to the worker;
 * - run events are streamed to the parent over IPC.
 *
 * The worker also hosts the takeover *session manager* (it owns the page), and
 * relays frames/input through the parent's back-channel.
 *
 * Entry point: `node worker.js` — the parent passes a `task` message on stdin
 * (Node IPC), so no arguments are required.
 */
import process from 'node:process';
import { mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createLogger } from './logger.js';
import { SqliteStorage } from './storage.js';
import { createRuntime } from './runtime.js';
import { TakeoverService, RemoteTakeoverHandler } from './takeover/service.js';
import { TicketService } from './takeover/tokens.js';
import { Notifier } from './notify/notifier.js';
import { LogNotificationChannel } from './notify/channels/log.js';
import { WebhookNotificationChannel } from './notify/channels/webhook.js';
import { EmailNotificationChannel } from './notify/channels/email.js';
import type { ParentMessage, WorkerMessage, WorkerTakeoverSession } from './worker-protocol.js';
import { setFlowBaseDir, toRoboError } from '@robrowser/core';

const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { scope: 'worker', pid: process.pid },
});

/** Send a message to the parent (no-op when not forked). */
function send(message: WorkerMessage): void {
  process.send?.(message);
}

/**
 * Build the notifier for this worker from the task configuration.
 */
function buildNotifier(channels: string[], webhookUrl?: string, notifyTo?: string): Notifier {
  const notifier = new Notifier(logger);
  notifier.register(new LogNotificationChannel(logger));
  if (webhookUrl) notifier.register(new WebhookNotificationChannel({ url: webhookUrl }));
  if (notifyTo) {
    const transport = process.env.SMTP_URL;
    if (transport) {
      notifier.register(
        new EmailNotificationChannel({
          transport,
          to: notifyTo,
          subjectPrefix: '[RoboBrowser]',
        }),
      );
    }
  }
  for (const channel of channels) {
    if (channel === 'webhook' && !webhookUrl) {
      logger.warn('webhook channel requested but WEBHOOK_URL is not set');
    }
    if (channel === 'email' && !process.env.SMTP_URL) {
      logger.warn('email channel requested but SMTP_URL is not set');
    }
  }
  return notifier;
}

/**
 * Execute one task. Exported so integration tests can drive the worker logic
 * in-process (importing this module forks nothing by itself).
 */
export async function runTask(message: Extract<ParentMessage, { type: 'task' }>): Promise<void> {
  const { flow, vars, runId, runDir, taskId, flowsDir } = message;

  // Submitted flows (HTTP / queued) have no file location, so relative URLs in
  // them resolve against the configured flows directory (spec 7.4).
  setFlowBaseDir(flowsDir);

  await mkdir(runDir, { recursive: true });

  const tickets = new TicketService({ secret: message.secret });
  const notifier = buildNotifier(message.notifyChannels, message.webhookUrl, message.notifyTo);

  // The takeover service needs the *page*, which only exists after the runtime
  // starts; we therefore create it lazily and hand it to the handler on demand.
  let service: TakeoverService | undefined;
  const events = new EventEmitter();

  // Bridge: TakeoverService -> IPC (frames + state changes).
  const attachBridge = (takeover: TakeoverService): void => {
    takeover.on('session', (info) => {
      const session: WorkerTakeoverSession = {
        sessionId: info.sessionId,
        runId: info.runId,
        stepId: info.stepId,
        reason: info.reason,
        message: info.message,
        expiresAt: info.expiresAt,
      };
      send({ type: 'takeover-session', session });
    });
    takeover.on('frame', (payload) => {
      send({
        type: 'takeover-frame',
        sessionId: payload.sessionId,
        data: payload.data,
        metadata: payload.metadata,
      });
    });
    takeover.on('state', (info) => {
      send({ type: 'takeover-state', sessionId: info.sessionId, state: info.state });
    });
    takeover.on('clients', (payload) => {
      send({ type: 'takeover-clients', sessionId: payload.sessionId, clients: payload.clients });
    });
  };

  const runtime = createRuntime({
    logger,
    config: {
      HOST: '127.0.0.1',
      PORT: 0,
      RUN_DIR: runDir,
      HEADLESS: message.headless,
      CHROME_ARGS: message.chromeArgs.join(','),
      SECRET: message.secret,
      PUBLIC_URL: message.publicUrl,
      TAKEOVER_TTL_SECONDS: 600,
      NOTIFY_CHANNELS: message.notifyChannels.join(','),
      LOG_LEVEL: 'info',
      MAX_CONCURRENCY: 1,
      TASK_TIMEOUT_MS: 900_000,
      TASK_RETRIES: 0,
      TAKEOVER_SINGLE_CLIENT: true,
      ...(message.chromePath ? { CHROME_PATH: message.chromePath } : {}),
      ...(message.webhookUrl ? { WEBHOOK_URL: message.webhookUrl } : {}),
      ...(message.notifyTo ? { NOTIFY_TO: message.notifyTo } : {}),
    } as never,
    manual: {
      request: async (req) => {
        if (!service) throw new Error('takeover service is not ready');
        return new RemoteTakeoverHandler(service).request(req);
      },
    },
  });

  let aborted = false;
  const controller = new AbortController();

  const onMessage = (raw: unknown): void => {
    const parentMessage = raw as ParentMessage;
    if (parentMessage.type === 'cancel') {
      aborted = true;
      controller.abort();
      return;
    }
    if (parentMessage.type === 'takeover-input' && service) {
      void service
        .handleMessage(parentMessage.sessionId, parentMessage.clientId, parentMessage.message)
        .catch((error: unknown) => {
          logger.warn({ err: String(error) }, 'takeover input failed');
        });
    }
  };
  process.on('message', onMessage);

  try {
    await runtime.start();

    service = new TakeoverService({
      logger,
      tickets,
      notifier,
      publicUrl: message.publicUrl,
      singleClient: true,
    });
    attachBridge(service);

    runtime.bus().onAny((event) => {
      send({ type: 'event', event });
    });

    const result = await runtime.run(flow, {
      runId,
      vars,
      runDir,
      signal: controller.signal,
    });

    if (service) await service.abortAll('run finished');

    if (result.status === 'success') {
      send({ type: 'done', result });
    } else {
      send({
        type: 'done',
        result,
        error: result.error ?? {
          code: aborted ? 'RUN_ABORTED' : 'STEP_FAILED',
          message: `run finished with status ${result.status} (${result.reason})`,
        },
      });
    }
  } catch (thrown) {
    const error = toRoboError(thrown);
    send({ type: 'done', error: { code: error.code, message: error.message } });
  } finally {
    process.off('message', onMessage);
    await runtime.stop().catch(() => undefined);
    void events;
    void taskId;
  }
}

/* ------------------------------------------------------------------ entry */

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');

if (isMain) {
  send({ type: 'ready', pid: process.pid });
  process.on('message', (raw: unknown) => {
    const message = raw as ParentMessage;
    if (message.type === 'task') {
      void runTask(message).finally(() => {
        // Give IPC a chance to flush before exiting.
        setTimeout(() => process.exit(0), 50);
      });
    }
    if (message.type === 'shutdown') {
      process.exit(0);
    }
  });
}

void SqliteStorage;
