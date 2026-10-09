/**
 * Application shell for the RoboBrowser desktop UI (spec 9).
 *
 * Layout mirrors the native `WebContentsView` placement in the main process:
 *   header (56px)
 *   ├── left column (38%)  : React Flow canvas + step config + variables
 *   └── right column (62%) : preview toolbar (40px) + native browser view + log (250px)
 *
 * The native view is painted by Electron *on top of* the renderer, so the
 * `.rb-preview-pane` element must stay exactly aligned with the bounds computed
 * by `layoutBrowserView()` in `main/index.ts`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowModel, RunEvent, RunResult, Step } from '@robrowser/core';
import type { FlowSummary, RunSummary } from '../shared/types';
import { FlowEditor } from './components/FlowEditor';
import { StepConfigPanel } from './components/StepConfigPanel';
import { VariablePanel } from './components/VariablePanel';
import { RunLogPanel } from './components/RunLogPanel';
import { BrowserPreview } from './components/BrowserPreview';
import { ExportDialog } from './components/ExportDialog';
import { blankFlow } from './model';

/** A `manual` step waiting on the operator. */
interface ManualPrompt {
  runId: string;
  stepId: string;
  reason: string;
  message: string;
  timeoutMs: number;
}

/** Which side panel is visible in the left column. */
type LeftTab = 'config' | 'variables';

/** Root component. */
export function App(): React.ReactElement {
  const [flow, setFlow] = useState<FlowModel>(() => blankFlow());
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [failedStepId, setFailedStepId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [browserUrl, setBrowserUrl] = useState('about:blank');
  const [manualPrompt, setManualPrompt] = useState<ManualPrompt | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [tab, setTab] = useState<LeftTab>('config');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [hostReady, setHostReady] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);

  /** Keep a ref to the newest flow so IPC callbacks never read a stale value. */
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const selectedStep: Step | null = useMemo(
    () => flow.steps.find((step) => step.id === selectedStepId) ?? null,
    [flow.steps, selectedStepId],
  );

  const refreshLists = useCallback(async (): Promise<void> => {
    const [flowList, runList] = await Promise.all([
      window.robrowser.listFlows().catch(() => [] as FlowSummary[]),
      window.robrowser.listRuns(30).catch(() => [] as RunSummary[]),
    ]);
    setFlows(flowList);
    setRuns(runList);
  }, []);

  /** Load the most recent stored flow (or keep the scratch flow). */
  useEffect(() => {
    void (async () => {
      await refreshLists();
      const list = await window.robrowser.listFlows().catch(() => [] as FlowSummary[]);
      const first = list[0];
      if (!first) return;
      const stored = await window.robrowser.loadFlow(first.id).catch(() => null);
      if (stored) {
        setFlow(stored);
        setSelectedStepId(stored.steps[0]?.id ?? null);
        setStatus(`已载入「${stored.name}」`);
      }
    })();
  }, [refreshLists]);

  /** Subscribe to the typed main-process events. */
  useEffect(() => {
    const offEvent = window.robrowser.on('run:event', (event) => {
      setEvents((previous) => [...previous, event]);
      const payload = event.payload as unknown as Record<string, unknown>;
      const stepId = typeof payload.stepId === 'string' ? payload.stepId : '';
      if (event.type === 'step:start' && stepId) {
        setActiveStepId(stepId);
        setSelectedStepId(stepId);
      }
      if (event.type === 'step:fail' && stepId) {
        setFailedStepId(stepId);
        setActiveStepId(null);
      }
      if (event.type === 'manual:request' && stepId) {
        setActiveStepId(null);
        setManualPrompt({
          runId: String(payload.runId ?? ''),
          stepId,
          reason: String(payload.reason ?? 'other'),
          message: String(payload.message ?? ''),
          timeoutMs: Number(payload.timeoutMs ?? 600_000),
        });
      }
    });

    const offEnd = window.robrowser.on('run:end', (result) => {
      setRunning(false);
      setActiveStepId(null);
      setLastResult(result);
      setManualPrompt(null);
      if (result.status === 'success')
        setStatus(`运行成功 · ${result.stepCount} 步 · ${result.durationMs}ms`);
      else
        setError(
          result.error ? `${result.error.code}: ${result.error.message}` : `运行${result.status}`,
        );
      void refreshLists();
    });

    const offManual = window.robrowser.on('manual:request', (prompt) => {
      setManualPrompt({ ...prompt, timeoutMs: prompt.timeoutMs ?? 600_000 });
    });

    const offResolved = window.robrowser.on('manual:resolved', (payload) => {
      setManualPrompt(null);
      setManualBusy(false);
      setStatus(
        `人工处理${payload.status === 'resolved' ? '已完成' : `结束（${payload.status}）`}`,
      );
    });

    const offUrl = window.robrowser.on('browser:url', ({ url }) => setBrowserUrl(url));

    // The run controller exists only once the CDP bridge is attached; enabling
    // "运行" earlier yields a confusing "not ready" error.
    const offReady = window.robrowser.on('bootstrap:ready', ({ url }) => {
      setHostReady(true);
      if (url && url !== 'about:blank') setBrowserUrl(url);
    });
    const offBootstrapError = window.robrowser.on('bootstrap:error', ({ message }) => {
      setHostReady(false);
      setHostError(message);
      setError(`自动化宿主初始化失败：${message}`);
    });

    // The event may have fired before React subscribed, so also query once.
    void window.robrowser
      .hostStatus()
      .then((status) => {
        setHostReady(status.ready);
        if (status.error) {
          setHostError(status.error);
          setError(`自动化宿主初始化失败：${status.error}`);
        }
      })
      .catch(() => undefined);

    return () => {
      offEvent();
      offEnd();
      offManual();
      offResolved();
      offUrl();
      offReady();
      offBootstrapError();
    };
  }, [refreshLists]);

  const updateFlow = useCallback((next: FlowModel): void => setFlow(next), []);

  const saveFlow = useCallback(async (): Promise<void> => {
    setError(null);
    const result = await window.robrowser.saveFlow(flowRef.current);
    if (result.ok) {
      setStatus(`已保存「${flowRef.current.name}」`);
      await refreshLists();
    } else {
      setError(result.error ?? '保存失败');
    }
  }, [refreshLists]);

  const loadFlow = useCallback(async (id: string): Promise<void> => {
    const stored = await window.robrowser.loadFlow(id);
    if (!stored) {
      setError(`找不到流程 ${id}`);
      return;
    }
    setFlow(stored);
    setSelectedStepId(stored.steps[0]?.id ?? null);
    setStatus(`已载入「${stored.name}」`);
  }, []);

  const startRun = useCallback(async (): Promise<void> => {
    setError(null);
    setStatus(null);
    setEvents([]);
    setFailedStepId(null);
    setActiveStepId(null);
    setLastResult(null);
    setManualPrompt(null);

    const vars: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(flowRef.current.variables ?? {})) {
      if (def.type !== 'input') continue;
      const entered = inputValues[name];
      if (entered !== undefined && entered !== '') vars[name] = entered;
    }

    const response = await window.robrowser.startRun({ flow: flowRef.current, vars });
    if (!response.ok) {
      setError(response.error ? `${response.error.code}: ${response.error.message}` : '无法启动');
      return;
    }
    setRunning(true);
    setStatus('运行中…');
  }, [inputValues]);

  const stopRun = useCallback(async (): Promise<void> => {
    const result = await window.robrowser.stopRun();
    if (result.ok) setStatus('正在停止…');
  }, []);

  const resolveManual = useCallback(async (): Promise<void> => {
    const prompt = manualPrompt;
    if (!prompt) return;
    setManualBusy(true);
    setError(null);
    try {
      const result = await window.robrowser.resolveManual(prompt.stepId);
      if (result.ok) return; // The run resumes; "manual:resolved" clears the modal.
      setManualBusy(false);
      setError(
        result.reason === 'predicate-pending'
          ? '页面校验尚未通过：请先在内嵌浏览器里完成验证（例如提交正确的验证码），再点击“完成并继续”。'
          : '人工处理通道尚未就绪，请稍后重试。',
      );
    } catch (failure) {
      setManualBusy(false);
      setError(`人工处理失败：${(failure as Error).message}`);
    }
  }, [manualPrompt]);

  /**
   * The native preview view always paints above this DOM, so overlays that do
   * not need the browser hide it while they are open.
   */
  useEffect(() => {
    const overlayOpen = exportOpen || showHistory;
    void window.robrowser.setBrowserViewVisible(!overlayOpen).catch(() => undefined);
  }, [exportOpen, showHistory]);

  const navigate = useCallback((url: string): void => {
    const target = url.trim();
    if (!target) return;
    void window.robrowser.navigate(target).then((result) => {
      if (!result.ok) setError(`无法打开 ${target}`);
    });
  }, []);

  const reload = useCallback((): void => navigate(browserUrl), [browserUrl, navigate]);

  const inputVars = Object.entries(flow.variables ?? {}).filter(([, def]) => def.type === 'input');

  return (
    <div className="rb-app">
      <header className="rb-header">
        <span className="rb-logo">RoboBrowser</span>
        <input
          className="rb-flow-name"
          value={flow.name}
          aria-label="流程名称"
          onChange={(event) => setFlow((current) => ({ ...current, name: event.target.value }))}
        />
        <span className="rb-muted rb-flow-id">{flow.id}</span>
        <span className="rb-grow" />
        {status && <span className="rb-status">{status}</span>}
        <button onClick={() => void saveFlow()}>保存</button>
        <select
          className="rb-flow-picker"
          value=""
          aria-label="打开流程"
          onChange={(event) => void loadFlow(event.target.value)}
        >
          <option value="" disabled>
            打开流程…
          </option>
          {flows.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button onClick={() => setShowHistory((open) => !open)}>历史</button>
        <button onClick={() => setExportOpen(true)}>导出脚本</button>
        <button
          className="rb-primary"
          onClick={() => void startRun()}
          disabled={running || !hostReady}
          title={
            hostReady ? undefined : hostError ? `初始化失败：${hostError}` : '正在初始化内嵌浏览器…'
          }
        >
          {running ? '运行中' : hostReady ? '运行' : '初始化…'}
        </button>
        <button className="rb-danger" onClick={() => void stopRun()} disabled={!running}>
          停止
        </button>
      </header>

      {error && (
        <div className="rb-banner rb-banner-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div className="rb-body">
        <section className="rb-left">
          <FlowEditor
            flow={flow}
            onChange={updateFlow}
            selectedStepId={selectedStepId}
            onSelect={(id) => {
              setSelectedStepId(id);
              if (id) setTab('config');
            }}
          />
          <div className="rb-tabs">
            <button
              className={tab === 'config' ? 'rb-tab-active' : ''}
              onClick={() => setTab('config')}
            >
              步骤配置
            </button>
            <button
              className={tab === 'variables' ? 'rb-tab-active' : ''}
              onClick={() => setTab('variables')}
            >
              变量 ({Object.keys(flow.variables ?? {}).length})
            </button>
          </div>
          <div className="rb-tab-body">
            {tab === 'config' ? (
              <StepConfigPanel flow={flow} step={selectedStep} onChange={updateFlow} />
            ) : (
              <VariablePanel flow={flow} onChange={updateFlow} />
            )}
          </div>
        </section>

        <section className="rb-right">
          <BrowserPreview url={browserUrl} onNavigate={navigate} onReload={reload} />
          <div className="rb-preview-pane">
            <div className="rb-preview-placeholder">
              <span className="rb-muted">Chromium 内嵌视图</span>
            </div>
          </div>
          <RunLogPanel
            events={events}
            running={running}
            activeStepId={activeStepId}
            failedStepId={failedStepId}
            onStop={() => void stopRun()}
            onClear={() => setEvents([])}
          />
        </section>
      </div>

      {showHistory && (
        <div className="rb-drawer">
          <div className="rb-drawer-head">
            <h2>运行历史</h2>
            <button onClick={() => setShowHistory(false)}>关闭</button>
          </div>
          {runs.length === 0 && <p className="rb-muted">还没有运行记录。</p>}
          <ul className="rb-run-list">
            {runs.map((run) => (
              <li key={run.id}>
                <span className={`rb-badge rb-badge-${run.status}`}>{run.status}</span>
                <span className="rb-run-name">{run.flowName}</span>
                <span className="rb-muted">{new Date(run.startedAt).toLocaleString()}</span>
                <span className="rb-muted">{run.stepCount} 步</span>
                <span className="rb-muted">{run.durationMs}ms</span>
                {lastResult?.runId === run.id && <span className="rb-muted">（本会话）</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {manualPrompt && (
        <div className="rb-modal-backdrop rb-manual-backdrop">
          <div className="rb-modal rb-manual">
            <div className="rb-modal-head">
              <h2>需要人工处理</h2>
              <span className="rb-badge rb-badge-running">{manualPrompt.reason}</span>
            </div>
            <p>{manualPrompt.message}</p>
            <p className="rb-muted">
              请直接在右侧内嵌浏览器中完成验证，然后点击“完成并继续”。剩余时间{' '}
              {Math.round(manualPrompt.timeoutMs / 1000)} 秒（超时后流程失败）。
            </p>
            <div className="rb-modal-actions">
              <button
                className="rb-primary"
                onClick={() => void resolveManual()}
                disabled={manualBusy}
              >
                {manualBusy ? '校验中…' : '完成并继续'}
              </button>
              <button className="rb-danger" onClick={() => void stopRun()}>
                中止流程
              </button>
            </div>
          </div>
        </div>
      )}

      {exportOpen && <ExportDialog flow={flow} onClose={() => setExportOpen(false)} />}

      {inputVars.length > 0 && !running && (
        <div className="rb-drawer rb-input-drawer">
          <div className="rb-drawer-head">
            <h2>运行输入</h2>
          </div>
          {inputVars.map(([name, def]) => (
            <label key={name} className="rb-row">
              <span>{def.type === 'input' ? def.label : name}</span>
              <input
                value={inputValues[name] ?? ''}
                placeholder={def.type === 'input' ? (def.default ?? '') : ''}
                onChange={(event) =>
                  setInputValues((current) => ({ ...current, [name]: event.target.value }))
                }
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
