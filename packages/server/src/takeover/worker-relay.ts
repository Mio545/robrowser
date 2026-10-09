/**
 * Parent-side relay for takeover sessions that live in a worker process
 * (spec 7.3).
 *
 * The parent owns the only HTTP + WebSocket surface, so the operator always
 * connects to one stable origin. The worker owns the page/CDP session, so:
 * - screencast frames flow worker -> parent over Node IPC and are re-broadcast
 *   to WebSocket subscribers;
 * - input messages flow parent -> worker over IPC and are injected there.
 *
 * "First wins" is enforced here (the parent sees every client) and mirrored in
 * the worker, so a rogue direct IPC message cannot steal the slot.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import { TakeoverError } from '@robrowser/core';
import type { ClientMessage, TakeoverSessionInfo } from './types.js';
import type { TakeoverBackend, TakeoverBackendEvents } from './backend.js';

/** Messages the parent sends down to the worker. */
export interface RelayToWorker {
  type: 'takeover-input';
  sessionId: string;
  clientId: string;
  message: ClientMessage;
}

/** Messages the worker sends up to the parent. */
export type RelayFromWorker =
  | {
      type: 'takeover-session';
      session: {
        sessionId: string;
        runId: string;
        stepId: string;
        reason: string;
        message: string;
        expiresAt: string;
      };
    }
  | { type: 'takeover-frame'; sessionId: string; data: string; metadata: unknown }
  | { type: 'takeover-state'; sessionId: string; state: TakeoverSessionInfo['state'] }
  | { type: 'takeover-clients'; sessionId: string; clients: number };

/**
 * Relay backend for one worker process.
 *
 * Lifecycle: constructed when the worker starts, disposed when it exits.
 */
export class WorkerTakeoverRelay extends EventEmitter implements TakeoverBackend {
  private readonly sessions = new Map<string, TakeoverSessionInfo>();
  private readonly operator = new Map<string, string>();

  public constructor(
    private readonly child: ChildProcess,
    private readonly logger: Logger,
  ) {
    super();
    this.child.on('message', (raw: unknown) => this.onWorkerMessage(raw));
  }

  /** Feed a worker message into the relay (also used directly by tests). */
  public onWorkerMessage(raw: unknown): void {
    const message = raw as RelayFromWorker;
    switch (message?.type) {
      case 'takeover-session': {
        const info: TakeoverSessionInfo = {
          sessionId: message.session.sessionId,
          runId: message.session.runId,
          stepId: message.session.stepId,
          reason: message.session.reason as TakeoverSessionInfo['reason'],
          message: message.session.message,
          state: 'PENDING',
          createdAt: new Date().toISOString(),
          expiresAt: message.session.expiresAt,
          clients: 0,
          resolveWhenSatisfied: false,
        };
        this.sessions.set(info.sessionId, info);
        this.emit('session', info);
        this.emit('state', info);
        this.logger.info(
          { sessionId: info.sessionId, runId: info.runId },
          'takeover session relayed',
        );
        break;
      }
      case 'takeover-frame': {
        this.emit('frame', {
          sessionId: message.sessionId,
          data: message.data,
          metadata: message.metadata,
        });
        break;
      }
      case 'takeover-state': {
        const info = this.sessions.get(message.sessionId);
        if (info) {
          info.state = message.state;
          this.emit('state', info);
          if (['COMPLETED', 'TIMEOUT', 'ABORTED'].includes(message.state)) {
            this.sessions.delete(message.sessionId);
            this.operator.delete(message.sessionId);
          }
        }
        break;
      }
      case 'takeover-clients': {
        const info = this.sessions.get(message.sessionId);
        if (info) {
          info.clients = message.clients;
          this.emit('clients', { sessionId: message.sessionId, clients: message.clients });
        }
        break;
      }
      default:
        break;
    }
  }

  public getInfo(sessionId: string): TakeoverSessionInfo | null {
    return this.sessions.get(sessionId) ?? null;
  }

  public all(): TakeoverSessionInfo[] {
    return [...this.sessions.values()];
  }

  public async attach(sessionId: string, clientId: string): Promise<boolean> {
    const info = this.sessions.get(sessionId);
    if (!info) {
      throw new TakeoverError('TAKEOVER_ERROR', `Unknown takeover session ${sessionId}`, {
        sessionId,
      });
    }
    if (['COMPLETED', 'TIMEOUT', 'ABORTED'].includes(info.state)) {
      throw new TakeoverError('TAKEOVER_ERROR', `Takeover session ${sessionId} is ${info.state}`, {
        sessionId,
        state: info.state,
      });
    }
    const existing = this.operator.get(sessionId);
    if (existing && existing !== clientId) {
      throw new TakeoverError('TAKEOVER_ERROR', 'This takeover session already has an operator', {
        sessionId,
        claimedBy: existing,
        clientId,
      });
    }
    const isOperator = existing === undefined;
    if (isOperator) this.operator.set(sessionId, clientId);
    info.clients += 1;
    info.claimedBy = clientId;
    info.state = 'ACTIVE';
    this.emit('clients', { sessionId, clients: info.clients, claimedBy: clientId });
    this.emit('state', info);
    return isOperator;
  }

  public async detach(sessionId: string, clientId: string): Promise<void> {
    const info = this.sessions.get(sessionId);
    if (!info) return;
    info.clients = Math.max(0, info.clients - 1);
    if (this.operator.get(sessionId) === clientId) {
      // Keep the session alive so the operator can reconnect (spec 8.3).
      this.operator.delete(sessionId);
      delete info.claimedBy;
      if (info.state === 'ACTIVE') info.state = 'PENDING';
    }
    this.emit('clients', { sessionId, clients: info.clients });
    this.emit('state', info);
  }

  public async handleMessage(
    sessionId: string,
    clientId: string,
    message: unknown,
  ): Promise<unknown> {
    if (this.operator.get(sessionId) !== clientId) {
      throw new TakeoverError('TAKEOVER_ERROR', 'Only the active operator may send input', {
        sessionId,
      });
    }
    if (!this.child.connected) {
      throw new TakeoverError('TAKEOVER_ERROR', 'Worker process is no longer connected');
    }
    const payload: RelayToWorker = {
      type: 'takeover-input',
      sessionId,
      clientId,
      message: message as ClientMessage,
    };
    this.child.send(payload);
    return undefined;
  }

  public override on<K extends keyof TakeoverBackendEvents>(
    event: K,
    listener: (...args: TakeoverBackendEvents[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  public override off<K extends keyof TakeoverBackendEvents>(
    event: K,
    listener: (...args: TakeoverBackendEvents[K]) => void,
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}
