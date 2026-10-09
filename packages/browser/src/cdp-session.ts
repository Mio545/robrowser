/**
 * Unified CDP session surface (spec 6).
 *
 * Both the Electron host (`webContents.debugger`) and the headless host (raw
 * WebSocket to `--remote-debugging-port`) implement this interface, which is why
 * `core` can drive either without knowing which one it is talking to.
 */

import { CdpError } from './errors.js';

/** Handler for a CDP event. */
export type CdpEventHandler = (params: unknown) => void;

/**
 * Minimal DevTools Protocol session.
 *
 * Implementations must:
 * - reject `send` with a {@link CdpError} when the protocol reports an error;
 * - never throw from `on`/`off`;
 * - make `detach` idempotent.
 */
export interface CDPSession {
  /** Send a protocol command; resolves with the result payload. */
  send<T = unknown>(method: string, params?: object): Promise<T>;
  /** Subscribe to a protocol event. */
  on(event: string, handler: CdpEventHandler): void;
  /** Unsubscribe a previously registered handler. */
  off(event: string, handler: CdpEventHandler): void;
  /** Detach from the target. */
  detach(): Promise<void>;
}

/** Options shared by every transport. */
export interface CdpSessionOptions {
  /** Milliseconds to wait for a command reply before rejecting. */
  commandTimeoutMs?: number;
  /** Label used in error messages (e.g. `page`, `browser`). */
  label?: string;
}

const DEFAULT_COMMAND_TIMEOUT = 30_000;

/**
 * Browser-free multiplexer that turns a request/response channel into a
 * {@link CDPSession}.
 *
 * Concrete transports (Electron debugger, WebSocket) supply `transmit` and push
 * received messages into {@link handleMessage}.
 */
export abstract class BaseCdpSession implements CDPSession {
  protected readonly listeners = new Map<string, Set<CdpEventHandler>>();
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }
  >();
  private nextId = 1;
  private detached = false;
  private readonly commandTimeoutMs: number;
  private readonly label: string;

  protected constructor(options: CdpSessionOptions = {}) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT;
    this.label = options.label ?? 'cdp';
  }

  /** Transport hook: deliver one serialized message. */
  protected abstract transmit(message: string | object): Promise<void>;

  /** Transport hook: detach the underlying transport. */
  protected abstract dispose(): Promise<void>;

  public async send<T = unknown>(method: string, params: object = {}): Promise<T> {
    if (this.detached) throw new CdpError(`Session "${this.label}" is detached`, { method });
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CdpError(`CDP command "${method}" timed out after ${this.commandTimeoutMs}ms`, {
            method,
          }),
        );
      }, this.commandTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      void this.transmit({ id, method, params }).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(error instanceof Error ? error : new CdpError(String(error), { method }));
      });
    });
  }

  public on(event: string, handler: CdpEventHandler): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  public off(event: string, handler: CdpEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  public async detach(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new CdpError(`Session "${this.label}" was detached`));
    }
    this.pending.clear();
    this.listeners.clear();
    await this.dispose();
  }

  /** True once {@link detach} has been called. */
  public get isDetached(): boolean {
    return this.detached;
  }

  /**
   * Feed a received message into the session.
   *
   * @param raw - Serialized JSON or an already-parsed object.
   * @returns `true` when the message was consumed by this session.
   */
  public handleMessage(raw: string | object): boolean {
    let message: unknown;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return false;
    }
    if (!message || typeof message !== 'object') return false;
    const record = message as Record<string, unknown>;

    if (typeof record.id === 'number') {
      const entry = this.pending.get(record.id);
      if (!entry) return false;
      this.pending.delete(record.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (record.error) {
        const error = record.error as { message?: string; code?: number };
        entry.reject(
          new CdpError(error.message ?? 'CDP command failed', {
            method: undefined,
            cdpCode: error.code,
          }),
        );
      } else {
        entry.resolve(record.result);
      }
      return true;
    }

    if (typeof record.method === 'string') {
      const handlers = this.listeners.get(record.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(record.params);
          } catch {
            // A failing listener must never break the protocol loop.
          }
        }
      }
      return true;
    }
    return false;
  }

  /** Emit an event to local listeners (used by transports for synthetic events). */
  protected emit(event: string, params: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) {
      try {
        handler(params);
      } catch {
        // ignore
      }
    }
  }
}
