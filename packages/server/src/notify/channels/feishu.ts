/**
 * `feishu` notification channel - Feishu (Lark) custom bot webhook.
 *
 * Setup in Feishu:
 *   1. Open the target group -> Settings -> Bots -> Add bot -> Custom bot;
 *   2. Copy the webhook URL (`https://open.feishu.cn/open-apis/bot/v2/hook/xxx`);
 *   3. Optionally enable signature verification and copy the secret;
 *   4. Set `FEISHU_WEBHOOK_URL` (and `FEISHU_SECRET` when signing is on).
 *
 * The payload is an interactive card rather than plain text so the takeover URL
 * is a clickable button on mobile. Feishu answers HTTP 200 even for a rejected
 * message, so the response body is checked as well.
 */
import { createHmac } from 'node:crypto';
import type { NotificationChannel, NotifyNotice } from '../notifier.js';
import { noticeFields, noticeTitle } from '../format.js';
import { postJson } from '../http.js';

/** Options for {@link FeishuNotificationChannel}. */
export interface FeishuOptions {
  /** Incoming-webhook URL of the group bot. */
  webhookUrl: string;
  /**
   * Signing secret. When set, Feishu requires a `timestamp` + `sign` pair:
   * HMAC-SHA256 with `<timestamp>\n<secret>` as key and an empty message,
   * base64 encoded.
   */
  secret?: string;
  /** Delivery timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Sends notices to a Feishu group bot. */
export class FeishuNotificationChannel implements NotificationChannel {
  public readonly name = 'feishu';
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: FeishuOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `timestamp` + `sign` query parameters when a secret is configured. */
  private signature(): { timestamp: string; sign: string } | undefined {
    if (!this.options.secret) return undefined;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sign = createHmac('sha256', `${timestamp}\n${this.options.secret}`)
      .digest('base64');
    return { timestamp, sign };
  }

  public async send(notice: NotifyNotice): Promise<void> {
    const signature = this.signature();
    const url = new URL(this.options.webhookUrl);
    if (signature) {
      url.searchParams.set('timestamp', signature.timestamp);
      url.searchParams.set('sign', signature.sign);
    }

    const elements: Array<Record<string, unknown>> = [
      {
        tag: 'div',
        fields: noticeFields(notice).map(([key, value]) => ({
          is_short: false,
          text: { tag: 'lark_md', content: `**${key}**: ${value}` },
        })),
      },
    ];
    if (notice.url) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'lark_md', content: 'Open takeover page' },
            type: 'primary',
            url: notice.url,
          },
        ],
      });
    }

    const response = await postJson(
      this.fetchImpl,
      url.toString(),
      {
        msg_type: 'interactive',
        card: {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: noticeTitle(notice) } },
          elements,
        },
      },
      {
        channel: 'feishu',
        ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(`feishu webhook responded ${response.status}`);
    }
    const payload = response.payload as
      | { code?: number; msg?: string; StatusCode?: number; StatusMessage?: string }
      | undefined;
    const code = payload?.code ?? payload?.StatusCode ?? 0;
    if (code !== 0) {
      const message = payload?.msg ?? payload?.StatusMessage ?? 'unknown error';
      throw new Error(`feishu webhook rejected the message (${code}): ${message}`);
    }
  }
}
