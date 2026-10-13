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
import { CredentialPanel } from './components/CredentialPanel';
import { RunLogPanel } from './components/RunLogPanel';
import { BrowserPreview } from './components/BrowserPreview';
import { ExportDialog } from './components/ExportDialog';
import { ImportDialog } from './components/ImportDialog';
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
type LeftTab = 'config' | 'variables' | 'credentials';

/** Root component. */
export function App(): React.ReactElement {
  const [flow, setFlow] = useState<FlowModel>(() => blankFlow());
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
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
  const [importOpen, setImportOpen] = useState(false);
  const [tab, setTab] = useState<LeftTab>('config');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [hostReady, setHostReady] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);

  /** Serialized flow at the last save/load; differing canvas means unsaved edits. */
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  /** Panel sizes in px (leftWidth 0 = follow the CSS default of 38%). */
  const [layout, setLayout] = useState(() => ({
    leftWidth: Number(localStorage.getItem('rb.layout.left')) || 0,
    logHeight: Number(localStorage.getItem('rb.layout.log')) || 250,
    editorHeight: Number(localStorage.getItem('rb.layout.editor')) || 300,
  }));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const previewPaneRef = useRef<HTMLDivElement>(null);

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
        setSavedSnapshot(JSON.stringify(stored));
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

  const isDirty = JSON.stringify(flow) !== savedSnapshot;

  /** Ask before throwing away unsaved canvas edits. */
  const confirmDiscard = useCallback((): boolean => {
    if (JSON.stringify(flowRef.current) === savedSnapshot) return true;
    return window.confirm('当前流程有未保存的修改，放弃这些修改并继续吗？');
  }, [savedSnapshot]);

  const newFlow = useCallback((): void => {
    if (!confirmDiscard()) return;
    const blank = blankFlow();
    setFlow(blank);
    setSelectedStepId(blank.steps[0]?.id ?? null);
    setEvents([]);
    setLastResult(null);
    setFailedStepId(null);
    setActiveStepId(null);
    setStatus('新流程已创建——搭好后记得点「保存」');
  }, [confirmDiscard]);

  const saveFlow = useCallback(async (): Promise<void> => {
    setError(null);
    const result = await window.robrowser.saveFlow(flowRef.current);
    if (result.ok) {
      setSavedSnapshot(JSON.stringify(flowRef.current));
      setStatus(`已保存「${flowRef.current.name}」`);
      await refreshLists();
    } else {
      setError(result.error ?? '保存失败');
    }
  }, [refreshLists]);

  const loadFlow = useCallback(
    async (id: string): Promise<void> => {
      if (!confirmDiscard()) return;
      const stored = await window.robrowser.loadFlow(id);
      if (!stored) {
        setError(`找不到流程 ${id}`);
        return;
      }
      setFlow(stored);
      setSelectedStepId(stored.steps[0]?.id ?? null);
      setSavedSnapshot(JSON.stringify(stored));
      setStatus(`已载入「${stored.name}」`);
    },
    [confirmDiscard],
  );

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
    const overlayOpen = exportOpen || importOpen || showHistory || pickerOpen;
    void window.robrowser.setBrowserViewVisible(!overlayOpen).catch(() => undefined);
  }, [exportOpen, importOpen, showHistory, pickerOpen]);

  const navigate = useCallback((url: string): void => {
    const target = url.trim();
    if (!target) return;
    void window.robrowser.navigate(target).then((result) => {
      if (!result.ok) setError(`无法打开 ${target}`);
    });
  }, []);

  const reload = useCallback((): void => navigate(browserUrl), [browserUrl, navigate]);

  /* ------------------------------------------------------------- panel drag */

  const startLeftDrag = useCallback((event: React.MouseEvent): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth =
      layoutRef.current.leftWidth ||
      document.querySelector<HTMLElement>('.rb-left')?.getBoundingClientRect().width ||
      400;
    const bodyWidth =
      document.querySelector<HTMLElement>('.rb-body')?.clientWidth ?? window.innerWidth;
    const onMove = (move: MouseEvent): void => {
      const width = Math.round(
        Math.min(Math.max(startWidth + (move.clientX - startX), 280), bodyWidth - 420),
      );
      setLayout((current) => ({ ...current, leftWidth: width }));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      if (layoutRef.current.leftWidth) {
        localStorage.setItem('rb.layout.left', String(layoutRef.current.leftWidth));
      }
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const startLogDrag = useCallback((event: React.MouseEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = layoutRef.current.logHeight;
    const maxHeight = Math.max(140, window.innerHeight - 420);
    const onMove = (move: MouseEvent): void => {
      const height = Math.round(
        Math.min(Math.max(startHeight - (move.clientY - startY), 120), maxHeight),
      );
      setLayout((current) => ({ ...current, logHeight: height }));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      localStorage.setItem('rb.layout.log', String(layoutRef.current.logHeight));
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const startEditorDrag = useCallback((event: React.MouseEvent): void => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = layoutRef.current.editorHeight;
    const maxHeight = Math.max(220, window.innerHeight - 360);
    const onMove = (move: MouseEvent): void => {
      const height = Math.round(
        Math.min(Math.max(startHeight + (move.clientY - startY), 160), maxHeight),
      );
      setLayout((current) => ({ ...current, editorHeight: height }));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      localStorage.setItem('rb.layout.editor', String(layoutRef.current.editorHeight));
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  /**
   * The renderer is the layout source of truth for the native view: measure
   * `.rb-preview-pane` and report the rectangle whenever it changes (window
   * resize, panel drags). The main process only applies what it receives.
   */
  useEffect(() => {
    const pane = previewPaneRef.current;
    if (!pane) return;
    const report = (): void => {
      const rect = pane.getBoundingClientRect();
      void window.robrowser
        .setBrowserBounds({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })
        .catch(() => undefined);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(pane);
    window.addEventListener('resize', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, []);

  /** Close the flow picker on outside click or Escape. */
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  /** Panel sizes as CSS variables; unset left width falls back to 38%. */
  const layoutStyle = {
    ...(layout.leftWidth ? { '--left-ratio': `${layout.leftWidth}px` } : {}),
    '--log-panel-height': `${layout.logHeight}px`,
    '--editor-height': `${layout.editorHeight}px`,
  } as React.CSSProperties;

  const inputVars = Object.entries(flow.variables ?? {}).filter(([, def]) => def.type === 'input');

  return (
    <div className="rb-app" style={layoutStyle}>
      <header className="rb-header">
        <span className="rb-logo">RoboBrowser</span>
        <input
          className="rb-flow-name"
          value={flow.name}
          aria-label="流程名称"
          onChange={(event) => setFlow((current) => ({ ...current, name: event.target.value }))}
        />
        {isDirty && (
          <span className="rb-dirty" title="有未保存的修改">
            ●
          </span>
        )}
        <span className="rb-muted rb-flow-id">{flow.id}</span>
        <span className="rb-grow" />
        {status && <span className="rb-status">{status}</span>}
        <button onClick={newFlow}>新建</button>
        <button onClick={() => void saveFlow()}>保存</button>
        <div className="rb-flow-picker" ref={pickerRef}>
          <button
            type="button"
            className={`rb-picker-trigger${pickerOpen ? ' rb-open' : ''}`}
            aria-label="打开流程"
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <span>打开流程…</span>
            <svg className="rb-picker-arrow" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {pickerOpen && (
            <div className="rb-picker-menu" role="listbox" aria-label="流程列表">
              {flows.length === 0 && <p className="rb-picker-empty">还没有保存过的流程</p>}
              {flows.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.id === flow.id}
                  className={`rb-picker-item${item.id === flow.id ? ' rb-current' : ''}`}
                  title={item.name}
                  onClick={() => {
                    setPickerOpen(false);
                    if (item.id !== flow.id) void loadFlow(item.id);
                  }}
                >
                  <span className="rb-picker-check" aria-hidden="true">
                    {item.id === flow.id ? '✓' : ''}
                  </span>
                  <span className="rb-picker-name">{item.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setShowHistory((open) => !open)}>历史</button>
        <button onClick={() => setExportOpen(true)}>导出脚本</button>
        <button onClick={() => setImportOpen(true)}>导入脚本</button>
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
          <div
            className="rb-divider rb-divider-editor"
            title="拖动调节画布高度"
            onMouseDown={startEditorDrag}
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
            <button
              className={tab === 'credentials' ? 'rb-tab-active' : ''}
              onClick={() => setTab('credentials')}
            >
              凭据
            </button>
          </div>
          <div className="rb-tab-body">
            {tab === 'config' && (
              <StepConfigPanel flow={flow} step={selectedStep} onChange={updateFlow} />
            )}
            {tab === 'variables' && <VariablePanel flow={flow} onChange={updateFlow} />}
            {/* Credentials are host-global (keychain), never part of the flow. */}
            {tab === 'credentials' && <CredentialPanel />}
          </div>
        </section>

        <div
          className="rb-divider rb-divider-left"
          title="拖动调节左右分栏"
          onMouseDown={startLeftDrag}
        />

        <section className="rb-right">
          <BrowserPreview url={browserUrl} onNavigate={navigate} onReload={reload} />
          <div className="rb-preview-pane" ref={previewPaneRef}>
            <div className="rb-preview-placeholder">
              <span className="rb-muted">Chromium 内嵌视图</span>
            </div>
          </div>
          <div
            className="rb-divider rb-divider-log"
            title="拖动调节日志高度"
            onMouseDown={startLogDrag}
          />
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
          <table className="rb-run-table">
            <thead>
              <tr>
                <th>状态</th>
                <th>流程</th>
                <th>开始时间</th>
                <th>步数</th>
                <th>耗时</th>
                <th>产物</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <span className={`rb-badge rb-badge-${run.status}`}>
                      {run.status === 'success' ? '成功' : run.status === 'failed' ? '失败' : '中止'}
                    </span>
                  </td>
                  <td className="rb-run-name" title={run.flowName}>
                    {run.flowName}
                    {lastResult?.runId === run.id && (
                      <span className="rb-muted">（本会话）</span>
                    )}
                  </td>
                  <td className="rb-muted">{new Date(run.startedAt).toLocaleString()}</td>
                  <td>{run.stepCount}</td>
                  <td>{run.durationMs}ms</td>
                  <td>
                    {run.runDir ? (
                      <button
                        title={run.runDir}
                        onClick={() => void window.robrowser.openPath(run.runDir!, 'reveal')}
                      >
                        打开产物
                      </button>
                    ) : (
                      <span className="rb-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

      {importOpen && (
        <ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={(imported, summary) => {
            setFlow(imported);
            setSelectedStepId(imported.steps[0]?.id ?? null);
            setImportOpen(false);
            setError(null);
            setStatus(summary);
          }}
        />
      )}

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
