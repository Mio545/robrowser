/**
 * Composite takeover backend.
 *
 * `serve` runs every task in its own worker process, so each live browser owns
 * its own {@link WorkerTakeoverRelay}. The HTTP/WebSocket surface, however, only
 * knows about one backend. This class fans operations out to the relay that owns
 * the requested session, which keeps the WebSocket layer oblivious to the
 * worker topology.
 */
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { TakeoverError } from '@robrowser/core';
import type { TakeoverBackend, TakeoverBackendEvents } from './backend.js';
import type { TakeoverSessionInfo } from './types.js';
import type { WorkerTakeoverRelay } from './worker-relay.js';

/** Aggregates per-worker relays into a single {@link TakeoverBackend}. */
export class CompositeTakeoverBackend extends EventEmitter implements TakeoverBackend {
  private readonly relays = new Set<WorkerTakeoverRelay>();

  public constructor(private readonly logger: Logger) {
    super();
  }

  /** Start mirroring a worker's takeover events. */
  public register(relay: WorkerTakeoverRelay): void {
    if (this.relays.has(relay)) return;
    this.relays.add(relay);
    for (const event of ['session', 'state', 'frame', 'clients'] as const) {
      relay.on(event, ((...args: unknown[]) => {
        this.emit(event, ...args);
      }) as never);
    }
    this.logger.debug({ relays: this.relays.size }, 'takeover relay registered');
  }

  /** Stop mirroring a worker's events (worker exited). */
  public unregister(relay: WorkerTakeoverRelay): void {
    this.relays.delete(relay);
    this.logger.debug({ relays: this.relays.size }, 'takeover relay unregistered');
  }

  /** Number of live sessions across every worker. */
  public size(): number {
    let total = 0;
    for (const relay of this.relays) total += relay.all().length;
    return total;
  }

  public getInfo(sessionId: string): TakeoverSessionInfo | null {
    for (const relay of this.relays) {
      const info = relay.getInfo(sessionId);
      if (info) return info;
    }
    return null;
  }

  public async attach(sessionId: string, clientId: string): Promise<boolean> {
    return (await this.owner(sessionId)).attach(sessionId, clientId);
  }

  public async detach(sessionId: string, clientId: string): Promise<void> {
    await (await this.owner(sessionId)).detach(sessionId, clientId);
  }

  public async handleMessage(
    sessionId: string,
    clientId: string,
    message: unknown,
  ): Promise<unknown> {
    return (await this.owner(sessionId)).handleMessage(sessionId, clientId, message);
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

  private async owner(sessionId: string): Promise<WorkerTakeoverRelay> {
    const relay = [...this.relays].find((candidate) => candidate.getInfo(sessionId));
    if (!relay) {
      throw new TakeoverError('TAKEOVER_ERROR', `Unknown takeover session ${sessionId}`, {
        sessionId,
      });
    }
    return relay;
  }
}
