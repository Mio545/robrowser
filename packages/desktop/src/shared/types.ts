/**
 * IPC contract shared by the Electron main process, the preload bridge and the
 * React renderer (spec 9).
 *
 * The renderer never touches Node, CDP or the file system directly: everything
 * goes through the narrow `window.robrowser` API defined here.
 */
import type { FlowModel, RunEvent, RunResult } from '@robrowser/core';

/** A stored flow summary returned to the UI. */
export interface FlowSummary {
  id: string;
  name: string;
  updatedAt: string;
}

/** A run history row returned to the UI. */
export interface RunSummary {
  id: string;
  flowId: string;
  flowName: string;
  status: 'success' | 'failed' | 'aborted';
  reason?: string;
  stepCount: number;
  durationMs: number;
  startedAt: string;
  finishedAt?: string;
  runDir?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Options accepted when starting a run. */
export interface StartRunRequest {
  flow: FlowModel;
  /** `--var` style overrides / input values. */
  vars?: Record<string, unknown>;
}

/** Result of a start request (immediate acknowledgement, not the run result). */
export interface StartRunResponse {
  ok: boolean;
  runId?: string;
  error?: { code: string; message: string };
}

/** Result of an export request. */
export interface ExportResponse {
  ok: boolean;
  script?: string;
  error?: { code: string; message: string };
}

/** Events pushed from main -> renderer. */
export interface MainEvents {
  /** A typed engine event for the active run. */
  'run:event': RunEvent;
  /** Run finished (success or failure). */
  'run:end': RunResult;
  /** A `manual` step is waiting for the local operator. */
  'manual:request': {
    runId: string;
    stepId: string;
    reason: string;
    message: string;
    timeoutMs: number;
  };
  /** Manual step settled (resolved / timeout / aborted). */
  'manual:resolved': { stepId: string; status: string; by?: string };
  /** Browser view navigated (used to show the current URL). */
  'browser:url': { url: string };
  /** Automation host finished wiring CDP + the run controller. */
  'bootstrap:ready': { url: string };
  /** Automation host failed to initialize; runs cannot start. */
  'bootstrap:error': { message: string };
}

/** Automation-host readiness, queryable on renderer start-up. */
export interface HostStatus {
  ready: boolean;
  url: string;
  error?: string;
}

/** Result of asking the host to resume a manual step. */
export type ManualResolveResponse =
  { ok: true } | { ok: false; reason: 'predicate-pending' | 'not-ready' };

/** Minimal API exposed on `window.robrowser` via contextBridge. */
export interface RoboBrowserApi {
  listFlows(): Promise<FlowSummary[]>;
  loadFlow(id: string): Promise<FlowModel | null>;
  saveFlow(flow: FlowModel): Promise<{ ok: boolean; error?: string }>;
  deleteFlow(id: string): Promise<{ ok: boolean }>;
  listRuns(limit?: number): Promise<RunSummary[]>;
  startRun(request: StartRunRequest): Promise<StartRunResponse>;
  stopRun(): Promise<{ ok: boolean }>;
  exportScript(flow: FlowModel, target: 'playwright' | 'raw-cdp'): Promise<ExportResponse>;
  saveScript(defaultName: string, contents: string): Promise<{ ok: boolean; path?: string }>;
  /**
   * Ask the main process to resume a manual step.
   *
   * `ok:false` with `reason:"predicate-pending"` means the flow's `resolveWhen`
   * rule is not satisfied yet; the dialog must stay open.
   */
  resolveManual(stepId: string): Promise<ManualResolveResponse>;
  /** Query whether the CDP bridge + run controller are ready (avoids races). */
  hostStatus(): Promise<HostStatus>;
  /**
   * Show/hide the native preview view.
   *
   * `WebContentsView` is painted above the renderer DOM, so overlays that span
   * the preview area must temporarily hide it.
   */
  setBrowserViewVisible(visible: boolean): Promise<{ ok: boolean }>;
  on<K extends keyof MainEvents>(event: K, listener: (payload: MainEvents[K]) => void): () => void;
}
