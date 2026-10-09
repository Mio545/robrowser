/**
 * Electron main process (spec 9).
 *
 * Layout
 *   BrowserWindow (renderer = React UI)
 *     └── WebContentsView (embedded Chromium the automation drives)
 *
 * The main process owns everything privileged: the SQLite store, the CDP bridge
 * into the WebContentsView, the run controller, the local manual handler and the
 * script exporter. The renderer only speaks the narrow IPC contract defined in
 * `shared/types.ts`.
 *
 * `WebContentsView` is used instead of the deprecated `<webview>` tag (spec 2).
 */
import { app, BrowserWindow, dialog, ipcMain, WebContentsView, shell } from 'electron';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pino } from 'pino';
import { assertValidFlow, exportFlow, type FlowModel } from '@robrowser/core';
import { DesktopStorage } from './storage.js';
import { createCdpBridge, type CdpBridge } from './cdp-bridge.js';
import { LocalManualHandler } from './manual-handler.js';
import { RunController } from './run-controller.js';
import type { MainEvents, StartRunRequest, StartRunResponse } from '../shared/types.js';

const isDev = !app.isPackaged;
const logger = pino({
  level: process.env.ROBO_LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  base: { scope: 'desktop' },
});

/** Layout constants shared with the renderer CSS (keep both in sync). */
const HEADER_HEIGHT = 56;
const PREVIEW_BAR_HEIGHT = 40;
const LOG_PANEL_HEIGHT = 250;
const VIEW_INSET = 8;
const LEFT_COLUMN_RATIO = 0.38;

let mainWindow: BrowserWindow | undefined;
let browserView: WebContentsView | undefined;
let bridge: CdpBridge | undefined;
let storage: DesktopStorage | undefined;
let controller: RunController | undefined;
let manual: LocalManualHandler | undefined;
/** Automation-host readiness, reported to the renderer on demand. */
let bootstrapState: { ready: boolean; url: string; error?: string } = {
  ready: false,
  url: 'about:blank',
};

/** Send a typed message to the renderer when the window is still alive. */
function emit<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Create the React UI window plus the embedded browser view. */
async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b1220',
    title: 'RoboBrowser',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  browserView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.contentView.addChildView(browserView);
  layoutBrowserView();

  mainWindow.on('resize', layoutBrowserView);
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });

  browserView.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  browserView.webContents.on('did-navigate', (_event, url) => emit('browser:url', { url }));
  browserView.webContents.on('did-navigate-in-page', (_event, url) => emit('browser:url', { url }));

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** Keep the embedded view anchored to the right-hand preview pane. */
function layoutBrowserView(): void {
  if (!mainWindow || !browserView) return;
  const size = mainWindow.getContentSize();
  const width = size[0] ?? 1500;
  const height = size[1] ?? 950;

  // The renderer reserves exactly this rectangle for the native view; keep the
  // constants in sync with `renderer/styles.css` (.rb-preview-pane).
  const leftColumn = Math.round(width * LEFT_COLUMN_RATIO);
  const top = HEADER_HEIGHT + PREVIEW_BAR_HEIGHT;
  const viewWidth = Math.max(320, width - leftColumn - VIEW_INSET * 2);
  const viewHeight = Math.max(240, height - top - LOG_PANEL_HEIGHT - VIEW_INSET * 2);

  browserView.setBounds({
    x: leftColumn + VIEW_INSET,
    y: top + VIEW_INSET,
    width: viewWidth,
    height: viewHeight,
  });
}

/** Build the CDP bridge + run controller once the window exists. */
async function bootstrapAutomation(): Promise<void> {
  if (!app.isReady() || !browserView || !mainWindow) return;
  const userData = app.getPath('userData');
  storage ??= new DesktopStorage(userData);

  // The view must host a live renderer before CDP is attached: on a brand-new
  // WebContentsView, `Page.enable` never resolves because there is no renderer
  // process yet. Navigating to about:blank first creates it.
  await browserView.webContents.loadURL('about:blank').catch(() => undefined);

  bridge = await createCdpBridge({
    webContents: browserView.webContents,
    onDetach: (reason) => logger.warn({ reason }, 'embedded debugger detached'),
  });

  manual = new LocalManualHandler({
    notify: (request) =>
      emit('manual:request', {
        runId: request.runId,
        stepId: request.stepId,
        reason: request.reason,
        message: request.message,
        timeoutMs: request.timeoutMs,
      }),
    settled: (request, result) =>
      emit('manual:resolved', {
        stepId: request.stepId,
        status: result.status,
        ...(result.by ? { by: result.by } : {}),
      }),
  });

  controller = new RunController({
    logger,
    page: bridge.page,
    runDir: join(userData, 'runs'),
    manual,
  });
  controller.on('event', (event) => emit('run:event', event));
  controller.on('end', (result) => {
    storage?.saveRun(result, join(userData, 'runs', result.runId));
    emit('run:end', result);
  });

  bootstrapState = { ready: true, url: browserView.webContents.getURL() };
  emit('bootstrap:ready', { url: bootstrapState.url });
}

/* ----------------------------------------------------------------- IPC surface */

function registerIpc(): void {
  ipcMain.handle('host:status', () => bootstrapState);

  ipcMain.handle('flows:list', () => storage?.listFlows() ?? []);

  ipcMain.handle('flows:load', (_event, id: string) => storage?.loadFlow(id) ?? null);

  ipcMain.handle('flows:save', (_event, flow: FlowModel) => {
    if (!storage) return { ok: false, error: 'storage is not ready' };
    try {
      const validated = assertValidFlow(flow);
      storage.saveFlow(validated);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('flows:delete', (_event, id: string) => {
    if (!storage) return { ok: false, error: 'storage is not ready' };
    storage.deleteFlow(id);
    return { ok: true };
  });

  ipcMain.handle('runs:list', (_event, limit?: number) => storage?.listRuns(limit ?? 50) ?? []);

  ipcMain.handle(
    'runs:start',
    async (_event, request: StartRunRequest): Promise<StartRunResponse> => {
      if (!controller)
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'not ready' } };
      if (controller.busy) {
        return {
          ok: false,
          error: { code: 'STEP_FAILED', message: 'A run is already in progress' },
        };
      }
      try {
        const flow = assertValidFlow(request.flow);
        const pending = controller.run(flow, request.vars ?? {});
        // Acknowledge immediately; progress arrives through the event channel.
        void pending.catch((error: unknown) => {
          logger.error({ err: String(error) }, 'desktop run failed');
        });
        return { ok: true, runId: `${flow.id}-pending` };
      } catch (error) {
        return {
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: (error as Error).message },
        };
      }
    },
  );

  ipcMain.handle('runs:stop', () => ({ ok: controller?.stop() ?? false }));

  ipcMain.handle('export:script', (_event, flow: FlowModel, target: 'playwright' | 'raw-cdp') => {
    try {
      const validated = assertValidFlow(flow);
      // The desktop has no flow file on disk, so relative URLs resolve against
      // the process working directory (the repository root in development).
      const options = {
        playwright: { flowDir: process.cwd() },
        'raw-cdp': { flowDir: process.cwd() },
      };
      return { ok: true, script: exportFlow(validated, target, options) };
    } catch (error) {
      return { ok: false, error: { code: 'EXPORT_ERROR', message: (error as Error).message } };
    }
  });

  ipcMain.handle('export:save', async (_event, defaultName: string, contents: string) => {
    const result = await dialog.showSaveDialog({
      defaultPath: defaultName,
      filters: [{ name: 'Script', extensions: ['js', 'mjs', 'cjs'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    await mkdir(join(result.filePath, '..'), { recursive: true }).catch(() => undefined);
    await writeFile(result.filePath, contents, 'utf8');
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('manual:resolve', async (_event, stepId: string) => {
    if (!manual) return { ok: false, reason: 'not-ready' as const };
    const settled = await manual.resolve(stepId, 'desktop');
    return settled ? { ok: true } : { ok: false, reason: 'predicate-pending' as const };
  });

  ipcMain.handle('browser:view-visible', (_event, visible: boolean) => {
    if (!browserView) return { ok: false };
    browserView.setVisible(visible !== false);
    return { ok: true };
  });

  ipcMain.handle('browser:navigate', async (_event, url: string) => {
    if (!browserView) return { ok: false };
    await browserView.webContents.loadURL(url);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ lifecycle */

void app
  .whenReady()
  .then(async () => {
    // The store must exist before any IPC handler can be invoked by the renderer.
    storage = new DesktopStorage(app.getPath('userData'));
    registerIpc();
    await createWindow();
    await bootstrapAutomation();
  })
  .catch((error: unknown) => {
    // Without this handler a failed CDP attach would leave the UI alive but
    // with no run controller, so every "run" answered a confusing
    // "not ready" instead of surfacing the real cause.
    logger.error({ err: String(error) }, 'desktop bootstrap failed');
    bootstrapState = { ready: false, url: 'about:blank', error: (error as Error).message };
    emit('bootstrap:error', { message: bootstrapState.error ?? 'unknown error' });
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  controller?.stop();
  void bridge?.dispose();
  storage?.close();
});
