/**
 * `log` notification channel - the development / degradation default.
 *
 * It writes the notice to the logger so an operator can copy the takeover URL
 * from the server output when no webhook / chat bot / SMTP is configured.
 */
import type { Logger } from 'pino';
import type { NotificationChannel, NotifyNotice } from '../notifier.js';
import { noticeFields, noticeKind, noticeTitle } from '../format.js';

/** Channel that emits the notice through pino. */
export class LogNotificationChannel implements NotificationChannel {
  public readonly name = 'log';

  public constructor(private readonly logger: Logger) {}

  public async send(notice: NotifyNotice): Promise<void> {
    const context: Record<string, unknown> = { kind: noticeKind(notice) };
    for (const [key, value] of noticeFields(notice)) {
      context[key.toLowerCase().replace(/\s+/g, '')] = value;
    }
    const headline = `${noticeTitle(notice).toUpperCase()} - ${notice.message}`;
    const suffix = notice.url ? ` - open ${notice.url}` : '';
    this.logger.warn(context, `${headline}${suffix}`);
  }
}
