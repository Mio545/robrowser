/**
 * Engine-level ports.
 *
 * `core` must stay host agnostic (no electron / react / fastify imports), so it
 * cannot import the concrete `Page` from `@robrowser/browser`. Instead it
 * declares the *minimal* structural interface it needs; `@robrowser/browser`
 * implements it and the compiler checks the shape is compatible.
 */
import type { SelectorSpec } from '../flow/schema.js';

/** Result of a DOM query performed by a step handler. */
export interface ElementHandleInfo {
  /** Opaque backend node identifier for the matched element. */
  backendNodeId?: number;
  /** Absolute border-box rect in CSS pixels, page coordinates. */
  box: { x: number; y: number; width: number; height: number };
  /** Visible text content (trimmed). */
  text: string;
}

/** Options accepted by {@link PagePort.screenshot}. */
export interface ScreenshotOptions {
  fullPage?: boolean;
  format?: 'png' | 'jpeg';
  quality?: number;
}

/** Options accepted by {@link PagePort.goto}. */
export interface GotoOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
  referer?: string;
}

/** Options for element interactions. */
export interface ElementOptions {
  timeout?: number;
}

/** The minimal CDP surface exposed to step handlers. */
export interface CDPSessionPort {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
}

/**
 * The page surface used by every step handler.
 *
 * `@robrowser/browser` provides the concrete implementation; tests provide a
 * lightweight fake. Implementations must never throw on a *missing* element for
 * `query` (return `null` instead) — only interaction methods throw.
 */
export interface PagePort {
  /** The underlying CDP session (escape hatch used by advanced handlers). */
  cdp(): CDPSessionPort;
  /** Navigate to a URL and wait for the requested lifecycle event. */
  goto(url: string, opts?: GotoOptions): Promise<void>;
  /** Evaluate a function or expression in the page's main world. */
  evaluate<T>(expr: string | ((...args: any[]) => T), ...args: any[]): Promise<T>;
  /** Evaluate in the isolated world (preferred for probing). */
  evaluateIsolated<T>(expr: string | ((...args: any[]) => T), ...args: any[]): Promise<T>;
  /** Click a resolved element. */
  click(
    sel: SelectorSpec,
    opts?: ElementOptions & { button?: 'left' | 'right' | 'middle'; clickCount?: number },
  ): Promise<void>;
  /** Focus an element, optionally clear it, then type text. */
  type(
    sel: SelectorSpec,
    text: string,
    opts?: ElementOptions & { clear?: boolean; delayMs?: number },
  ): Promise<void>;
  /** Choose an `<option>` by value. */
  selectOption(sel: SelectorSpec, value: string, opts?: ElementOptions): Promise<void>;
  /** Move the mouse over a resolved element. */
  hover(sel: SelectorSpec, opts?: ElementOptions): Promise<void>;
  /** Scroll the window (and optionally an element into view). */
  scroll(
    opts: { x?: number; y?: number; selector?: SelectorSpec },
    opts2?: ElementOptions,
  ): Promise<void>;
  /** Capture a screenshot. */
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  /** Full serialised HTML document. */
  content(): Promise<string>;
  /** Current document URL. */
  url(): Promise<string>;
  /** Current document title. */
  title(): Promise<string>;
  /** Query one element and return geometry / text; `null` when absent. */
  query(
    sel: SelectorSpec,
    opts?: { timeout?: number; state?: 'attached' | 'visible' },
  ): Promise<ElementHandleInfo | null>;
  /** Query many elements and return geometry / text. */
  queryAll(sel: SelectorSpec): Promise<ElementHandleInfo[]>;
  /**
   * Read the text (or an attribute) of every element matching `sel`.
   *
   * `attr` semantics: `null`/`undefined` → `innerText`; `"value"`/`"checked"` →
   * the DOM *property*; anything else → `getAttribute`.
   */
  readAll(sel: SelectorSpec, attr?: string): Promise<Array<string | null>>;
  /** Read an attribute / property of the first matched element. */
  attr(sel: SelectorSpec, name: string, opts?: ElementOptions): Promise<string | null>;
  /** Text content of the first matched element. */
  text(sel: SelectorSpec, opts?: ElementOptions): Promise<string | null>;
  /** Dispatch a special key (e.g. `Enter`, `Tab`) to the page. */
  key(name: string): Promise<void>;
  /** Insert text without keyboard events (IME friendly). */
  insertText(text: string): Promise<void>;
  /** Wait until the DOM reaches the requested selector state. */
  waitForSelector(
    sel: SelectorSpec,
    opts?: { state?: 'attached' | 'visible' | 'hidden'; timeout?: number },
  ): Promise<void>;
  /** Wait for a URL pattern (glob-ish substring or regex source). */
  waitForUrl(pattern: string, opts?: { timeout?: number }): Promise<void>;
  /** Wait until no network requests are in flight for `idleMs`. */
  waitForNetworkIdle(opts?: { idleMs?: number; timeout?: number }): Promise<void>;
  /** Wait for a download to start and return its suggested filename + bytes. */
  waitForDownload(opts?: {
    timeout?: number;
  }): Promise<{ suggestedFilename: string; saveAs(path: string): Promise<void> }>;
  /** Page fingerprint summary used by `PageRule` matching. */
  fingerprint(): Promise<{ url: string; title: string }>;
  /** Subscribe to page events (`navigation`, `load`, `domcontentloaded`, `framenavigated`, `download`). */
  on(event: string, handler: (...args: any[]) => void): void;
  /** Unsubscribe a page listener. */
  off(event: string, handler: (...args: any[]) => void): void;
}

/** Logger port; hosts supply pino, tests supply a silent logger. */
export interface LoggerPort {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Silent logger used when a host does not provide one. */
export const nullLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
