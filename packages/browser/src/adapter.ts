/**
 * Browser adapter interfaces + the protocol-agnostic page implementation
 * (spec 6).
 *
 * `RemoteBrowserAdapter` (headless, WebSocket) and `ElectronBrowserAdapter`
 * (desktop, `webContents.debugger`) both produce {@link CdpPage} instances built
 * on a {@link CDPSession}; only the transport differs.
 */
import type { PagePort, ElementHandleInfo, ScreenshotOptions } from '@robrowser/core';
import type { SelectorSpec } from '@robrowser/core';
import { SelectorNotFoundError, StepTimeoutError, matchPage } from '@robrowser/core';
import type { PageRule } from '@robrowser/core';
import type { CDPSession } from './cdp-session.js';
import { CdpError } from './errors.js';
import { NetworkWatcher } from './network-watcher.js';
import {
  buildQueryAllExpression,
  buildQueryExpression,
  resolveSelectorSpec,
  describeSelector,
} from './selectors.js';
import {
  dispatchKey,
  dispatchMouse,
  dispatchMouseMove,
  dispatchWheel,
  insertText as cdpInsertText,
} from './input.js';
import { getLayoutMetrics } from './metrics.js';

/** Options for launching a browser. */
export interface LaunchOptions {
  /** Path to the Chromium/Chrome executable. */
  executablePath?: string;
  /** `true` (default), `false`, or the new headless mode string. */
  headless?: boolean | 'new';
  /** Extra command line arguments. */
  args?: string[];
  /** Fixed remote debugging port (0 = ephemeral, parsed from stderr). */
  port?: number;
  /** Environment variables for the child process. */
  env?: Record<string, string>;
  /** Working directory used for downloads. */
  downloadPath?: string;
  /** User data directory (temporary when omitted). */
  userDataDir?: string;
}

/** Cookie set/get payload. */
export interface CookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  url?: string;
}

/** A browser context (isolated cookies / downloads). */
export interface BrowserContext {
  /** Create a new page inside this context. */
  newPage(): Promise<CdpPage>;
  /** All pages in the context. */
  pages(): Promise<CdpPage[]>;
  /** Set cookies for the context. */
  setCookies(cookies: CookieParam[]): Promise<void>;
  /** Close the context (and its pages). */
  close(): Promise<void>;
}

/** The adapter contract implemented by both hosts. */
export interface BrowserAdapter {
  /** Launch a local browser. */
  launch(opts?: LaunchOptions): Promise<void>;
  /** Attach to an already-running browser endpoint. */
  connect(endpoint: string): Promise<void>;
  /** Create a new isolated context. */
  newContext(opts?: object): Promise<BrowserContext>;
  /** Close the browser (or detach, when connected to an external one). */
  close(): Promise<void>;
  /** True once `launch`/`connect` has succeeded. */
  readonly connected: boolean;
}

/** Events emitted by {@link CdpPage}. */
export interface PageEvents {
  navigation: { url: string };
  load: undefined;
  domcontentloaded: undefined;
  framenavigated: { url: string };
  download: { suggestedFilename: string };
  close: undefined;
}

const DEFAULT_SELECTOR_TIMEOUT = 15_000;

/**
 * Protocol-agnostic `PagePort` implementation over a {@link CDPSession}.
 *
 * One instance may talk either to a raw WebSocket page target or to an Electron
 * `webContents` debugger; the only requirement is that the session speaks CDP
 * 1.3 for the Page / Runtime / DOM / Network / Input domains.
 */
export class CdpPage implements PagePort {
  private readonly network: NetworkWatcher;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();
  private readonly downloadHandlers = new Set<(info: { suggestedFilename: string }) => void>();
  private readonly contexts = new Map<string, number>();
  private executionContextId = 1;
  private isolatedWorldId: number | undefined;
  private readonly pendingDownloads = new Map<string, number>();
  private mainFrameId: string | undefined;

  public constructor(
    private readonly session: CDPSession,
    private readonly label = 'page',
  ) {
    this.network = new NetworkWatcher(session);
    this.registerProtocolListeners();
  }

  /* ----------------------------------------------------------- lifecycle */

  /** Enable the domains this page relies on. Idempotent. */
  public async initialize(): Promise<void> {
    await this.session.send('Page.enable');
    await this.session.send('Runtime.enable');
    await this.session.send('DOM.enable');
    await this.network.start();
    // A persistent isolated world for injected probes (spec 5.3).
    const world = await this.session.send<{ executionContextId: number }>(
      'Page.createIsolatedWorld',
      {
        frameId: await this.mainFrame(),
        worldName: 'robrowser-probe',
        grantUniveralAccess: false,
      },
    );
    this.isolatedWorldId = world.executionContextId;
  }

  /** The underlying CDP session. */
  public cdp(): CDPSession {
    return this.session;
  }

  /** Detach helpers and the session. */
  public async close(): Promise<void> {
    this.network.dispose();
    this.emit('close', undefined);
    await this.session.detach();
  }

  /* -------------------------------------------------------------- events */

  public on(event: string, handler: (...args: any[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  public off(event: string, handler: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: string, payload: unknown): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) {
      try {
        handler(payload);
      } catch {
        // listener errors must not break the page
      }
    }
  }

  private registerProtocolListeners(): void {
    const session = this.session;

    session.on('Page.frameNavigated', (params: unknown) => {
      const frame = (params as { frame?: { id?: string; url?: string; parentId?: string } }).frame;
      if (!frame?.id) return;
      if (!frame.parentId) {
        this.mainFrameId = frame.id;
        this.emit('framenavigated', { url: frame.url ?? '' });
        this.emit('navigation', { url: frame.url ?? '' });
      }
    });

    session.on('Page.loadEventFired', () => this.emit('load', undefined));
    session.on('Page.domContentEventFired', () => this.emit('domcontentloaded', undefined));

    session.on('Runtime.executionContextCreated', (params: unknown) => {
      const context = (
        params as { context?: { id?: number; name?: string; auxData?: { frameId?: string } } }
      ).context;
      if (context?.id) this.contexts.set(context.name ?? String(context.id), context.id);
    });

    // Downloads surface through the browser-level session in most Chromium
    // builds; the page-level `Page.downloadWillBegin` event covers Electron.
    session.on('Page.downloadWillBegin', (params: unknown) => {
      const record = params as { guid?: string; suggestedFilename?: string };
      if (record.guid && record.suggestedFilename) {
        this.pendingDownloads.set(record.guid, 0);
        for (const handler of this.downloadHandlers) {
          handler({ suggestedFilename: record.suggestedFilename });
        }
      }
    });
    session.on('Browser.downloadWillBegin', (params: unknown) => {
      const record = params as { guid?: string; suggestedFilename?: string };
      if (record.guid && record.suggestedFilename) {
        this.pendingDownloads.set(record.guid, 0);
        for (const handler of this.downloadHandlers) {
          handler({ suggestedFilename: record.suggestedFilename });
        }
      }
    });
  }

  /* --------------------------------------------------------- navigation */

  public async goto(
    url: string,
    opts: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number } = {},
  ): Promise<void> {
    const waitUntil = opts.waitUntil ?? 'load';
    const timeout = opts.timeout ?? 30_000;

    const navigation = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.off('load', onLoad);
        this.off('domcontentloaded', onDom);
      };
      const onLoad = (): void => {
        if (waitUntil !== 'load') return;
        cleanup();
        resolve();
      };
      const onDom = (): void => {
        if (waitUntil !== 'domcontentloaded') return;
        cleanup();
        resolve();
      };
      this.on('load', onLoad);
      this.on('domcontentloaded', onDom);
      setTimeout(() => {
        cleanup();
        reject(
          new StepTimeoutError('goto', timeout, `Timed out waiting for ${waitUntil} on ${url}`),
        );
      }, timeout).unref?.();
    });

    const result = await this.session.send<{ errorText?: string }>('Page.navigate', { url });
    if (result.errorText) {
      throw new CdpError(`Navigation to ${url} failed: ${result.errorText}`, { url });
    }

    if (waitUntil === 'networkidle') {
      await this.waitForLoadState();
      await this.waitForNetworkIdle({ timeout });
      return;
    }
    await navigation;
  }

  /** Resolve when the document reaches `readyState === 'complete'`. */
  private async waitForLoadState(): Promise<void> {
    await this.session.send('Runtime.evaluate', {
      expression:
        'new Promise((r) => (document.readyState === "complete" ? r() : window.addEventListener("load", r, { once: true })))',
      awaitPromise: true,
    });
  }

  /* ---------------------------------------------------------- evaluation */

  public async evaluate<T>(expr: string | ((...args: any[]) => T), ...args: any[]): Promise<T> {
    const expression = buildEvaluateExpression(expr, args);
    const result = await this.session.send<{
      result?: { value?: unknown; unserializableValue?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const description =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new CdpError(`evaluate failed: ${description}`, {
        expression: expression.slice(0, 200),
      });
    }
    return (result.result?.value ?? null) as T;
  }

  public async evaluateIsolated<T>(
    expr: string | ((...args: any[]) => T),
    ...args: any[]
  ): Promise<T> {
    const expression = buildEvaluateExpression(expr, args);
    if (this.isolatedWorldId === undefined) return this.evaluate(expression);
    const result = await this.session.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string };
    }>('Runtime.evaluate', {
      expression,
      contextId: this.isolatedWorldId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new CdpError(`evaluateIsolated failed: ${result.exceptionDetails.text}`, {
        expression: expression.slice(0, 200),
      });
    }
    return (result.result?.value ?? null) as T;
  }

  /* -------------------------------------------------------- interactions */

  public async click(
    sel: SelectorSpec,
    opts: { button?: 'left' | 'right' | 'middle'; clickCount?: number; timeout?: number } = {},
  ): Promise<void> {
    const box = await this.requireBox(sel, opts.timeout);
    await dispatchMouse(this.session, box.x, box.y, {
      button: opts.button ?? 'left',
      clickCount: opts.clickCount ?? 1,
    });
  }

  public async type(
    sel: SelectorSpec,
    text: string,
    opts: { clear?: boolean; delayMs?: number; timeout?: number } = {},
  ): Promise<void> {
    const box = await this.requireBox(sel, opts.timeout);
    await dispatchMouse(this.session, box.x, box.y, { clickCount: 1 });

    if (opts.clear !== false) {
      // Select the field contents and delete them, which fires input events the
      // way a user would (unlike setting `.value` directly).
      await dispatchKey(this.session, 'a', {
        modifiers: ['ctrl'],
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
      });
      await dispatchKey(this.session, 'Delete', { code: 'Delete', windowsVirtualKeyCode: 46 });
    }

    if (opts.delayMs && opts.delayMs > 0) {
      for (const char of text) {
        await insertTextViaEvents(this.session, char);
        await sleep(opts.delayMs);
      }
    } else {
      await cdpInsertText(this.session, text);
    }
  }

  public async selectOption(
    sel: SelectorSpec,
    value: string,
    opts: { timeout?: number } = {},
  ): Promise<void> {
    const expression = buildSelectExpression(sel, value);
    const result = await this.evaluate<{ ok: boolean; value?: string; options?: string[] }>(
      expression,
    );
    if (!result?.ok) {
      throw new SelectorNotFoundError(
        sel,
        `Could not select "${value}" on ${describeSelector(sel)}; available: ${(result?.options ?? []).join(', ') || '(none)'}`,
      );
    }
    void opts;
  }

  public async hover(sel: SelectorSpec, opts: { timeout?: number } = {}): Promise<void> {
    const box = await this.requireBox(sel, opts.timeout);
    await dispatchMouseMove(this.session, box.x, box.y);
  }

  public async scroll(
    opts: { x?: number; y?: number; selector?: SelectorSpec },
    opts2: { timeout?: number } = {},
  ): Promise<void> {
    if (opts.selector) {
      const expression = buildScrollIntoViewExpression(opts.selector);
      const found = await this.evaluate<boolean>(expression);
      if (!found) throw new SelectorNotFoundError(opts.selector);
      void opts2;
      return;
    }
    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    if (x !== 0 || y !== 0) {
      await dispatchWheel(this.session, 1, 1, x, y);
    }
  }

  public async screenshot(opts: ScreenshotOptions = {}): Promise<Buffer> {
    const params: Record<string, unknown> = {
      format: opts.format ?? 'png',
      fromSurface: true,
      captureBeyondViewport: opts.fullPage ?? false,
    };
    if (opts.format === 'jpeg' && opts.quality !== undefined) params.quality = opts.quality;

    if (opts.fullPage) {
      const metrics = await getLayoutMetrics(this.session);
      params.clip = {
        x: 0,
        y: 0,
        width: Math.max(metrics.contentSize.clientWidth, metrics.cssLayoutViewport.clientWidth),
        height: Math.max(metrics.contentSize.clientHeight, metrics.cssLayoutViewport.clientHeight),
        scale: 1,
      };
    }

    const result = await this.session.send<{ data: string }>('Page.captureScreenshot', params);
    return Buffer.from(result.data, 'base64');
  }

  public async content(): Promise<string> {
    const result = await this.evaluate<{ html: string }>(
      '({html: document.documentElement.outerHTML})',
    );
    return result?.html ?? '';
  }

  public async url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  public async title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  /* --------------------------------------------------------------- query */

  public async query(
    sel: SelectorSpec,
    opts: { timeout?: number; state?: 'attached' | 'visible' } = {},
  ): Promise<ElementHandleInfo | null> {
    if (opts.timeout && opts.timeout > 0) {
      const found = await this.waitForSelector(sel, {
        state: opts.state === 'visible' ? 'visible' : 'attached',
        timeout: opts.timeout,
      })
        .then(() => true)
        .catch(() => false);
      if (!found) return null;
    }
    const strategies = resolveSelectorSpec(sel);
    const expression = buildInfoExpression(strategies);
    const info = await this.evaluate<ElementHandleInfo | null>(expression);
    return info ?? null;
  }

  public async queryAll(sel: SelectorSpec): Promise<ElementHandleInfo[]> {
    const strategies = resolveSelectorSpec(sel);
    const expression = buildInfoAllExpression(strategies);
    return (await this.evaluate<ElementHandleInfo[]>(expression)) ?? [];
  }

  public async readAll(sel: SelectorSpec, attr?: string): Promise<Array<string | null>> {
    const strategies = resolveSelectorSpec(sel);
    const expression = buildReadAllExpression(strategies, attr);
    return (await this.evaluate<Array<string | null>>(expression)) ?? [];
  }

  public async attr(
    sel: SelectorSpec,
    name: string,
    opts: { timeout?: number } = {},
  ): Promise<string | null> {
    const values = await this.query(sel, { timeout: opts.timeout });
    if (!values) return null;
    return this.evaluate<string | null>(buildReadFirstExpression(sel, name));
  }

  public async text(sel: SelectorSpec, opts: { timeout?: number } = {}): Promise<string | null> {
    const values = await this.query(sel, { timeout: opts.timeout });
    if (!values) return null;
    return this.evaluate<string | null>(buildReadFirstExpression(sel, undefined));
  }

  /* ---------------------------------------------------------------- wait */

  public async waitForSelector(
    sel: SelectorSpec,
    opts: { state?: 'attached' | 'visible' | 'hidden'; timeout?: number } = {},
  ): Promise<void> {
    const state = opts.state ?? 'visible';
    const timeout = opts.timeout ?? DEFAULT_SELECTOR_TIMEOUT;
    const strategies = resolveSelectorSpec(sel);
    const predicate = buildStatePredicate(strategies, state);
    const ok = await this.pollUntil(predicate, timeout);
    if (!ok) {
      throw new SelectorNotFoundError(
        sel,
        `Timed out after ${timeout}ms waiting for ${describeSelector(sel)} to be ${state}`,
      );
    }
  }

  public async waitForUrl(pattern: string, opts: { timeout?: number } = {}): Promise<void> {
    const timeout = opts.timeout ?? 30_000;
    const predicate = buildUrlPredicate(pattern);
    const ok = await this.pollUntil(predicate, timeout);
    if (!ok)
      throw new StepTimeoutError('waitForUrl', timeout, `Timed out waiting for url ~ ${pattern}`);
  }

  public async waitForNetworkIdle(opts: { idleMs?: number; timeout?: number } = {}): Promise<void> {
    await this.network.waitForIdle(opts.idleMs ?? 500, opts.timeout ?? 30_000);
  }

  public async waitForDownload(opts: { timeout?: number } = {}): Promise<{
    suggestedFilename: string;
    saveAs(path: string): Promise<void>;
  }> {
    const timeout = opts.timeout ?? 60_000;
    const info = await new Promise<{ suggestedFilename: string }>((resolve, reject) => {
      const handler = (payload: { suggestedFilename: string }): void => {
        clearTimeout(timer);
        this.downloadHandlers.delete(handler);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        this.downloadHandlers.delete(handler);
        reject(
          new StepTimeoutError(
            'waitForDownload',
            timeout,
            'Timed out waiting for a download to start',
          ),
        );
      }, timeout);
      this.downloadHandlers.add(handler);
      // Ask the browser to allow downloads; the host decides the directory.
      void this.session
        .send('Page.setDownloadBehavior', { behavior: 'default' })
        .catch(() => undefined);
    });

    return {
      suggestedFilename: info.suggestedFilename,
      saveAs: async (path: string): Promise<void> => {
        await this.session
          .send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: path })
          .catch(async () => {
            await this.session.send('Browser.setDownloadBehavior', {
              behavior: 'allow',
              downloadPath: path,
            });
          });
      },
    };
  }

  public async fingerprint(): Promise<{ url: string; title: string }> {
    const result = await this.evaluate<{ url: string; title: string }>(
      '({url: location.href, title: document.title || ""})',
    );
    return result ?? { url: '', title: '' };
  }

  /** Evaluate a {@link PageRule} against this page (convenience wrapper). */
  public async matches(rule: PageRule): Promise<boolean> {
    return (await matchPage(this, rule)).matched;
  }

  /* --------------------------------------------------------------- input */

  public async key(name: string): Promise<void> {
    await dispatchKey(this.session, name);
  }

  public async insertText(text: string): Promise<void> {
    await cdpInsertText(this.session, text);
  }

  /* ------------------------------------------------------------ internals */

  private async mainFrame(): Promise<string> {
    if (this.mainFrameId) return this.mainFrameId;
    const tree = await this.session.send<{ frameTree?: { frame?: { id: string } } }>(
      'Page.getFrameTree',
    );
    this.mainFrameId = tree.frameTree?.frame?.id ?? 'main';
    return this.mainFrameId;
  }

  private async requireBox(
    sel: SelectorSpec,
    timeout = DEFAULT_SELECTOR_TIMEOUT,
  ): Promise<{ x: number; y: number }> {
    const info = await this.query(sel, { timeout, state: 'visible' });
    if (!info) {
      throw new SelectorNotFoundError(
        sel,
        `Element not found or not visible within ${timeout}ms: ${describeSelector(sel)}`,
      );
    }
    if (info.box.width <= 0 || info.box.height <= 0) {
      throw new SelectorNotFoundError(sel, `Element has zero size: ${describeSelector(sel)}`);
    }
    return { x: info.box.x, y: info.box.y };
  }

  /**
   * Poll a boolean page-side expression until it returns true.
   *
   * Uses `Runtime.evaluate` with `awaitPromise` so the page does the waiting
   * itself; we only re-check when the expression resolves falsely (events are
   * unavailable for arbitrary predicates).
   */
  private async pollUntil(expression: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // Fast path: an awaiting expression keeps the round-trip count low.
    const waitExpression = `(async () => {
      const deadline = Date.now() + ${Math.max(0, timeoutMs - 100)};
      for (;;) {
        let ok = false;
        try { ok = !!(${expression}); } catch (e) { ok = false; }
        if (ok) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
    })()`;
    try {
      const result = await this.session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
        expression: waitExpression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.result?.value === true) return true;
    } catch {
      // fall through to the slow path
    }
    // Slow path: coarse re-checks for engines that reject long awaits.
    for (;;) {
      try {
        const value = await this.evaluate<boolean>(expression);
        if (value) return true;
      } catch {
        // ignore transient navigation errors
      }
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  }
}

/* ------------------------------------------------------------- expressions */

function buildCallExpression(fn: ((...args: any[]) => unknown) | string, args: unknown[]): string {
  return `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
}

/**
 * Build the CDP `Runtime.evaluate` expression for either a function or a string.
 *
 * Function expressions are always invoked with the supplied arguments. String
 * expressions are invoked only when arguments are present; without arguments the
 * snippet is evaluated verbatim, so expressions such as `'location.href'` or
 * `'({url: location.href})'` keep working as plain evaluations.
 */
function buildEvaluateExpression(
  expr: string | ((...args: any[]) => unknown),
  args: unknown[],
): string {
  if (typeof expr === 'function') return buildCallExpression(expr, args);
  return args.length > 0 ? buildCallExpression(expr, args) : expr;
}

function buildInfoExpression(strategies: ReturnType<typeof resolveSelectorSpec>): string {
  return `(function(){var found=${buildQueryExpression(strategies)};
if(!found)return null;var el=found.node,r=el.getBoundingClientRect(),sx=window.scrollX||0,sy=window.scrollY||0;
var style=window.getComputedStyle(el);
var visible=style.visibility!=='hidden'&&style.display!=='none'&&(r.width>0||r.height>0);
return {box:{x:r.left+sx+r.width/2,y:r.top+sy+r.height/2,width:r.width,height:r.height},text:(el.innerText||el.textContent||'').trim(),visible:visible,strategyIndex:found.index};})()`;
}

function buildInfoAllExpression(strategies: ReturnType<typeof resolveSelectorSpec>): string {
  return `(function(){var nodes=${buildQueryAllExpression(strategies)};
return nodes.map(function(el){var r=el.getBoundingClientRect(),sx=window.scrollX||0,sy=window.scrollY||0;
return {box:{x:r.left+sx+r.width/2,y:r.top+sy+r.height/2,width:r.width,height:r.height},text:(el.innerText||el.textContent||'').trim()};});})()`;
}

function buildReadAllExpression(
  strategies: ReturnType<typeof resolveSelectorSpec>,
  attr?: string,
): string {
  const reader = renderValueReader(attr);
  return `(function(){var nodes=${buildQueryAllExpression(strategies)};
return nodes.map(function(el){return ${reader};});})()`;
}

function buildReadFirstExpression(spec: SelectorSpec, attr?: string): string {
  const strategies = resolveSelectorSpec(spec);
  const reader = renderValueReader(attr);
  return `(function(){var found=${buildQueryExpression(strategies)};
if(!found)return null;var el=found.node;return ${reader};})()`;
}

/** `null` attr -> innerText; `value`/`checked` -> property; else attribute. */
function renderValueReader(attr?: string): string {
  if (attr === undefined || attr === null) return `(el.innerText || el.textContent || '')`;
  if (attr === 'value' || attr === 'checked' || attr === 'selectedIndex' || attr === 'disabled') {
    return `String(el[${JSON.stringify(attr)}])`;
  }
  return `el.getAttribute(${JSON.stringify(attr)})`;
}

function buildSelectExpression(sel: SelectorSpec, value: string): string {
  const strategies = resolveSelectorSpec(sel);
  return `(function(){var found=${buildQueryExpression(strategies)};
if(!found)return {ok:false,options:[]};var el=found.node;
if(!el || el.tagName!=='SELECT')return {ok:false,options:[]};
var options=Array.from(el.options).map(function(o){return o.value;});
el.value=${JSON.stringify(value)};
if(el.value!==${JSON.stringify(value)}){
  var byText=Array.from(el.options).find(function(o){return o.textContent.trim()===${JSON.stringify(value)};});
  if(byText){el.value=byText.value;}
}
if(el.value!==${JSON.stringify(value)})return {ok:false,options:options};
el.dispatchEvent(new Event('input',{bubbles:true}));
el.dispatchEvent(new Event('change',{bubbles:true}));
return {ok:true,value:el.value,options:options};})()`;
}

function buildScrollIntoViewExpression(sel: SelectorSpec): string {
  const strategies = resolveSelectorSpec(sel);
  return `(function(){var found=${buildQueryExpression(strategies)};
if(!found)return false;found.node.scrollIntoView({block:'center',inline:'center'});return true;})()`;
}

function buildStatePredicate(
  strategies: ReturnType<typeof resolveSelectorSpec>,
  state: 'attached' | 'visible' | 'hidden',
): string {
  if (state === 'hidden') {
    return `!(${buildQueryExpression(strategies)})`;
  }
  if (state === 'attached') {
    return `!!(${buildQueryExpression(strategies)})`;
  }
  return `(function(){var f=${buildQueryExpression(strategies)};if(!f)return false;var el=f.node;var r=el.getBoundingClientRect();var st=window.getComputedStyle(el);return st.visibility!=='hidden'&&st.display!=='none'&&(r.width>0||r.height>0);})()`;
}

function buildUrlPredicate(pattern: string): string {
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const end = pattern.lastIndexOf('/');
    return `new RegExp(${JSON.stringify(pattern.slice(1, end))}, ${JSON.stringify(pattern.slice(end + 1))}).test(location.href)`;
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return `new RegExp(${JSON.stringify(`^${escaped}$`)}).test(location.href)`;
  }
  return `location.href.includes(${JSON.stringify(pattern)})`;
}

async function insertTextViaEvents(session: CDPSession, char: string): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: char,
    unmodifiedText: char,
    key: char,
  });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Raw text helper used by `PagePort.content` consumers. */
export { matchPage };
