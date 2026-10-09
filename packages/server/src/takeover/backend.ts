/**
 * Takeover backend abstraction.
 *
 * Two implementations exist:
 * - {@link TakeoverService} itself (in-process runs: the CLI `takeover` command
 *   and the single-process `serve` mode).
 * - {@link WorkerTakeoverProxy} (queued runs: the worker owns the page, the
 *   parent owns the HTTP surface, and frames/input are relayed over IPC).
 *
 * The WebSocket layer only depends on this interface, which is what lets the
 * same operator page serve both modes.
 */
import type { TakeoverSessionInfo } from './types.js';

/** Events a backend may emit. */
export interface TakeoverBackendEvents {
  frame: [{ sessionId: string; data: string; metadata: unknown }];
  state: [TakeoverSessionInfo];
  session: [TakeoverSessionInfo];
  clients: [{ sessionId: string; clients: number; claimedBy?: string }];
}

/** Structural contract consumed by the WebSocket layer. */
export interface TakeoverBackend {
  /** Public session info, or null when the session is unknown/expired. */
  getInfo(sessionId: string): TakeoverSessionInfo | null;
  /** Attach a client; resolves true when this client owns the input channel. */
  attach(sessionId: string, clientId: string): Promise<boolean>;
  /** Detach a client. */
  detach(sessionId: string, clientId: string): Promise<void>;
  /** Forward a validated client message. */
  handleMessage(sessionId: string, clientId: string, message: unknown): Promise<unknown>;
  /** Subscribe to backend events. */
  on<K extends keyof TakeoverBackendEvents>(
    event: K,
    listener: (...args: TakeoverBackendEvents[K]) => void,
  ): unknown;
  /** Unsubscribe. */
  off<K extends keyof TakeoverBackendEvents>(
    event: K,
    listener: (...args: TakeoverBackendEvents[K]) => void,
  ): unknown;
}
