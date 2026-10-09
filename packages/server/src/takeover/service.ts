/**
 * TakeoverService: session lifecycle, screencast fan-out, input injection, and
 * the dual completion condition (spec 8.3 / 8.6).
 *
 * Responsibilities
 * - Own the state machine IDLE -> PENDING -> ACTIVE -> COMPLETED | TIMEOUT | ABORTED.
 * - Guarantee *first wins*: the first client to claim becomes the operator; later
 *   clients are rejected (or attached read-only when configured).
 * - Pause automation while ACTIVE: the owning `manual` step awaits `resolve`.
 * - Resume when EITHER the operator clicks "complete" AND `resolveWhen` matches,
 *   OR the background poller observes `resolveWhen` matching on its own.
 */
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import {
  matchPage,
  TakeoverError,
  type ManualHandler,
  type ManualRequest,
  type ManualResult,
  type PageRule,
} from '@robrowser/core';
import { startScreencast, type CDPSession, type ScreencastHandle } from '@robrowser/browser';
import {
  dispatchMouse,
  dispatchMouseButton,
  dispatchWheel,
  dispatchKey,
  insertText,
} from '@robrowser/browser';
import type { Notifier } from '../notify/notifier.js';
import { takeoverToPage } from './coord.js';
import { TicketService } from './tokens.js';
import type {
  ClientMessage,
  CreateTakeoverOptions,
  TakeoverSession,
  TakeoverSessionInfo,
  TakeoverState,
} from './types.js';

/** Events published by the service (consumed by the WebSocket layer). */
export interface TakeoverServiceEvents {
  /** A new session entered PENDING. */
  session: [TakeoverSessionInfo];
  /** A session changed state. */
  state: [TakeoverSessionInfo];
  /** A screencast frame is available for a session. */
  frame: [
    {
      sessionId: string;
      data: string;
      metadata: {
        deviceWidth: number;
        deviceHeight: number;
        pageScaleFactor: number;
        offsetTop: number;
        scrollOffsetX: number;
        scrollOffsetY: number;
      };
    },
  ];
  /** A client claimed (or released) the operator slot. */
  clients: [{ sessionId: string; clients: number; claimedBy?: string }];
}

/** Options for {@link TakeoverService}. */
export interface TakeoverServiceOptions {
  logger: Logger;
  tickets: TicketService;
  notifier: Notifier;
  /** Base URL used to build takeover links (no trailing slash). */
  publicUrl: string;
  /** Only the first client may send input (spec 8.3). */
  singleClient?: boolean;
}

/**
 * Manages all live takeover sessions for one server process.
 */
export class TakeoverService extends EventEmitter {
  private readonly sessions = new Map<string, TakeoverSession>();
  /** sessionId -> number of connected clients (a Map keeps ordering for first-wins). */
  private readonly clientCounts = new Map<string, number>();
  private readonly screencasts = new Map<string, ScreencastHandle>();

  public constructor(private readonly options: TakeoverServiceOptions) {
    super();
  }

  /** Number of live sessions. */
  public size(): number {
    return this.sessions.size;
  }

  /** Look up a session's public info. */
  public getInfo(sessionId: string): TakeoverSessionInfo | null {
    return this.sessions.get(sessionId)?.info ?? null;
  }

  /** All live sessions. */
  public list(): TakeoverSessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info);
  }

  /**
   * Create a session and return the operator URL + the promise that resolves the
   * owning `manual` step.
   *
   * @param options - Session parameters derived from the `manual` step.
   */
  public async create(options: CreateTakeoverOptions): Promise<{
    sessionId: string;
    url: string;
    expiresAt: string;
    completed: Promise<ManualResult>;
  }> {
    const sessionId = `tk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const expiresAt = new Date(now + options.timeoutMs).toISOString();

    let resolveFn: (result: ManualResult) => void = () => undefined;
    const completed = new Promise<ManualResult>((resolve) => {
      resolveFn = resolve;
    });

    const session: TakeoverSession = {
      info: {
        sessionId,
        runId: options.runId,
        stepId: options.stepId,
        reason: options.reason,
        message: options.message,
        state: 'PENDING',
        createdAt: new Date(now).toISOString(),
        expiresAt,
        clients: 0,
        resolveWhenSatisfied: false,
      },
      page: options.page,
      resolve: resolveFn,
      notify: options.notify ?? [],
      ...(options.resolveWhen ? { resolveWhen: options.resolveWhen } : {}),
    };
    this.sessions.set(sessionId, session);
    this.clientCounts.set(sessionId, 0);

    const { ticket } = this.options.tickets.issue({
      sessionId,
      runId: options.runId,
      stepId: options.stepId,
    });
    const url = `${this.options.publicUrl.replace(/\/+$/, '')}/takeover/?ticket=${encodeURIComponent(ticket)}`;

    // Hard deadline for the whole human interaction.
    session.timer = setTimeout(() => {
      void this.finish(sessionId, 'timeout', { reason: 'timeoutMs elapsed' });
    }, options.timeoutMs);
    session.timer.unref?.();

    // Automatic completion: a background poller that resumes even if the human
    // forgets to click "complete" (spec 8.6, second half).
    if (session.resolveWhen) {
      session.poller = setInterval(() => {
        void this.checkResolveWhen(sessionId);
      }, 1_000);
      session.poller.unref?.();
    }

    this.emit('session', session.info);
    this.emit('state', session.info);
    this.options.logger.info(
      { sessionId, runId: options.runId, stepId: options.stepId, expiresAt },
      'takeover session created',
    );

    // Fire-and-forget notification delivery.
    void this.notify(sessionId, url, expiresAt).catch((error: unknown) => {
      this.options.logger.error({ err: String(error), sessionId }, 'takeover notification failed');
    });

    return { sessionId, url, expiresAt, completed };
  }

  /** Deliver takeover notifications for a session. */
  private async notify(sessionId: string, url: string, expiresAt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    await this.options.notifier.notify(session.notify, {
      runId: session.info.runId,
      stepId: session.info.stepId,
      reason: session.info.reason,
      message: session.info.message,
      url,
      expiresAt,
      sessionId,
    });
  }

  /**
   * Attach a client to a session. The first client becomes the operator.
   *
   * @param sessionId - Session to attach to.
   * @param clientId - Stable identifier for the connection (used in the audit log).
   * @returns `true` when this client owns the input channel.
   * @throws {TakeoverError} When the session is unknown or already claimed.
   */
  public async attach(sessionId: string, clientId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new TakeoverError('TAKEOVER_ERROR', `Unknown takeover session ${sessionId}`, {
        sessionId,
      });
    }
    if (
      session.info.state === 'COMPLETED' ||
      session.info.state === 'TIMEOUT' ||
      session.info.state === 'ABORTED'
    ) {
      throw new TakeoverError(
        'TAKEOVER_ERROR',
        `Takeover session ${sessionId} is ${session.info.state}`,
        {
          sessionId,
          state: session.info.state,
        },
      );
    }

    if (
      this.options.singleClient !== false &&
      session.info.claimedBy &&
      session.info.claimedBy !== clientId
    ) {
      throw new TakeoverError('TAKEOVER_ERROR', 'This takeover session already has an operator', {
        sessionId,
        claimedBy: session.info.claimedBy,
        clientId,
      });
    }

    const count = (this.clientCounts.get(sessionId) ?? 0) + 1;
    this.clientCounts.set(sessionId, count);
    session.info.clients = count;

    const isOperator = !session.info.claimedBy;
    if (isOperator) {
      session.info.claimedBy = clientId;
      this.setState(session, 'ACTIVE');
    }
    this.emit('clients', {
      sessionId,
      clients: count,
      ...(session.info.claimedBy ? { claimedBy: session.info.claimedBy } : {}),
    });

    await this.ensureScreencast(sessionId);
    this.options.logger.info({ sessionId, clientId, isOperator }, 'takeover client attached');
    return isOperator;
  }

  /** Detach a client (page close / network drop). */
  public async detach(sessionId: string, clientId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const count = Math.max(0, (this.clientCounts.get(sessionId) ?? 1) - 1);
    this.clientCounts.set(sessionId, count);
    session.info.clients = count;
    this.emit('clients', { sessionId, clients: count });

    if (session.info.claimedBy === clientId) {
      // Free the operator slot but keep the session alive so the operator can
      // reconnect inside the ticket validity window (spec 8.3).
      delete session.info.claimedBy;
      if (session.info.state === 'ACTIVE') this.setState(session, 'PENDING');
      await this.stopScreencast(sessionId);
    }
    this.options.logger.info({ sessionId, clientId, clients: count }, 'takeover client detached');
  }

  /** Start streaming frames for a session (idempotent). */
  private async ensureScreencast(sessionId: string): Promise<void> {
    if (this.screencasts.has(sessionId)) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const cdp = session.page.cdp() as unknown as CDPSession;
    const handle = await startScreencast(
      cdp,
      (frame) => {
        this.emit('frame', {
          sessionId,
          data: frame.data,
          metadata: {
            deviceWidth: frame.metadata.deviceWidth,
            deviceHeight: frame.metadata.deviceHeight,
            pageScaleFactor: frame.metadata.pageScaleFactor,
            offsetTop: frame.metadata.offsetTop,
            scrollOffsetX: frame.metadata.scrollOffsetX,
            scrollOffsetY: frame.metadata.scrollOffsetY,
          },
        });
      },
      { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
      (error) =>
        this.options.logger.warn({ sessionId, err: String(error) }, 'screencast callback failed'),
    );
    this.screencasts.set(sessionId, handle);
  }

  private async stopScreencast(sessionId: string): Promise<void> {
    const handle = this.screencasts.get(sessionId);
    if (!handle) return;
    this.screencasts.delete(sessionId);
    await handle.stop().catch(() => undefined);
  }

  /**
   * Handle a message from a takeover client.
   *
   * @param sessionId - Session the message belongs to.
   * @param clientId - Connection identifier.
   * @param message - Parsed client message.
   * @returns An optional reply the WebSocket layer should send back.
   */
  public async handleMessage(
    sessionId: string,
    clientId: string,
    message: ClientMessage,
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new TakeoverError('TAKEOVER_ERROR', `Unknown takeover session ${sessionId}`);
    }
    if (session.info.claimedBy !== clientId) {
      throw new TakeoverError('TAKEOVER_ERROR', 'Only the active operator may send input', {
        sessionId,
        clientId,
      });
    }

    const cdp = session.page.cdp() as unknown as CDPSession;
    switch (message.type) {
      case 'mouse': {
        const point = await takeoverToPage(
          cdp,
          { x: message.x, y: message.y },
          { width: message.canvasWidth, height: message.canvasHeight },
        );
        if (message.action === 'move') {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: point.x,
            y: point.y,
            button: 'none',
            modifiers: modifierBits(message.modifiers),
          });
        } else if (message.action === 'wheel') {
          await dispatchWheel(cdp, point.x, point.y, message.deltaX ?? 0, message.deltaY ?? 0);
        } else {
          await dispatchMouseButton(
            cdp,
            message.action === 'down' ? 'mousePressed' : 'mouseReleased',
            point.x,
            point.y,
            {
              button: (message.button as 'left' | 'right' | 'middle') ?? 'left',
              clickCount: message.clickCount ?? 1,
              modifiers: (message.modifiers as never) ?? [],
            },
          );
        }
        return undefined;
      }
      case 'key': {
        if (message.action === 'press') {
          await dispatchKey(cdp, message.key, { modifiers: (message.modifiers as never) ?? [] });
        } else {
          await cdp.send('Input.dispatchKeyEvent', {
            type: message.action === 'down' ? 'keyDown' : 'keyUp',
            key: message.key,
            modifiers: modifierBits(message.modifiers),
          });
        }
        return undefined;
      }
      case 'text':
        await insertText(cdp, message.text);
        return undefined;
      case 'complete': {
        await this.complete(sessionId, clientId);
        return undefined;
      }
      case 'claim':
        return { ok: true, operator: true };
      case 'ping':
        return { type: 'pong', t: message.t };
      default: {
        const exhaustive: never = message;
        throw new TakeoverError(
          'TAKEOVER_ERROR',
          `Unsupported client message: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  /**
   * Operator requested completion. The `resolveWhen` predicate (when present) is
   * re-checked for a short window before resuming (spec 8.6, first half).
   */
  public async complete(sessionId: string, clientId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new TakeoverError('TAKEOVER_ERROR', `Unknown takeover session ${sessionId}`);
    if (session.info.claimedBy !== clientId) {
      throw new TakeoverError(
        'TAKEOVER_ERROR',
        'Only the active operator may complete the session',
      );
    }

    if (session.resolveWhen) {
      // Give the page up to 3 seconds to settle (e.g. after an async submit).
      const satisfied = await this.waitForRule(session, session.resolveWhen, 3_000);
      if (!satisfied) {
        throw new TakeoverError(
          'TAKEOVER_ERROR',
          'The completion condition (resolveWhen) is not satisfied yet',
          { sessionId },
        );
      }
      session.info.resolveWhenSatisfied = true;
    }
    await this.finish(sessionId, 'resolved', { by: clientId });
  }

  /** Background poller: resume automatically when `resolveWhen` matches. */
  private async checkResolveWhen(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.resolveWhen || session.info.resolveWhenSatisfied) return;
    try {
      const result = await matchPage(session.page, session.resolveWhen);
      if (result.matched) {
        session.info.resolveWhenSatisfied = true;
        this.options.logger.info({ sessionId }, 'resolveWhen satisfied by background poller');
        await this.finish(sessionId, 'resolved', { by: 'auto' });
      }
    } catch {
      // transient evaluation failure during navigation; try again next tick
    }
  }

  /**
   * Re-check a completion predicate for up to `timeoutMs`.
   *
   * @param session - The session whose page is evaluated.
   * @param rule - Predicate from `manual.resolveWhen`.
   * @param timeoutMs - Settling window (default 3s per spec 8.6).
   */
  private async waitForRule(
    session: TakeoverSession,
    rule: PageRule,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await matchPage(session.page, rule).catch(() => ({
        matched: false,
        details: [],
      }));
      if (result.matched) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Move a session to a terminal state and release the owning manual step. */
  public async finish(
    sessionId: string,
    outcome: 'resolved' | 'timeout' | 'aborted',
    extra: { by?: string; reason?: string },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (['COMPLETED', 'TIMEOUT', 'ABORTED'].includes(session.info.state)) return;

    const state: TakeoverState =
      outcome === 'resolved' ? 'COMPLETED' : outcome === 'timeout' ? 'TIMEOUT' : 'ABORTED';
    this.setState(session, state);
    await this.stopScreencast(sessionId);
    this.options.tickets.revokeSession(sessionId);

    if (session.timer) clearTimeout(session.timer);
    if (session.poller) clearInterval(session.poller);

    // Audit log (spec 8.4): who, when, which run, how long, outcome.
    const durationMs = Date.now() - new Date(session.info.createdAt).getTime();
    this.options.logger.warn(
      {
        audit: 'takeover',
        sessionId,
        runId: session.info.runId,
        stepId: session.info.stepId,
        outcome,
        by: extra.by ?? null,
        durationMs,
        reason: extra.reason ?? null,
      },
      'takeover session finished',
    );

    session.resolve(
      outcome === 'resolved'
        ? { status: 'resolved', ...(extra.by ? { by: extra.by } : {}) }
        : { status: outcome === 'timeout' ? 'timeout' : 'aborted' },
    );

    this.sessions.delete(sessionId);
    this.clientCounts.delete(sessionId);
    this.emit('state', { ...session.info, state });
    this.emit('clients', { sessionId, clients: 0 });
  }

  /** Abort every live session (server shutdown). */
  public async abortAll(reason = 'server shutting down'): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.finish(sessionId, 'aborted', { reason });
    }
  }

  private setState(session: TakeoverSession, state: TakeoverState): void {
    session.info.state = state;
    this.emit('state', session.info);
  }
}

/** Convert modifier names to the CDP bitmask. */
function modifierBits(modifiers: readonly string[] = []): number {
  const bits: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  return modifiers.reduce((mask, name) => mask | (bits[name] ?? 0), 0);
}

/**
 * `RemoteTakeoverHandler implements ManualHandler` (spec 8.9).
 *
 * This is the *only* adapter the core engine needs: it translates a
 * {@link ManualRequest} into a takeover session and awaits its completion.
 */
export class RemoteTakeoverHandler implements ManualHandler {
  public constructor(private readonly service: TakeoverService) {}

  public async request(req: ManualRequest): Promise<ManualResult> {
    const { completed } = await this.service.create({
      runId: req.runId,
      stepId: req.stepId,
      reason: req.reason,
      message: req.message,
      page: req.page,
      timeoutMs: req.timeoutMs,
      ...(req.resolveWhen ? { resolveWhen: req.resolveWhen } : {}),
      ...(req.notify ? { notify: req.notify } : {}),
    });
    return completed;
  }
}

/** Re-export for convenience. */
export { dispatchMouse };
