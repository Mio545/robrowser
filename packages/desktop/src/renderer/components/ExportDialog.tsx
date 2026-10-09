import React, { useState } from 'react';
import type { FlowModel } from '@robrowser/core';

/** Props for {@link ExportDialog}. */
export interface ExportDialogProps {
  flow: FlowModel;
  onClose(): void;
}

/**
 * Script export dialog (spec 9).
 *
 * Generates the script in the main process (same exporter the CLI uses, so the
 * output is identical) and lets the user preview it before saving.
 */
export function ExportDialog({ flow, onClose }: ExportDialogProps): React.ReactElement {
  const [target, setTarget] = useState<'playwright' | 'raw-cdp'>('playwright');
  const [script, setScript] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generate = async (): Promise<void> => {
    setBusy(true);
    setStatus(null);
    const result = await window.robrowser.exportScript(flow, target);
    setBusy(false);
    if (!result.ok || !result.script) {
      setStatus(`导出失败：${result.error?.message ?? '未知错误'}`);
      return;
    }
    setScript(result.script);
    setStatus(`已生成 ${result.script.length} 字节`);
  };

  const save = async (): Promise<void> => {
    if (!script) return;
    const extension = target === 'playwright' ? 'cjs' : 'cjs';
    const result = await window.robrowser.saveScript(`${flow.id}-${target}.${extension}`, script);
    if (result.ok && result.path) setStatus(`已保存到 ${result.path}`);
    else if (!result.ok) setStatus('已取消保存');
  };

  return (
    <div className="rb-modal-backdrop" onClick={onClose}>
      <div className="rb-modal" onClick={(event) => event.stopPropagation()}>
        <div className="rb-modal-head">
          <h2>导出脚本</h2>
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value as 'playwright')}
          >
            <option value="playwright">Playwright</option>
            <option value="raw-cdp">原生 CDP</option>
          </select>
          <span className="rb-grow" />
          <button onClick={generate} disabled={busy} className="rb-primary">
            {busy ? '生成中…' : '生成预览'}
          </button>
          <button onClick={save} disabled={!script}>
            保存…
          </button>
          <button onClick={onClose}>关闭</button>
        </div>
        {status && <p className="rb-muted">{status}</p>}
        <textarea
          className="rb-code"
          readOnly
          value={script}
          placeholder="点击“生成预览”查看导出的脚本。"
        />
      </div>
    </div>
  );
}
