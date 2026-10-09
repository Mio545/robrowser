/**
 * Network observation helpers (spec 5.3).
 *
 * These wrap the CDP `Network` domain to provide idle detection, download
 * waiting and response status collection. The implementation is deliberately
 * transport agnostic: it only uses the {@link CDPSessionLike} surface so the
 * same code runs against the Electron debugger and a raw WebSocket session.
 */

/** Minimal CDP session surface required by this module. */
export interface CDPSessionLike {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, handler: (params: any) => void): void;
  off(event: string, handler: (params: any) => void): void;
}

/** A recorded network response. */
export interface NetworkRecord {
  requestId: string;
  url: string;
  status: number;
  statusText: string;
  mimeType?: string;
  ok: boolean;
  timestamp: number;
}

/** Options for {@link NetworkWatcher.constructor}. */
export interface NetworkWatcherOptions {
  /** Hard cap on retained responses (ring buffer). */
  maxRecords?: number;
}

/**
 * Subscribes to CDP network events and exposes wait helpers.
 *
 * Call {@link start} once to enable `Network`; {@link dispose} detaches.
 */
export class NetworkWatcher {
  private readonly inFlight = new Set<string>();
  private readonly records: NetworkRecord[] = [];
  private readonly maxRecords: number;
  private idleWaiters = new Set<() => void>();
  private lastActivity = Date.now();
  private started = false;

  public constructor(
    private readonly session: CDPSessionLike,
    options: NetworkWatcherOptions = {},
  ) {
    this.maxRecords = options.maxRecords ?? 500;
  }

  /** Enable the `Network` domain and start recording events. */
  public async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.session.on('Network.requestWillBeSent', this.onRequest);
    this.session.on('Network.responseReceived', this.onResponse);
    this.session.on('Network.loadingFinished', this.onFinished);
    this.session.on('Network.loadingFailed', this.onFinished);
    await this.session.send('Network.enable');
  }

  /** Detach all listeners (does not disable the domain, which may be shared). */
  public dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.session.off('Network.requestWillBeSent', this.onRequest);
    this.session.off('Network.responseReceived', this.onResponse);
    this.session.off('Network.loadingFinished', this.onFinished);
    this.session.off('Network.loadingFailed', this.onFinished);
  }

  /** Currently open requests. */
  public pending(): number {
    return this.inFlight.size;
  }

  /** Snapshot of recorded responses (most recent last). */
  public responses(): readonly NetworkRecord[] {
    return this.records;
  }

  /** Milliseconds since the last request/response activity. */
  public idleFor(): number {
    return Date.now() - this.lastActivity;
  }

  private readonly onRequest = (params: any): void => {
    if (typeof params?.requestId === 'string') this.inFlight.add(params.requestId);
    this.lastActivity = Date.now();
  };

  private readonly onResponse = (params: any): void => {
    this.lastActivity = Date.now();
    const response = params?.response;
    if (!response) return;
    const record: NetworkRecord = {
      requestId: String(params.requestId ?? ''),
      url: String(response.url ?? ''),
      status: Number(response.status ?? 0),
      statusText: String(response.statusText ?? ''),
      mimeType: response.mimeType,
      ok: Number(response.status ?? 0) >= 200 && Number(response.status ?? 0) < 400,
      timestamp: Date.now(),
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.shift();
  };

  private readonly onFinished = (params: any): void => {
    if (typeof params?.requestId === 'string') this.inFlight.delete(params.requestId);
    this.lastActivity = Date.now();
    if (this.inFlight.size === 0) {
      for (const waiter of [...this.idleWaiters]) waiter();
      this.idleWaiters.clear();
    }
  };

  /**
   * Wait until there are no in-flight requests for `idleMs`.
   *
   * @param idleMs - Required quiet period.
   * @param timeoutMs - Budget; rejects with a timeout error when exceeded.
   * @param signal - Optional abort signal.
   */
  public async waitForIdle(idleMs = 500, timeoutMs = 30_000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) throw new Error('aborted');
      const now = Date.now();
      if (now >= deadline) throw new Error(`waitForNetworkIdle timed out after ${timeoutMs}ms`);
      if (this.inFlight.size === 0 && this.idleFor() >= idleMs) return;
      const wakeAt = Math.min(this.lastActivity + idleMs, deadline);
      const wait = Math.max(25, Math.min(wakeAt - now, 250));
      await this.delay(wait);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
