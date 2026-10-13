/**
 * Web-login credential panel.
 *
 * Passwords live in the OS keychain (main process) and are only ever written
 * from here: the flow document stores nothing but the credential *name*. A
 * blank password field means "keep whatever is already stored", so the panel
 * never has to render a password back into the DOM.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { CredentialSummary } from '@robrowser/core';

/** Draft held in the editor form. */
interface Draft {
  key: string;
  username: string;
  password: string;
  url: string;
}

const EMPTY_DRAFT: Draft = { key: '', username: '', password: '', url: '' };

/** Render an ISO timestamp as a compact local string. */
function formatTime(value: string | undefined): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** Props for {@link CredentialPanel}. */
export interface CredentialPanelProps {
  /** Called after a write so the host can refresh anything that depends on it. */
  onChanged?(): void;
}

/**
 * Manage stored web logins.
 *
 * The list only ever contains redacted metadata; passwords stay in the main
 * process, which is why editing shows an empty password box even for an
 * existing credential.
 */
export function CredentialPanel({ onChanged }: CredentialPanelProps): React.ReactElement {
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** Key currently being edited; empty means "new credential". */
  const [editing, setEditing] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const [list, status] = await Promise.all([
      window.robrowser.listCredentials().catch(() => [] as CredentialSummary[]),
      window.robrowser
        .credentialsAvailable()
        .catch(() => ({ available: true, reason: undefined as string | undefined })),
    ]);
    setItems(list);
    setAvailable(status.available);
    setReason(status.reason);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Start editing an existing credential (password box stays empty). */
  const startEdit = (item: CredentialSummary): void => {
    setEditing(item.key);
    setDraft({
      key: item.key,
      username: item.username ?? '',
      password: '',
      url: item.url ?? '',
    });
    setMessage(null);
  };

  const reset = (): void => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setMessage(null);
  };

  const save = async (): Promise<void> => {
    const key = draft.key.trim();
    if (key.length === 0) {
      setMessage('请填写凭据名（流程中用它引用，例如 login）');
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await window.robrowser
      .saveCredential({
        key,
        ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
        // An empty box means "unchanged", not "clear the password".
        ...(draft.password ? { password: draft.password } : {}),
        ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
      })
      .catch((error: unknown) => ({ ok: false, error: String(error) }));
    setBusy(false);
    if (!result.ok) {
      setMessage(result.error ?? '保存失败');
      return;
    }
    await refresh();
    onChanged?.();
    reset();
  };

  const remove = async (key: string): Promise<void> => {
    setBusy(true);
    await window.robrowser.deleteCredential(key).catch(() => ({ ok: false }));
    setBusy(false);
    if (editing === key) reset();
    await refresh();
    onChanged?.();
  };

  return (
    <aside className="rb-panel">
      <div className="rb-panel-head">
        <h2>网页账号密码</h2>
      </div>
      <p className="rb-muted">
        密码加密保存在系统凭据库，不会写入流程文件。
        流程步骤中可用 {`{{凭据名.username}}`} 与 {`{{凭据名.password}}`} 插值。
      </p>

      {!available && (
        <p className="rb-warn">
          {reason ?? '系统凭据库不可用，暂时只能保存用户名。'}
        </p>
      )}
      {message && <p className="rb-error-text">{message}</p>}

      <div className="rb-var">
        <div className="rb-row">
          <input
            placeholder="凭据名（流程中引用，如 github）"
            value={draft.key}
            disabled={editing !== null}
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          />
        </div>
        <div className="rb-row">
          <input
            placeholder="用户名 / 邮箱"
            value={draft.username}
            onChange={(event) => setDraft({ ...draft, username: event.target.value })}
          />
        </div>
        <div className="rb-row">
          <input
            type="password"
            placeholder={editing ? '密码（留空表示不修改）' : '密码'}
            value={draft.password}
            autoComplete="new-password"
            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
          />
        </div>
        <div className="rb-row">
          <input
            placeholder="站点地址（可选，如 https://example.com/login）"
            value={draft.url}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          />
        </div>
        <div className="rb-row">
          <button className="rb-primary" disabled={busy} onClick={() => void save()}>
            {editing ? '保存修改' : '添加凭据'}
          </button>
          {editing && (
            <button disabled={busy} onClick={reset}>
              取消
            </button>
          )}
        </div>
      </div>

      {items.length === 0 && <p className="rb-muted">还没有保存任何账号密码。</p>}
      {items.map((item) => (
        <div key={item.key} className="rb-var">
          <div className="rb-row">
            <strong className="rb-grow">{item.key}</strong>
            <button disabled={busy} onClick={() => startEdit(item)}>
              编辑
            </button>
            <button className="rb-danger" disabled={busy} onClick={() => void remove(item.key)}>
              ×
            </button>
          </div>
          <div className="rb-muted rb-cred-meta">
            {item.username ?? '（无用户名）'}
            {item.url ? ' · ' + item.url : ''}
            {item.updatedAt ? ' · ' + formatTime(item.updatedAt) : ''}
          </div>
        </div>
      ))}
    </aside>
  );
}
