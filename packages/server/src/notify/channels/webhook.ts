/**
 * `webhook` notification channel (spec 8.7).
 *
 * POSTs a JSON payload to a configured URL. Failures (non-2xx, network errors)
 * throw so the notifier can report them.
 */
import type { NotificationChannel, TakeoverNotice } from '../notifier.js';

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

  public async send(notice: TakeoverNotice): Promise<void> {
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.headers ?? {}),
      },
      body: JSON.stringify({
        type: 'takeover.requested',
        runId: notice.runId,
        stepId: notice.stepId,
        reason: notice.reason,
        message: notice.message,
        url: notice.url,
        expiresAt: notice.expiresAt,
        sessionId: notice.sessionId,
        text: `Manual takeover required for run ${notice.runId} (${notice.reason}): ${notice.url}`,
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (!response.ok) {
      throw new Error(`webhook responded ${response.status}`);
    }
  }
}
