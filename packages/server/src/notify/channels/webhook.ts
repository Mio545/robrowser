/**
 * `webhook` notification channel (spec 8.7).
 *
 * POSTs a JSON payload to a configured URL. Failures (non-2xx, network errors)
 * throw so the notifier can report them.
 *
 * The payload is a superset across notice kinds: `type` distinguishes them,
 * `text` is always a ready-to-forward plain-text summary (so a Slack /
 * WeCom / n8n receiver needs no template), and `url` is present whenever the
 * notice has an actionable link.
 */
import type { NotificationChannel, NotifyNotice } from '../notifier.js';
import { noticeFields, noticeKind, noticeText } from '../format.js';
import { postJson } from '../http.js';

/** Options for {@link WebhookNotificationChannel}. */
export interface WebhookOptions {
  url: string;
  /** Extra headers (e.g. an auth token). */
  headers?: Record<string, string>;
  /** Delivery timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Posts takeover notices to an HTTP endpoint. */
export class WebhookNotificationChannel implements NotificationChannel {
  public readonly name = 'webhook';
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: WebhookOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async send(notice: NotifyNotice): Promise<void> {
    const kind = noticeKind(notice);
    const details: Record<string, unknown> = {};
    for (const [key, value] of noticeFields(notice)) {
      details[key.toLowerCase().replace(/\s+/g, '_')] = value;
    }

    const response = await postJson(
      this.fetchImpl,
      this.options.url,
      {
        type: kind === 'run-failed' ? 'run.failed' : 'takeover.requested',
        kind,
        runId: notice.runId,
        stepId: notice.stepId,
        reason: notice.reason,
        message: notice.message,
        ...(notice.url ? { url: notice.url } : {}),
        ...(notice.expiresAt ? { expiresAt: notice.expiresAt } : {}),
        ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
        ...(notice.flowName ? { flowName: notice.flowName } : {}),
        ...(notice.details ? { details: notice.details } : {}),
        fields: details,
        text: noticeText(notice),
      },
      {
        channel: 'webhook',
        ...(this.options.headers ? { headers: this.options.headers } : {}),
        ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(`webhook responded ${response.status}`);
    }
  }
}
