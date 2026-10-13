/**
 * Preload bridge (spec 9).
 *
 * Exposes exactly the operations the renderer needs. There is deliberately no
 * generic `invoke(channel, …)` escape hatch: the renderer cannot reach arbitrary
 * IPC channels, Node APIs or CDP.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  ExportResponse,
  FlowSummary,
  HostStatus,
  ImportResponse,
  MainEvents,
  ManualResolveResponse,
  OpenPathResult,
  RoboBrowserApi,
  RunSummary,
  StartRunRequest,
  StartRunResponse,
} from '../shared/types.js';
import type { CredentialInput, CredentialSummary, FlowModel } from '@robrowser/core';

/** Channel names, kept in one place so main/preload cannot drift apart. */
const CHANNELS = {
  listFlows: 'flows:list',
  loadFlow: 'flows:load',
  saveFlow: 'flows:save',
  deleteFlow: 'flows:delete',
  listRuns: 'runs:list',
  startRun: 'runs:start',
  stopRun: 'runs:stop',
  exportScript: 'export:script',
  saveScript: 'export:save',
  importScript: 'import:script',
  openScript: 'import:open',
  resolveManual: 'manual:resolve',
  hostStatus: 'host:status',
  setBrowserViewVisible: 'browser:view-visible',
  setBrowserBounds: 'browser:set-bounds',
  openPath: 'system:open-path',
  navigate: 'browser:navigate',
  listCredentials: 'credentials:list',
  saveCredential: 'credentials:save',
  deleteCredential: 'credentials:delete',
  credentialsAvailable: 'credentials:available',
} as const;

const api: RoboBrowserApi & { navigate(url: string): Promise<{ ok: boolean }> } = {
  listFlows: () => ipcRenderer.invoke(CHANNELS.listFlows) as Promise<FlowSummary[]>,
  loadFlow: (id) => ipcRenderer.invoke(CHANNELS.loadFlow, id) as Promise<FlowModel | null>,
  saveFlow: (flow) =>
    ipcRenderer.invoke(CHANNELS.saveFlow, flow) as Promise<{ ok: boolean; error?: string }>,
  deleteFlow: (id) => ipcRenderer.invoke(CHANNELS.deleteFlow, id) as Promise<{ ok: boolean }>,
  listRuns: (limit) => ipcRenderer.invoke(CHANNELS.listRuns, limit) as Promise<RunSummary[]>,
  startRun: (request: StartRunRequest) =>
    ipcRenderer.invoke(CHANNELS.startRun, request) as Promise<StartRunResponse>,
  stopRun: () => ipcRenderer.invoke(CHANNELS.stopRun) as Promise<{ ok: boolean }>,
  exportScript: (flow, target) =>
    ipcRenderer.invoke(CHANNELS.exportScript, flow, target) as Promise<ExportResponse>,
  saveScript: (defaultName, contents) =>
    ipcRenderer.invoke(CHANNELS.saveScript, defaultName, contents) as Promise<{
      ok: boolean;
      path?: string;
    }>,
  importScript: (source, target) =>
    ipcRenderer.invoke(CHANNELS.importScript, source, target) as Promise<ImportResponse>,
  openScript: () => ipcRenderer.invoke(CHANNELS.openScript) as Promise<ImportResponse>,
  resolveManual: (stepId) =>
    ipcRenderer.invoke(CHANNELS.resolveManual, stepId) as Promise<ManualResolveResponse>,
  navigate: (url) => ipcRenderer.invoke(CHANNELS.navigate, url) as Promise<{ ok: boolean }>,
  hostStatus: () => ipcRenderer.invoke(CHANNELS.hostStatus) as Promise<HostStatus>,
  setBrowserViewVisible: (visible) =>
    ipcRenderer.invoke(CHANNELS.setBrowserViewVisible, visible) as Promise<{ ok: boolean }>,
  setBrowserBounds: (bounds) =>
    ipcRenderer.invoke(CHANNELS.setBrowserBounds, bounds) as Promise<{ ok: boolean }>,
  openPath: (targetPath, mode) =>
    ipcRenderer.invoke(CHANNELS.openPath, targetPath, mode) as Promise<OpenPathResult>,
  listCredentials: () =>
    ipcRenderer.invoke(CHANNELS.listCredentials) as Promise<CredentialSummary[]>,
  saveCredential: (input: CredentialInput) =>
    ipcRenderer.invoke(CHANNELS.saveCredential, input) as Promise<{ ok: boolean; error?: string }>,
  deleteCredential: (key) =>
    ipcRenderer.invoke(CHANNELS.deleteCredential, key) as Promise<{ ok: boolean }>,
  credentialsAvailable: () =>
    ipcRenderer.invoke(CHANNELS.credentialsAvailable) as Promise<{
      available: boolean;
      reason?: string;
    }>,
  on: <K extends keyof MainEvents>(event: K, listener: (payload: MainEvents[K]) => void) => {
    const handler = (_ipcEvent: unknown, payload: MainEvents[K]): void => listener(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.off(event, handler);
  },
};

contextBridge.exposeInMainWorld('robrowser', api);
