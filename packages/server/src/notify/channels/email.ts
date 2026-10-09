/**
 * `email` notification channel (spec 8.7).
 *
 * Supports two transports, selected by the URL scheme:
 * - `smtp://` / `smtps://`  -> SMTP (requires nodemailer, which is optional)
 * - `http://` / `https://`  -> HTTP API (e.g. a local mail relay)
 *
 * `nodemailer` is an optional dependency: when SMTP is configured but the module
 * is missing, the channel fails with a clear, actionable error instead of
 * crashing the process.
 */
import type { NotificationChannel, TakeoverNotice } from '../notifier.js';

/** Options for {@link EmailNotificationChannel}. */
export interface EmailOptions {
  /** `smtp://user:pass@host:port` or an HTTP endpoint. */
  transport: string;
  /** Recipient address. */
  to: string;
  /** Sender address. */
  from?: string;
  /** Subject prefix. */
  subjectPrefix?: string;
  /** Injectable fetch for the HTTP transport (tests). */
  fetchImpl?: typeof fetch;
}

/** Minimal structural type for the optional \
odemailer\ module. */
interface NodemailerLike {
  createTransport(url: string): {
    sendMail(message: {
      to: string;
      from: string;
      subject: string;
      text: string;
    }): Promise<unknown>;
  };
}

/** Sends takeover notices by email. */
export class EmailNotificationChannel implements NotificationChannel {
  public readonly name = 'email';
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: EmailOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async send(notice: TakeoverNotice): Promise<void> {
    const subject = `${this.options.subjectPrefix ?? '[RoboBrowser]'} Manual takeover required (${notice.reason}) — run ${notice.runId}`;
    const body = [
      `Run: ${notice.runId}`,
      `Step: ${notice.stepId}`,
      `Reason: ${notice.reason}`,
      `Message: ${notice.message}`,
      `Link expires: ${notice.expiresAt}`,
      '',
      `Open: ${notice.url}`,
    ].join('\n');

    if (/^https?:\/\//.test(this.options.transport)) {
      const response = await this.fetchImpl(this.options.transport, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: this.options.to, from: this.options.from, subject, text: body }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`email API responded ${response.status}`);
      return;
    }

    if (!/^smtps?:\/\//.test(this.options.transport)) {
      throw new Error(`Unsupported email transport: ${this.options.transport}`);
    }

    // SMTP path. `nodemailer` is loaded lazily so it stays an optional
    // dependency; the specifier is held in a variable so TypeScript does not
    // require the package (or its @types) to be installed.
    const moduleName = 'nodemailer';
    let nodemailer: NodemailerLike;
    try {
      nodemailer = (await import(moduleName)) as NodemailerLike;
    } catch {
      throw new Error(
        'SMTP email channel requires the optional "nodemailer" dependency. Install it or use the webhook/log channel.',
      );
    }
    const transport = nodemailer.createTransport(this.options.transport);
    await transport.sendMail({
      to: this.options.to,
      from: this.options.from ?? 'robrowser@localhost',
      subject,
      text: body,
    });
  }
}
