/**
 * CDP bridge for the embedded browser view (spec 9).
 *
 * The desktop host owns one `WebContentsView`. This module turns its
 * `webContents.debugger` into a {@link ElectronBrowserAdapter} and exposes the
 * single page the engine drives. Keeping this in one place means the IPC layer
 * never has to know anything about CDP.
 */
import { ElectronBrowserAdapter, type CdpPage, type ElectronWebContents } from '@robrowser/browser';

/** The embedded browser view plus its adapter. */
export interface CdpBridge {
  /** Adapter handed to the orchestrator. */
  adapter: ElectronBrowserAdapter;
  /** The single page inside the view. */
  page: CdpPage;
  /** Current URL of the embedded view. */
  url(): string;
  /** Detach from the debugger and release the adapter. */
  dispose(): Promise<void>;
}

/** Options for {@link createCdpBridge}. */
export interface CdpBridgeOptions {
  /** The `webContents` of the `WebContentsView` hosting the automation target. */
  webContents: ElectronWebContents;
  /** Called when the debugger detaches unexpectedly. */
  onDetach?: (reason: string) => void;
}

/**
 * Attach to the embedded view and initialise the CDP page.
 *
 * @param options - Embedded `webContents` + detach callback.
 */
export async function createCdpBridge(options: CdpBridgeOptions): Promise<CdpBridge> {
  const adapter = new ElectronBrowserAdapter({
    createWebContents: async () => options.webContents,
    ...(options.onDetach ? { onDetach: options.onDetach } : {}),
  });
  await adapter.launch({});
  const page = adapter.embeddedPage;
  if (!page) throw new Error('Electron adapter launched without a page');

  return {
    adapter,
    page,
    url: () => {
      try {
        return options.webContents.getURL();
      } catch {
        return '';
      }
    },
    async dispose(): Promise<void> {
      await adapter.close().catch(() => undefined);
    },
  };
}
