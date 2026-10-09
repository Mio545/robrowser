/**
 * Headless / remote browser adapter (spec 6).
 *
 * Strategy: spawn (or connect to) a system Chromium/Chrome started with
 * `--remote-debugging-port`, discover targets over the HTTP endpoints
 * (`/json/version`, `/json/list`), and speak CDP directly over WebSocket.
 *
 * Port `0` means "let the OS choose": the actual port is parsed from the
 * browser's stderr (`DevTools listening on ws://...`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { CDPSession, CdpEventHandler } from './cdp-session.js';
import { BaseCdpSession } from './cdp-session.js';
import { CdpError } from './errors.js';
import {
  CdpPage,
  type BrowserAdapter,
  type BrowserContext,
  type CookieParam,
  type LaunchOptions,
} from './adapter.js';

/** A CDP target as reported by `/json/list`. */
export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  browserContextId?: string;
}

/** WebSocket-backed {@link CDPSession}. */
export class WebSocketCdpSession extends BaseCdpSession {
  public constructor(
    private readonly socket: WebSocket,
    label = 'remote',
  ) {
    super({ label });
    this.socket.on('message', (data: Buffer | string) => {
      this.handleMessage(typeof data === 'string' ? data : data.toString('utf8'));
    });
  }

  protected async transmit(message: string | object): Promise<void> {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    await new Promise<void>((resolve, reject) => {
      this.socket.send(payload, (error?: Error) => (error ? reject(error) : resolve()));
    });
  }

  protected async dispose(): Promise<void> {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

/** Default Chromium executable resolution order per platform. */
export function defaultChromiumCandidates(): string[] {
  const envPath = process.env.CHROME_PATH;
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  if (process.platform === 'win32') {
    candidates.push(
      join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium',
    );
  }
  return candidates.filter((candidate) => candidate.length > 0);
}

/**
 * Adapter that drives an external or spawned Chromium over WebSocket.
 *
 * One adapter owns at most one browser process; `close()` terminates it (or just
 * detaches when {@link connect} was used).
 */
export class RemoteBrowserAdapter implements BrowserAdapter {
  private child: ChildProcess | undefined;
  private browserWsUrl: string | undefined;
  private httpEndpoint: string | undefined;
  private port: number | undefined;
  private ownsProcess = false;
  private tempProfile: string | undefined;
  private readonly contexts = new Map<string, RemoteBrowserContext>();
  private _connected = false;

  public get connected(): boolean {
    return this._connected;
  }

  /** The resolved debugging port (after launch). */
  public get debuggingPort(): number | undefined {
    return this.port;
  }

  /** The browser-level WebSocket URL (not a page target). */
  public get browserWebSocketUrl(): string | undefined {
    return this.browserWsUrl;
  }

  /** Launch a local Chromium with a remote debugging port. */
  public async launch(opts: LaunchOptions = {}): Promise<void> {
    if (this._connected) throw new CdpError('Adapter is already connected');

    const executable = opts.executablePath ?? (await resolveExecutable());
    const port = opts.port ?? 0;
    const profileDir = opts.userDataDir ?? (await mkdtemp(join(tmpdir(), 'robrowser-')));
    if (!opts.userDataDir) this.tempProfile = profileDir;

    const headless = opts.headless ?? true;
    const args = [
      ...(headless === false ? [] : ['--headless=new']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=Translate,MediaRouter',
      '--disable-component-update',
      '--metrics-recording-only',
      '--disable-extensions',
      ...(opts.downloadPath ? [`--download-default-directory=${opts.downloadPath}`] : []),
      ...(opts.args ?? []),
      'about:blank',
    ];

    // Container-friendly flags must be explicit; they are NOT enabled by default
    // because `--no-sandbox` weakens the security boundary on developer machines.
    const extraEnv = opts.env ?? {};

    const child = spawn(executable, args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.ownsProcess = true;

    const wsUrl = await waitForDebuggingUrl(child, (opts.port ?? 0) ? port : undefined);
    this.browserWsUrl = wsUrl;
    const parsed = new URL(wsUrl);
    this.port = Number(parsed.port);
    this.httpEndpoint = `http://${parsed.hostname}:${parsed.port}`;
    this._connected = true;
  }

  /** Attach to an already-running browser (e.g. an external `--remote-debugging-port`). */
  public async connect(endpoint: string): Promise<void> {
    if (this._connected) throw new CdpError('Adapter is already connected');
    const normalized = normalizeEndpoint(endpoint);
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
      `${normalized}/json/version`,
    );
    if (!version.webSocketDebuggerUrl) {
      throw new CdpError(`Endpoint ${normalized} did not expose a webSocketDebuggerUrl`, {
        endpoint,
      });
    }
    this.browserWsUrl = version.webSocketDebuggerUrl;
    const parsed = new URL(version.webSocketDebuggerUrl);
    this.port = Number(parsed.port);
    this.httpEndpoint = normalized;
    this._connected = true;
    this.ownsProcess = false;
  }

  /** Create a new browser context (isolated storage) and return it. */
  public async newContext(opts: object = {}): Promise<BrowserContext> {
    this.assertConnected();
    const contextId = `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const context = new RemoteBrowserContext(this, contextId, opts);
    this.contexts.set(contextId, context);
    return context;
  }

  /** Close the browser process (or detach from an external one). */
  public async close(): Promise<void> {
    for (const context of [...this.contexts.values()]) {
      await context.close().catch(() => undefined);
    }
    this.contexts.clear();

    if (this.ownsProcess && this.child) {
      const child = this.child;
      this.child = undefined;
      await terminateChild(child);
    }
    if (this.tempProfile) {
      await rm(this.tempProfile, { recursive: true, force: true }).catch(() => undefined);
      this.tempProfile = undefined;
    }
    this._connected = false;
  }

  /** List all page targets known to the browser. */
  public async targets(): Promise<CdpTarget[]> {
    this.assertConnected();
    return fetchJson<CdpTarget[]>(`${this.httpEndpoint}/json/list`);
  }

  /**
   * Open a raw WebSocket CDP session to a specific target.
   *
   * @param target WebSocket URL or a target id from {@link targets}.
   */
  public async attachTo(target: CdpTarget): Promise<CDPSession> {
    if (!target.webSocketDebuggerUrl) {
      throw new CdpError(`Target ${target.id} has no webSocketDebuggerUrl`, {
        targetId: target.id,
      });
    }
    return openWebSocketSession(target.webSocketDebuggerUrl);
  }

  /**
   * Open a CDP session to the first page target matching an optional URL filter.
   */
  public async attachToPage(
    urlMatch?: string,
  ): Promise<{ session: CDPSession; target: CdpTarget }> {
    const targets = (await this.targets()).filter((target) => target.type === 'page');
    const target =
      (urlMatch ? targets.find((candidate) => candidate.url.includes(urlMatch)) : undefined) ??
      targets[0];
    if (!target) throw new CdpError('No page target available', { urlMatch });
    return { session: await this.attachTo(target), target };
  }

  private assertConnected(): void {
    if (!this._connected || !this.httpEndpoint) {
      throw new CdpError('Adapter is not connected; call launch() or connect() first');
    }
  }
}

/** A context implemented on top of the browser's page targets. */
class RemoteBrowserContext implements BrowserContext {
  private readonly pages_: CdpPage[] = [];
  private closed = false;

  public constructor(
    private readonly adapter: RemoteBrowserAdapter,
    private readonly id: string,
    private readonly options: object,
  ) {
    void this.options;
  }

  public async newPage(): Promise<CdpPage> {
    if (this.closed) throw new CdpError(`Context ${this.id} is closed`);
    const { session } = await this.adapter.attachToPage('about:blank');
    const page = new CdpPage(session, `page-${this.pages_.length + 1}`);
    await page.initialize();
    this.pages_.push(page);
    return page;
  }

  public async pages(): Promise<CdpPage[]> {
    return [...this.pages_];
  }

  public async setCookies(cookies: CookieParam[]): Promise<void> {
    if (this.pages_.length === 0) await this.newPage();
    const page = this.pages_[0]!;
    await page.cdp().send('Network.setCookies', { cookies });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const page of this.pages_) {
      await page.close().catch(() => undefined);
    }
    this.pages_.length = 0;
  }
}

/* ------------------------------------------------------------------ helpers */

/** Open a WebSocket-backed CDP session. */
export async function openWebSocketSession(url: string): Promise<CDPSession> {
  const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off('open', onOpen);
      reject(new CdpError(`Failed to connect to ${url}: ${error.message}`, { url }));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
  return new WebSocketCdpSession(socket, url);
}

/** Locate a usable Chromium executable. */
export async function resolveExecutable(): Promise<string> {
  const { access } = await import('node:fs/promises');
  for (const candidate of defaultChromiumCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new CdpError(
    'No Chromium/Chrome executable found. Set CHROME_PATH or pass executablePath.',
    { candidates: defaultChromiumCandidates() },
  );
}

/** Wait for the `DevTools listening on <url>` banner on stderr. */
function waitForDebuggingUrl(child: ChildProcess, knownPort?: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      if (knownPort) {
        resolve(`ws://127.0.0.1:${knownPort}/devtools/browser`);
        return;
      }
      reject(new CdpError('Timed out waiting for the DevTools endpoint'));
    }, 30_000);

    const cleanup = (): void => {
      clearTimeout(timeout);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(buffer);
      if (match?.[1]) {
        cleanup();
        resolve(match[1]);
      }
    };

    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new CdpError(`Browser exited before exposing DevTools (code ${code ?? 'null'})`, {
          stderr: buffer.slice(-2000),
        }),
      );
    };

    child.stderr?.on('data', onData);
    child.once('exit', onExit);
  });
}

/** Terminate a child process, escalating to SIGKILL / taskkill. */
async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5_000)),
  ]);
  if (timedOut) {
    if (process.platform === 'win32' && child.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
        });
        killer.once('exit', () => resolve());
        killer.once('error', () => resolve());
      });
    } else {
      child.kill('SIGKILL');
    }
  }
  await exited;
}

function normalizeEndpoint(endpoint: string): string {
  let normalized = endpoint.trim();
  if (!/^https?:\/\//.test(normalized)) normalized = `http://${normalized}`;
  return normalized.replace(/\/+$/, '');
}

async function fetchJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new CdpError(`Request to ${url} failed: ${(error as Error).message}`, { url });
  }
  if (!response.ok) {
    throw new CdpError(`Request to ${url} returned ${response.status}`, { url });
  }
  return (await response.json()) as T;
}

export type { CdpEventHandler };
