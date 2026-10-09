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
  MainEvents,
  ManualResolveResponse,
  RoboBrowserApi,
  RunSummary,
  StartRunRequest,
  StartRunResponse,
} from '../shared/types.js';
import type { FlowModel } from '@robrowser/core';

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
  resolveManual: 'manual:resolve',
  hostStatus: 'host:status',
  setBrowserViewVisible: 'browser:view-visible',
  navigate: 'browser:navigate',
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
  resolveManual: (stepId) =>
    ipcRenderer.invoke(CHANNELS.resolveManual, stepId) as Promise<ManualResolveResponse>,
  navigate: (url) => ipcRenderer.invoke(CHANNELS.navigate, url) as Promise<{ ok: boolean }>,
  hostStatus: () => ipcRenderer.invoke(CHANNELS.hostStatus) as Promise<HostStatus>,
  setBrowserViewVisible: (visible) =>
    ipcRenderer.invoke(CHANNELS.setBrowserViewVisible, visible) as Promise<{ ok: boolean }>,
  on: <K extends keyof MainEvents>(event: K, listener: (payload: MainEvents[K]) => void) => {
    const handler = (_ipcEvent: unknown, payload: MainEvents[K]): void => listener(payload);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.off(event, handler);
  },
};

contextBridge.exposeInMainWorld('robrowser', api);
