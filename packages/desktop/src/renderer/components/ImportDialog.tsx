import React, { useState } from 'react';
import type { FlowModel, ImportWarning, Step } from '@robrowser/core';

/** Props for {@link ImportDialog}. */
export interface ImportDialogProps {
  onClose(): void;
  /** Called with the recovered flow when the user accepts the result. */
  onImported(flow: FlowModel, summary: string): void;
}

/** What the dialog managed to recover so far. */
interface Draft {
  flow: FlowModel;
  warnings: ImportWarning[];
  target: string;
  generated: boolean;
  path?: string;
}

/** Count steps, including the ones nested in `branch` / `loop`. */
function countSteps(steps: readonly Step[]): number {
  let total = 0;
  for (const step of steps) {
    total += 1;
    if (step.type === 'branch') {
      total += countSteps(step.then);
      if (step.else) total += countSteps(step.else);
    } else if (step.type === 'loop') {
      total += countSteps(step.steps);
    }
  }
  return total;
}

/**
 * Script import dialog (the counterpart of {@link ExportDialog}).
 *
 * The parsing itself happens in the main process, using the same importer the
 * CLI uses. Constructs that cannot be mapped onto a step are listed here rather
 * than dropped silently.
 */
export function ImportDialog({ onClose, onImported }: ImportDialogProps): React.ReactElement {
  const [target, setTarget] = useState<'auto' | 'playwright' | 'raw-cdp'>('auto');
  const [source, setSource] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** `undefined` means "let the main process sniff the flavour". */
  const requestedTarget = target === 'auto' ? undefined : target;

  const reset = (): void => {
    setDraft(null);
    setStatus(null);
    setError(null);
  };

  const parse = async (): Promise<void> => {
    if (source.trim() === '') {
      setError('请先粘贴脚本内容，或点击“打开文件…”。');
      return;
    }
    setBusy(true);
    reset();
    try {
      const result = await window.robrowser.importScript(source, requestedTarget);
      setBusy(false);
      if (!result.ok || !result.flow) {
        setError(`解析失败：${result.error?.message ?? '未知错误'}`);
        return;
      }
      setDraft({
        flow: result.flow,
        warnings: result.warnings ?? [],
        target: result.target ?? 'playwright',
        generated: result.generated === true,
      });
      setStatus(`已解析 ${countSteps(result.flow.steps)} 个步骤`);
    } catch (failure) {
      setBusy(false);
      setError(`解析失败：${(failure as Error).message}`);
    }
  };

  const openFile = async (): Promise<void> => {
    setBusy(true);
    reset();
    try {
      const result = await window.robrowser.openScript();
      setBusy(false);
      if (!result.ok || !result.flow) {
        if (result.error?.code !== 'CANCELLED') {
          setError(`解析失败：${result.error?.message ?? '未知错误'}`);
        }
        return;
      }
      setDraft({
        flow: result.flow,
        warnings: result.warnings ?? [],
        target: result.target ?? 'playwright',
        generated: result.generated === true,
        ...(result.path ? { path: result.path } : {}),
      });
      setStatus(`已解析 ${countSteps(result.flow.steps)} 个步骤`);
    } catch (failure) {
      setBusy(false);
      setError(`解析失败：${(failure as Error).message}`);
    }
  };

  const accept = (): void => {
    if (!draft) return;
    const warns = draft.warnings.length;
    onImported(
      draft.flow,
      `已导入「${draft.flow.name}」· ${countSteps(draft.flow.steps)} 步${warns > 0 ? ` · ${warns} 条提示` : ''}`,
    );
  };

  return (
    <div className="rb-modal-backdrop" onClick={onClose}>
      <div className="rb-modal" onClick={(event) => event.stopPropagation()}>
        <div className="rb-modal-head">
          <h2>导入脚本</h2>
          <select
            value={target}
            aria-label="脚本类型"
            onChange={(event) => setTarget(event.target.value as 'auto')}
          >
            <option value="auto">自动识别</option>
            <option value="playwright">Playwright</option>
            <option value="raw-cdp">原生 CDP</option>
          </select>
          <span className="rb-grow" />
          <button onClick={() => void openFile()} disabled={busy}>
            打开文件…
          </button>
          <button onClick={() => void parse()} disabled={busy} className="rb-primary">
            {busy ? '解析中…' : '解析'}
          </button>
          <button onClick={onClose}>关闭</button>
        </div>

        {status && <p className="rb-muted">{status}</p>}
        {error && <p className="rb-muted">{error}</p>}

        <textarea
          className="rb-code"
          value={source}
          spellCheck={false}
          placeholder="粘贴 Playwright 或原生 CDP 脚本，然后点击“解析”；也可以直接“打开文件…”。"
          onChange={(event) => setSource(event.target.value)}
        />

        {draft && (
          <div className="rb-import-result">
            <p>
              识别为 <strong>{draft.target === 'playwright' ? 'Playwright' : '原生 CDP'}</strong>
              {draft.generated ? '（RoboBrowser 导出的脚本）' : '（手写脚本）'}
              {draft.path ? ` · ${draft.path}` : ''}
            </p>
            <p className="rb-muted">
              流程：{draft.flow.name}（{draft.flow.id}）·{' '}
              {Object.keys(draft.flow.variables ?? {}).length} 个变量
            </p>
            {draft.warnings.length > 0 ? (
              <>
                <p className="rb-muted">{draft.warnings.length} 处内容无法映射为步骤：</p>
                <ul className="rb-import-warnings">
                  {draft.warnings.slice(0, 20).map((warning, index) => (
                    <li key={`${warning.line}-${index}`}>
                      第 {warning.line} 行：{warning.message}
                    </li>
                  ))}
                </ul>
                {draft.warnings.length > 20 && (
                  <p className="rb-muted">…以及另外 {draft.warnings.length - 20} 条。</p>
                )}
              </>
            ) : (
              <p className="rb-muted">全部语句都已映射为步骤。</p>
            )}
            <div className="rb-modal-actions">
              <button className="rb-primary" onClick={accept}>
                载入到编辑器
              </button>
              <button onClick={() => setDraft(null)}>重新解析</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
