/**
 * `dingtalk` notification channel - DingTalk group robot.
 *
 * Setup in DingTalk:
 *   1. Open the target group -> Group settings -> Smart group assistant ->
 *      Add robot -> Custom (webhook) robot;
 *   2. Copy the webhook URL (`https://oapi.dingtalk.com/robot/send?access_token=xxx`);
 *   3. For the safer "signature" mode, copy the secret (`SEC...`) and set
 *      `DINGTALK_SECRET`.
 *
 * Signed requests append `timestamp` + `sign` to the query string, where
 * `sign = urlencode(base64(HMAC-SHA256(secret, ${timestamp}\n${secret})))`.
 */
import { createHmac } from 'node:crypto';
import type { NotificationChannel, NotifyNotice } from '../notifier.js';
import { noticeMarkdown, noticeText, noticeTitle } from '../format.js';
import { postJson } from '../http.js';

/** Options for {@link DingTalkNotificationChannel}. */
export interface DingTalkOptions {
  /** Robot webhook URL, including `access_token`. */
  webhookUrl: string;
  /** Signing secret (`SEC...`). Required when the robot uses signed mode. */
  secret?: string;
  /**
   * Message format. `markdown` (default) renders a clickable link;
   * `text` is the most compatible fallback.
   */
  format?: 'markdown' | 'text';
  /** Delivery timeout in milliseconds. */
  timeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Sends notices to a DingTalk group robot. */
export class DingTalkNotificationChannel implements NotificationChannel {
  public readonly name = 'dingtalk';
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: DingTalkOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `timestamp` + `sign` query parameters when a secret is configured. */
  private signature(): { timestamp: string; sign: string } | undefined {
    if (!this.options.secret) return undefined;
    const timestamp = Date.now().toString();
    const sign = createHmac('sha256', this.options.secret)
      .update(`${timestamp}\n${this.options.secret}`)
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

    const body =
      this.options.format === 'text'
        ? { msgtype: 'text', text: { content: noticeText(notice) } }
        : {
            msgtype: 'markdown',
            markdown: { title: noticeTitle(notice), text: noticeMarkdown(notice) },
          };

    const response = await postJson(this.fetchImpl, url.toString(), body, {
      channel: 'dingtalk',
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
    });
    if (!response.ok) {
      throw new Error(`dingtalk webhook responded ${response.status}`);
    }
    const payload = response.payload as { errcode?: number; errmsg?: string } | undefined;
    // DingTalk answers HTTP 200 even for a rejected message, so check errcode.
    if (payload && typeof payload.errcode === 'number' && payload.errcode !== 0) {
      throw new Error(
        `dingtalk webhook rejected the message (${payload.errcode}): ${payload.errmsg ?? 'unknown error'}`,
      );
    }
  }
}
