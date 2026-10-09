import React, { useEffect, useRef, useState } from 'react';
import type { RunEvent } from '@robrowser/core';

/** One log row shown in the panel. */
interface LogRow {
  key: number;
  kind: 'start' | 'ok' | 'fail' | 'skip' | 'log' | 'status' | 'manual';
  stepId: string;
  text: string;
  detail?: string;
  screenshot?: string;
  timestamp: number;
}

/** Props for {@link RunLogPanel}. */
export interface RunLogPanelProps {
  events: RunEvent[];
  running: boolean;
  activeStepId: string | null;
  failedStepId: string | null;
  onStop(): void;
  onClear(): void;
}

/**
 * Real-time event log (spec 9).
 *
 * - Every engine event is folded into a compact row.
 * - The failing step is highlighted in red and the active step in blue.
 * - Screenshots render as a base64 thumbnail straight from the event payload.
 */
export function RunLogPanel({
  events,
  running,
  activeStepId,
  failedStepId,
  onStop,
  onClear,
}: RunLogPanelProps): React.ReactElement {
  const scroller = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const rows: LogRow[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const payload = event.payload as unknown as Record<string, unknown>;
    const stepId = typeof payload.stepId === 'string' ? payload.stepId : '';
    switch (event.type) {
      case 'step:start':
        rows.push({
          key: index,
          kind: 'start',
          stepId,
          text: `▶ ${String(payload.summary ?? stepId)}`,
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'step:ok':
        rows.push({
          key: index,
          kind: 'ok',
          stepId,
          text: `✔ ${stepId} (${String(payload.durationMs ?? 0)}ms)`,
          ...(payload.output !== undefined ? { detail: JSON.stringify(payload.output) } : {}),
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'step:fail':
        rows.push({
          key: index,
          kind: 'fail',
          stepId,
          text: `✘ ${stepId} — ${String(payload.code ?? 'STEP_FAILED')}: ${String(payload.message ?? '')}`,
          ...(payload.willRetry
            ? { detail: `将重试（第 ${String(payload.attempt ?? 1)} 次）` }
            : {}),
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'step:skip':
        rows.push({
          key: index,
          kind: 'skip',
          stepId,
          text: `↷ ${stepId}: ${String(payload.reason ?? '')}`,
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'log':
        rows.push({
          key: index,
          kind: 'log',
          stepId,
          text: `· [${String(payload.level ?? 'info')}] ${String(payload.message ?? '')}`,
          ...(payload.data !== undefined ? { detail: JSON.stringify(payload.data) } : {}),
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'screenshot':
        rows.push({
          key: index,
          kind: 'ok',
          stepId,
          text: `🖼 截图 ${String(payload.path ?? '')}`,
          ...(typeof payload.base64 === 'string'
            ? { screenshot: `data:image/png;base64,${payload.base64}` }
            : {}),
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'manual:request':
        rows.push({
          key: index,
          kind: 'manual',
          stepId,
          text: `⏸ 需要人工处理：${String(payload.message ?? '')}`,
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'manual:resolved':
        rows.push({
          key: index,
          kind: 'manual',
          stepId,
          text: `▶ 人工处理${String(payload.status ?? '')}`,
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      case 'run:end':
      case 'run:aborted':
        rows.push({
          key: index,
          kind: 'status',
          stepId: '',
          text: `■ 运行结束：${String(payload.status ?? '')} (${String(payload.durationMs ?? 0)}ms)`,
          timestamp: Number(payload.timestamp ?? 0),
        });
        break;
      default:
        break;
    }
  }

  useEffect(() => {
    if (!autoScroll) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events, autoScroll]);

  return (
    <section className="rb-log">
      <div className="rb-log-head">
        <h2>运行日志</h2>
        {running && <span className="rb-badge rb-badge-running">运行中</span>}
        <span className="rb-grow" />
        <label className="rb-check">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(event) => setAutoScroll(event.target.checked)}
          />
          自动滚动
        </label>
        <button onClick={onClear} disabled={running}>
          清空
        </button>
        <button className="rb-danger" onClick={onStop} disabled={!running}>
          停止
        </button>
      </div>
      <div className="rb-log-body" ref={scroller}>
        {rows.length === 0 && <p className="rb-muted">尚无事件。点击“运行”开始。</p>}
        {rows.map((row) => (
          <div
            key={row.key}
            className={[
              'rb-log-row',
              `rb-log-${row.kind}`,
              row.stepId && row.stepId === activeStepId ? 'rb-active' : '',
              row.stepId && row.stepId === failedStepId ? 'rb-failed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="rb-log-text">{row.text}</span>
            {row.detail && <span className="rb-log-detail">{row.detail}</span>}
            {row.screenshot && <img className="rb-thumb" src={row.screenshot} alt="screenshot" />}
          </div>
        ))}
      </div>
    </section>
  );
}
