/**
 * HTTP + WebSocket surface (spec 7.2 / 7.3 / 8).
 *
 * Endpoints
 *   POST   /runs                     submit a flow (body or flowId) -> runId
 *   GET    /runs/:id                 status + result
 *   GET    /runs                     list, paginated + filtered
 *   POST   /runs/:id/cancel          cancel
 *   WS     /runs/:id/events          stream typed step events
 *   GET    /healthz                  liveness
 *   POST   /takeover/exchange        swap a one-time ticket for a socket token
 *   GET    /takeover/ws              operator socket (frames + input)
 *   GET    /takeover/                static operator page
 *
 * All input is zod-validated and errors map to the platform error taxonomy.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import { assertValidFlow, RoboError, type FlowModel, type RunEvent } from '@robrowser/core';
import type { SqliteStorage } from './storage.js';
import type { TakeoverBackend } from './takeover/backend.js';
import { registerTakeoverRoutes } from './takeover/ws.js';
import { TicketService } from './takeover/tokens.js';
import type { TaskQueue } from './queue.js';

const require = createRequire(import.meta.url);

/** Options for {@link createHttpServer}. */
export interface HttpServerOptions {
  logger: Logger;
  storage: SqliteStorage;
  queue: TaskQueue;
  /** Takeover backend (in-process service or worker relay). */
  takeover: TakeoverBackend;
  /** Ticket exchange used by the takeover page. */
  tickets: TicketService;
  /** Public base URL used to build takeover links. */
  publicUrl: string;
  /** Host / port to bind. */
  host: string;
  port: number;
  /** Directory served as `/takeover` (defaults to `packages/server/public`). */
  publicDir?: string;
}

/** A created server plus its lifecycle helpers. */
export interface HttpServer {
  app: FastifyInstance;
  /** The address actually bound (resolves ephemeral ports for tests). */
  listen(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Zod schema for the `POST /runs` body.
 *
 * `flow` uses `z.custom` rather than `z.unknown()`: in zod 3 `z.unknown()` marks
 * object keys optional, which would let `{}` through as a flow submission.
 */
export const submitRunSchema = z.union([
  z.object({ flowId: z.string().min(1), vars: z.record(z.unknown()).optional() }).strict(),
  z
    .object({
      flow: z.custom<unknown>((value) => value !== undefined, { message: 'flow is required' }),
      vars: z.record(z.unknown()).optional(),
    })
    .strict(),
]);

/** Zod schema for `GET /runs` query parameters. */
export const listRunsSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  status: z
    .enum([
      'pending',
      'running',
      'paused',
      'success',
      'failed',
      'aborted',
      'queued',
      'succeeded',
      'cancelled',
    ])
    .optional(),
  flowId: z.string().optional(),
});

/**
 * Create the Fastify server. Call {@link HttpServer.listen} to bind it.
 */
export function createHttpServer(options: HttpServerOptions): HttpServer {
  const { logger, storage, queue, takeover, tickets, publicUrl } = options;
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });

  // @fastify/websocket installs an `onRoute` hook when it is registered.
  // Routes declared before that hook exists would be treated as plain HTTP
  // handlers, so every websocket route is registered inside a later plugin.
  void app.register(fastifyWebsocket);

  const publicDir = options.publicDir ?? defaultPublicDir();
  if (existsSync(publicDir)) {
    void app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/takeover/',
      decorateReply: false,
    });
  }

  /* ------------------------------------------------------------- health */

  app.get('/healthz', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    active: queue.activeCount(),
    takeoverSessions: takeoverSessionCount(takeover),
  }));

  /* --------------------------------------------------------------- runs */

  app.post('/runs', async (request, reply) => {
    const parsed = submitRunSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Body must be { flowId, vars? } or { flow, vars? }',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    let flow: FlowModel;
    try {
      if ('flowId' in parsed.data) {
        const stored = await storage.getFlow(parsed.data.flowId);
        if (!stored) {
          return reply
            .code(404)
            .send({ error: 'FLOW_NOT_FOUND', message: `Flow ${parsed.data.flowId} not found` });
        }
        flow = stored.flow;
      } else {
        flow = assertValidFlow(parsed.data.flow);
        await storage.saveFlow(flow);
      }
    } catch (error) {
      return sendError(reply, error);
    }

    const task = queue.enqueue(flow, (parsed.data.vars ?? {}) as Record<string, unknown>);
    return reply
      .code(202)
      .send({ runId: task.id, taskId: task.id, flowId: flow.id, status: task.status });
  });

  app.get('/runs', async (request, reply) => {
    const parsed = listRunsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'VALIDATION_ERROR', message: 'Invalid query', issues: parsed.error.issues });
    }
    const { items, total } = await storage.listRuns({
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
      ...(parsed.data.flowId ? { flowId: parsed.data.flowId } : {}),
      ...(parsed.data.status ? { status: parsed.data.status as never } : {}),
    });
    return reply.send({
      items,
      total,
      limit: parsed.data.limit ?? 50,
      offset: parsed.data.offset ?? 0,
    });
  });

  app.get('/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = storage.getTask(id);
    if (task) {
      const run = task.runId ? await storage.getRun(task.runId) : null;
      return reply.send({
        id: task.id,
        flowId: task.flowId,
        status: task.status,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        ...(task.startedAt ? { startedAt: task.startedAt } : {}),
        ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
        ...(task.runId ? { runId: task.runId } : {}),
        ...(task.errorCode ? { errorCode: task.errorCode } : {}),
        ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
        ...(run ? { result: run } : {}),
      });
    }
    const run = await storage.getRun(id);
    if (!run) {
      return reply.code(404).send({ error: 'RUN_NOT_FOUND', message: `Run ${id} not found` });
    }
    return reply.send(run);
  });

  app.post('/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    const cancelled = queue.cancel(id);
    if (!cancelled) {
      return reply
        .code(404)
        .send({ error: 'RUN_NOT_FOUND', message: `Run ${id} is not cancellable` });
    }
    return reply.send({ id, status: 'cancelled' });
  });

  /* ----------------------------------------------------- run event stream */

  void app.register(async (instance) => {
    instance.get(
      '/runs/:id/events',
      { websocket: true },
      (socket: import('ws').WebSocket, request: FastifyRequest) => {
        const { id } = request.params as { id: string };

        const onEvent = (event: unknown): void => {
          const typed = event as RunEvent;
          const belongs =
            (typed.payload as { runId?: string; taskId?: string }).runId === id ||
            (typed.payload as { taskId?: string }).taskId === id;
          if (!belongs) return;
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(typed));
        };

        queue.on('run:event', onEvent);

        // Send a snapshot immediately so a late subscriber is not blind.
        const task = storage.getTask(id);
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'snapshot', payload: { task: task ?? null } }));
        }

        socket.on('close', () => queue.off('run:event', onEvent));
        socket.on('error', () => queue.off('run:event', onEvent));
      },
    );
  });

  /* ----------------------------------------------------------- takeover */

  void app.register(async (instance) => {
    await registerTakeoverRoutes(instance, {
      service: takeover,
      verifyTicket: (ticket: string) => tickets.verify(ticket),
      issueSocketToken: (sessionId: string) => tickets.issueSocketToken(sessionId),
      verifySocketToken: (token: string) => tickets.verifySocketToken(token),
    });
  });

  /* -------------------------------------------------------------- errors */

  app.setErrorHandler((error: Error, _request, reply) => {
    return sendError(reply, error);
  });

  return {
    app,
    async listen(): Promise<string> {
      await app.listen({ host: options.host, port: options.port });
      const address = app.server.address();
      const actualPort = typeof address === 'object' && address ? address.port : options.port;
      const url = `http://${options.host}:${actualPort}`;
      logger.info({ url, publicUrl }, 'http server listening');
      return url;
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}

/** Map a RoboError (or unknown failure) to an HTTP status + body. */
function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  const robo = error as RoboError;
  const code: string = typeof robo?.code === 'string' ? robo.code : 'INTERNAL_ERROR';
  const status =
    code === 'VALIDATION_ERROR'
      ? 400
      : code === 'FLOW_NOT_FOUND' || code === 'RUN_NOT_FOUND'
        ? 404
        : code.startsWith('TOKEN')
          ? 401
          : code === 'TAKEOVER_ERROR'
            ? 409
            : code === 'MANUAL_TIMEOUT'
              ? 408
              : 500;
  return reply.code(status).send({
    error: code,
    message: robo?.message ?? 'Internal error',
    ...(robo?.details ? { details: robo.details } : {}),
  });
}

/** Number of live takeover sessions, tolerant of both backend shapes. */
function takeoverSessionCount(backend: TakeoverBackend): number {
  const candidate = backend as unknown as { size?: () => number; all?: () => unknown[] };
  if (typeof candidate.size === 'function') return candidate.size();
  if (typeof candidate.all === 'function') return candidate.all().length;
  return 0;
}

/** Locate `packages/server/public/takeover` from either `src` or `dist`. */
function defaultPublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'public'),
    resolve(here, '..', '..', 'public'),
    resolve(process.cwd(), 'packages', 'server', 'public'),
    resolve(process.cwd(), 'public'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'takeover'))) ?? candidates[0]!;
}

void require;
