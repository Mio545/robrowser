import React from 'react';

/** Props for {@link BrowserPreview}. */
export interface BrowserPreviewProps {
  url: string;
  onNavigate(url: string): void;
  onReload(): void;
}

/**
 * Toolbar for the embedded `WebContentsView` (spec 9).
 *
 * The actual Chromium surface is a native child view placed by the Electron main
 * process (which is why it is not an `<iframe>` / `<webview>`); this component
 * only provides the address bar and navigation controls above it.
 */
export function BrowserPreview({
  url,
  onNavigate,
  onReload,
}: BrowserPreviewProps): React.ReactElement {
  const [draft, setDraft] = React.useState(url);

  React.useEffect(() => setDraft(url), [url]);

  return (
    <div className="rb-preview-bar">
      <span className="rb-preview-label">内嵌浏览器</span>
      <button onClick={onReload} title="刷新">
        ↻
      </button>
      <input
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onNavigate(draft);
        }}
      />
      <button onClick={() => onNavigate(draft)}>前往</button>
      <span className="rb-muted">{url || 'about:blank'}</span>
    </div>
  );
}
