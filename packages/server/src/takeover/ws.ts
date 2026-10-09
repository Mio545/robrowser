/**
 * Takeover WebSocket endpoint (spec 8.2 / 8.4).
 *
 * Protocol
 * - The takeover page first calls `POST /takeover/exchange` with its one-time
 *   ticket. The server verifies + consumes the ticket's `jti`, then mints a
 *   short-lived socket token bound to the session.
 * - The page then opens `GET /takeover/ws?token=<socketToken>` and receives:
 *   `hello`, `frame` (base64 JPEG + metadata), `state`, `resolved`, `error`.
 * - Client -> server messages are validated with zod before being handed to
 *   {@link TakeoverBackend}.
 *
 * Security notes
 * - The one-time ticket never travels over the WebSocket; only the derived
 *   socket token does.
 * - Input is only accepted from the *active operator* (enforced in the service
 *   and mirrored in the parent-side worker relay).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TakeoverError } from '@robrowser/core';
import type { TakeoverBackend } from './backend.js';
import type { TakeoverSessionInfo } from './types.js';

/** Zod schema for inbound client messages. */
const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('claim') }).strict(),
  z
    .object({
      type: z.literal('mouse'),
      action: z.enum(['move', 'down', 'up', 'wheel']),
      x: z.number(),
      y: z.number(),
      button: z.string().optional(),
      clickCount: z.number().int().positive().optional(),
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
      modifiers: z.array(z.string()).optional(),
      canvasWidth: z.number().positive(),
      canvasHeight: z.number().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal('key'),
      action: z.enum(['down', 'up', 'press']),
      key: z.string().min(1),
      modifiers: z.array(z.string()).optional(),
    })
    .strict(),
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('complete') }).strict(),
  z.object({ type: z.literal('ping'), t: z.number() }).strict(),
]);

/** Options for {@link registerTakeoverRoutes}. */
export interface TakeoverWsOptions {
  /** Session backend (in-process service or parent-side worker relay). */
  service: TakeoverBackend;
  /**
   * Verify a one-time ticket and return its claims. Called exactly once per
   * ticket: implementations must consume the `jti` so replays are rejected.
   */
  verifyTicket: (ticket: string) => { sessionId: string; runId: string; stepId: string };
  /** Mint a short-lived socket token for an exchanged ticket. */
  issueSocketToken: (sessionId: string) => string;
  /** Verify the query token and return its session id. */
  verifySocketToken: (token: string) => { sessionId: string };
}

/**
 * Register the takeover HTTP + WebSocket routes on a Fastify instance.
 *
 * @param app - Fastify instance (with `@fastify/websocket` registered).
 * @param options - Backend + token operations.
 */
export async function registerTakeoverRoutes(
  app: FastifyInstance,
  options: TakeoverWsOptions,
): Promise<void> {
  const { service, verifyTicket, issueSocketToken, verifySocketToken } = options;

  // One-time ticket -> short-lived socket token exchange.
  app.post('/takeover/exchange', async (request, reply) => {
    const body = request.body as { ticket?: unknown } | undefined;
    const ticket = typeof body?.ticket === 'string' ? body.ticket : undefined;
    if (!ticket) {
      return reply.code(400).send({ error: 'TOKEN_INVALID', message: 'ticket is required' });
    }
    try {
      const claims = verifyTicket(ticket);
      const info: TakeoverSessionInfo | null = service.getInfo(claims.sessionId);
      if (!info) {
        return reply.code(404).send({ error: 'TAKEOVER_ERROR', message: 'Session not found' });
      }
      const socketToken = issueSocketToken(claims.sessionId);
      return reply.send({ socketToken, session: info });
    } catch (error) {
      const robo = error as TakeoverError;
      return reply.code(401).send({ error: robo.code ?? 'TOKEN_INVALID', message: robo.message });
    }
  });

  // Live takeover socket.
  app.get(
    '/takeover/ws',
    { websocket: true },
    (socket: import('ws').WebSocket, request: FastifyRequest) => {
      // Fastify leaves `request.query` undefined when the URL has no querystring.
      const query = (request.query ?? {}) as { token?: string };
      const token = query.token;
      if (!token) {
        socket.close(4401, 'missing token');
        return;
      }

      let sessionId: string;
      try {
        sessionId = verifySocketToken(token).sessionId;
      } catch {
        socket.close(4401, 'invalid token');
        return;
      }

      const clientId = `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      let operator = false;
      let detached = false;

      const send = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };

      const onFrame = (payload: { sessionId: string; data: string; metadata: unknown }): void => {
        if (payload.sessionId !== sessionId) return;
        send({ type: 'frame', data: payload.data, metadata: payload.metadata });
      };
      const onState = (info: TakeoverSessionInfo): void => {
        if (info.sessionId !== sessionId) return;
        send({ type: 'state', session: info });
        if (['COMPLETED', 'TIMEOUT', 'ABORTED'].includes(info.state)) {
          send({ type: 'resolved', by: 'operator' });
        }
      };

      service.on('frame', onFrame);
      service.on('state', onState);

      const cleanup = (): void => {
        if (detached) return;
        detached = true;
        service.off('frame', onFrame);
        service.off('state', onState);
        void service.detach(sessionId, clientId).catch(() => undefined);
      };

      socket.on('close', cleanup);
      socket.on('error', cleanup);

      void (async () => {
        try {
          operator = await service.attach(sessionId, clientId);
          const info = service.getInfo(sessionId);
          send({ type: 'hello', session: info, operator });
        } catch (error) {
          const robo = error as TakeoverError;
          send({ type: 'error', code: robo.code ?? 'TAKEOVER_ERROR', message: robo.message });
          socket.close(4403, robo.code ?? 'TAKEOVER_ERROR');
        }
      })();

      // Client input must be applied in arrival order: a rapid
      // down -> up -> text sequence or a drag must not race inside the async
      // CDP calls. A per-socket promise chain serialises the handlers.
      let inbox: Promise<void> = Promise.resolve();

      socket.on('message', (raw: Buffer) => {
        inbox = inbox
          .then(async () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              send({ type: 'error', code: 'VALIDATION_ERROR', message: 'malformed JSON' });
              return;
            }
            const result = clientMessageSchema.safeParse(parsed);
            if (!result.success) {
              send({
                type: 'error',
                code: 'VALIDATION_ERROR',
                message: result.error.issues.map((issue) => issue.message).join('; '),
              });
              return;
            }
            if (!operator) {
              send({ type: 'error', code: 'TAKEOVER_ERROR', message: 'not the active operator' });
              return;
            }
            try {
              const reply = await service.handleMessage(sessionId, clientId, result.data);
              if (
                reply &&
                typeof reply === 'object' &&
                (reply as { type?: string }).type === 'pong'
              ) {
                send(reply);
              }
            } catch (error) {
              const robo = error as TakeoverError;
              send({ type: 'error', code: robo.code ?? 'TAKEOVER_ERROR', message: robo.message });
            }
          })
          .catch(() => undefined);
      });
    },
  );
}
