/**
 * `log` notification channel — the development / degradation default.
 *
 * It writes the takeover URL to the logger so an operator can copy it from the
 * server output when no webhook / SMTP is configured.
 */
import type { Logger } from 'pino';
import type { NotificationChannel, TakeoverNotice } from '../notifier.js';

/** Channel that emits the notice through pino. */
export class LogNotificationChannel implements NotificationChannel {
  public readonly name = 'log';

  public constructor(private readonly logger: Logger) {}

  public async send(notice: TakeoverNotice): Promise<void> {
    this.logger.warn(
      {
        runId: notice.runId,
        stepId: notice.stepId,
        reason: notice.reason,
        expiresAt: notice.expiresAt,
        url: notice.url,
      },
      `MANUAL TAKEOVER REQUIRED — open ${notice.url}`,
    );
  }
}
