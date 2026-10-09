/**
 * Electron adapter (spec 6 / 9).
 *
 * Wraps `webContents.debugger.attach('1.3')` as a {@link CDPSession} so the same
 * engine that drives headless Chromium drives the embedded browser view.
 *
 * This module deliberately does not `import 'electron'`: the desktop host passes
 * the `webContents` (typed structurally) so that the browser package stays free
 * of host dependencies and remains unit testable.
 */
import { BaseCdpSession } from './cdp-session.js';
import { CdpError } from './errors.js';
import type { BrowserAdapter, BrowserContext, CookieParam, LaunchOptions } from './adapter.js';
import { CdpPage } from './adapter.js';

/** Structural view of the pieces of `Electron.WebContents` we use. */
export interface ElectronDebugger {
  attach(protocolVersion?: string): void;
  isAttached(): boolean;
  detach(): void;
  sendCommand(method: string, commandParams?: object): Promise<unknown>;
  on(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void,
  ): void;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): void;
  off(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void,
  ): void;
  off(event: 'detach', listener: (event: unknown, reason: string) => void): void;
}

/** Structural view of `Electron.WebContents` used by the adapter. */
export interface ElectronWebContents {
  debugger: ElectronDebugger;
  isDestroyed(): boolean;
  getURL(): string;
  loadURL(url: string, options?: object): Promise<void>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  capturePage(rect?: object): Promise<{ toPNG(): Buffer }>;
  setWindowOpenHandler?(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

/**
 * CDP session backed by an Electron `webContents.debugger`.
 *
 * Note: Electron's debugger multiplexes messages for the attached target, so we
 * forward every `message` event into {@link BaseCdpSession.handleMessage}.
 */
export class ElectronCdpSession extends BaseCdpSession {
  private attached = false;
  private readonly onMessage: (event: unknown, method: string, params: unknown) => void;
  private readonly onDetach: (event: unknown, reason: string) => void;
  /** Callback injected by the host (used to surface unexpected detaches). */
  public onUnexpectedDetach: ((reason: string) => void) | undefined;

  public constructor(
    private readonly webContents: ElectronWebContents,
    label = 'electron',
  ) {
    super({ label });
    this.onMessage = (_event, method, params) => {
      this.handleMessage({ method, params });
    };
    this.onDetach = (_event, reason) => {
      this.attached = false;
      this.onUnexpectedDetach?.(reason);
    };
  }

  /** Attach the debugger. Idempotent. */
  public async attach(): Promise<void> {
    if (this.attached && this.webContents.debugger.isAttached()) return;
    try {
      this.webContents.debugger.attach('1.3');
    } catch (error) {
      throw new CdpError(`Failed to attach debugger: ${(error as Error).message}`, {
        cause: undefined,
      });
    }
    this.webContents.debugger.on('message', this.onMessage);
    this.webContents.debugger.on('detach', this.onDetach);
    this.attached = true;
  }

  protected async transmit(message: string | object): Promise<void> {
    const record =
      typeof message === 'string'
        ? (JSON.parse(message) as { id?: number; method?: string; params?: object })
        : (message as { id?: number; method?: string; params?: object });
    if (typeof record.method !== 'string') return;
    // Electron's `sendCommand` resolves with the command result; we route it
    // through `handleMessage` so that timeouts / error mapping stay uniform.
    try {
      const result = await this.webContents.debugger.sendCommand(record.method, record.params);
      this.handleMessage({ id: record.id, result });
    } catch (error) {
      this.handleMessage({
        id: record.id,
        error: { message: (error as Error).message, code: -32000 },
      });
    }
  }

  protected async dispose(): Promise<void> {
    if (!this.attached) return;
    try {
      this.webContents.debugger.off('message', this.onMessage);
      this.webContents.debugger.off('detach', this.onDetach);
    } catch {
      // listener cleanup is best-effort
    }
    try {
      if (this.webContents.debugger.isAttached()) this.webContents.debugger.detach();
    } catch {
      // already detached
    }
    this.attached = false;
  }
}

/** Options accepted by {@link ElectronBrowserAdapter}. */
export interface ElectronAdapterOptions {
  /** Factory used to create the browser view's `webContents`. */
  createWebContents: () => Promise<ElectronWebContents>;
  /** Called when a session detaches unexpectedly (e.g. renderer crash). */
  onDetach?: (reason: string) => void;
}

/**
 * Adapter that exposes a single Electron `WebContentsView` as a browser.
 *
 * A desktop app typically hosts exactly one embedded browser, so `newContext`
 * returns a context wrapping that view. Multiple pages are supported by
 * navigating the same view (the desktop UI has one preview pane).
 */
export class ElectronBrowserAdapter implements BrowserAdapter {
  private webContents: ElectronWebContents | undefined;
  private page: CdpPage | undefined;
  private context: ElectronBrowserContext | undefined;
  private _connected = false;

  public constructor(private readonly options: ElectronAdapterOptions) {}

  public get connected(): boolean {
    return this._connected;
  }

  /** The embedded page, once {@link launch} has run. */
  public get embeddedPage(): CdpPage | undefined {
    return this.page;
  }

  /** Access to the raw `webContents` (host-only escape hatch). */
  public get embeddedWebContents(): ElectronWebContents | undefined {
    return this.webContents;
  }

  /** Create and attach to the host's embedded browser. */
  public async launch(_opts: LaunchOptions = {}): Promise<void> {
    if (this._connected) throw new CdpError('Electron adapter is already attached');
    const webContents = await this.options.createWebContents();
    this.webContents = webContents;

    const session = new ElectronCdpSession(webContents);
    session.onUnexpectedDetach = (reason) => {
      this._connected = false;
      if (this.options.onDetach) this.options.onDetach(reason);
    };
    await session.attach();

    const page = new CdpPage(session, 'embedded');
    await page.initialize();
    this.page = page;
    this.context = new ElectronBrowserContext(page, webContents);
    this._connected = true;
  }

  /** Not supported: Electron views are created by the host, not connected by URL. */
  public async connect(_endpoint: string): Promise<void> {
    throw new CdpError('ElectronBrowserAdapter cannot connect to a remote endpoint');
  }

  public async newContext(_opts: object = {}): Promise<BrowserContext> {
    if (!this.context) throw new CdpError('Electron adapter has not been launched');
    return this.context;
  }

  public async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
    this.webContents = undefined;
    this._connected = false;
  }
}

/** Context wrapping the single embedded page. */
class ElectronBrowserContext implements BrowserContext {
  public constructor(
    private readonly page: CdpPage,
    private readonly webContents: ElectronWebContents,
  ) {}

  public async newPage(): Promise<CdpPage> {
    return this.page;
  }

  public async pages(): Promise<CdpPage[]> {
    return [this.page];
  }

  public async setCookies(cookies: CookieParam[]): Promise<void> {
    await this.page.cdp().send('Network.setCookies', { cookies });
  }

  public async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
    void this.webContents;
  }
}
