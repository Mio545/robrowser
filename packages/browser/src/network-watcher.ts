/**
 * Network observation for the browser package.
 *
 * The implementation lives in `@robrowser/core` (it has no host dependency) so
 * that the engine and the adapters share one code path. This module re-exports
 * it and narrows the constructor argument to the browser package's
 * {@link CDPSession}, which is structurally compatible with the core's
 * `CDPSessionLike` port.
 */
import type { CDPSession } from './cdp-session.js';
import { NetworkWatcher as CoreNetworkWatcher, type NetworkRecord } from '@robrowser/core';

/** Constructor argument accepted by {@link NetworkWatcher}. */
export type NetworkSession = CDPSession;

export { CoreNetworkWatcher as NetworkWatcher };
export type { NetworkRecord };

/** Narrowing helper: build a watcher from a browser {@link CDPSession}. */
export function createNetworkWatcher(
  session: CDPSession,
  options?: { maxRecords?: number },
): CoreNetworkWatcher {
  return new CoreNetworkWatcher(session, options);
}
