/**
 * `@robrowser/browser` public surface.
 *
 * Pure Node/TypeScript: no electron / react / express / fastify imports. The
 * Electron integration is provided as a *structural* adapter that the desktop
 * host wires up, which keeps this package host agnostic (spec 0).
 */

/* -- CDP session ----------------------------------------------------------- */
export {
  BaseCdpSession,
  type CDPSession,
  type CdpEventHandler,
  type CdpSessionOptions,
} from './cdp-session.js';

/* -- adapters -------------------------------------------------------------- */
export {
  CdpPage,
  type BrowserAdapter,
  type BrowserContext,
  type LaunchOptions,
  type CookieParam,
  type PageEvents,
} from './adapter.js';
export {
  RemoteBrowserAdapter,
  WebSocketCdpSession,
  openWebSocketSession,
  resolveExecutable,
  defaultChromiumCandidates,
  type CdpTarget,
} from './remote-adapter.js';
export {
  ElectronBrowserAdapter,
  ElectronCdpSession,
  type ElectronAdapterOptions,
  type ElectronWebContents,
  type ElectronDebugger,
} from './electron-adapter.js';
export { NetworkWatcher, createNetworkWatcher, type NetworkRecord } from './network-watcher.js';

/* -- protocols ------------------------------------------------------------- */
export {
  resolveSelectorSpec,
  describeSelector,
  buildQueryExpression,
  buildQueryAllExpression,
  cssEscape,
  xpathLiteral,
  type ResolvedSelector,
} from './selectors.js';
export {
  getLayoutMetrics,
  getDeviceScaleFactor,
  clientToPage,
  elementPageBox,
  type LayoutMetrics,
  type ViewportRect,
} from './metrics.js';
export {
  startScreencast,
  stopScreencast,
  captureJpegFrame,
  type ScreencastFrame,
  type ScreencastHandle,
  type ScreencastOptions,
} from './screencast.js';
export {
  dispatchMouse,
  dispatchMouseMove,
  dispatchMouseButton,
  dispatchWheel,
  dispatchKey,
  dispatchChar,
  insertText,
  modifierMask,
  keyToCode,
  keyCode,
  MODIFIER_BITS,
  type ModifierName,
  type MouseButton,
  type MouseOptions,
  type KeyOptions,
} from './input.js';

/* -- errors ---------------------------------------------------------------- */
export * from './errors.js';
