/**
 * Notification abstraction (spec 8.7).
 *
 * A notifier fans a single {@link NotifyNotice} out to several channels. Every
 * channel must be non-throwing: a failed email must never break the flow, but it
 * must be logged.
 *
 * Two kinds of notice travel through the same pipeline:
 * - `takeover`   - a `manual` step is waiting for a human (CAPTCHA, SMS, ...);
 * - `run-failed` - a run stopped and needs attention (step error, timeout,
 *                  abort, worker crash).
 */
import type { Logger } from 'pino';

/** What a notice is about. */
export type NoticeKind = 'takeover' | 'run-failed';

/** A notification that a run needs a human - or has already given up. */
export interface NotifyNotice {
  /**
   * Notice category. `takeover` asks the operator to act on a live page,
   * `run-failed` reports that a run stopped and needs attention. Defaults to
   * `takeover` so existing callers keep their behaviour.
   */
  kind?: NoticeKind;
  /** Run identifier. */
  runId: string;
  /** Step that triggered the notice; empty for run-level failures. */
  stepId: string;
  /** Machine-readable reason (`captcha`, `sms`, `STEP_TIMEOUT`, ...). */
  reason: string;
  /** Human-readable description. */
  message: string;
  /** Full URL the operator should open (takeover notices). */
  url?: string;
  /** Ticket expiry, ISO string (takeover notices). */
  expiresAt?: string;
  /** Takeover session id (takeover notices). */
  sessionId?: string;
  /** Flow name, when known (run-failed notices). */
  flowName?: string;
  /** Extra context rendered by the channels (run-failed notices). */
  details?: Record<string, string | number | boolean | undefined>;
}

/** A notification about a pending takeover. */
export type TakeoverNotice = NotifyNotice;

/** Delivery result for one channel. */
export interface DeliveryResult {
  channel: string;
  ok: boolean;
  error?: string;
}

/** A single notification transport. */
export interface NotificationChannel {
  /** Stable name used in `manual.notify` lists. */
  readonly name: string;
  /** Deliver a notice. Implementations should throw on failure. */
  send(notice: NotifyNotice): Promise<void>;
}

/**
 * Fan-out notifier.
 *
 * Unknown channel names are reported as failures rather than throwing, so a
 * typo in a flow cannot abort the run.
 */
export class Notifier {
  private readonly channels = new Map<string, NotificationChannel>();

  public constructor(private readonly logger?: Logger) {}

  /** Register (or replace) a channel. */
  public register(channel: NotificationChannel): this {
    this.channels.set(channel.name, channel);
    return this;
  }

  /** Registered channel names. */
  public names(): string[] {
    return [...this.channels.keys()];
  }

  /**
   * Deliver a notice to the requested channels.
   *
   * @param requested - Channel names; unknown names produce a failed result.
   * @param notice - Payload.
   * @returns One result per requested channel.
   */
  public async notify(
    requested: readonly string[],
    notice: NotifyNotice,
  ): Promise<DeliveryResult[]> {
    const names = requested.length > 0 ? requested : ['log'];
    const results: DeliveryResult[] = [];
    for (const name of names) {
      const channel = this.channels.get(name);
      if (!channel) {
        results.push({ channel: name, ok: false, error: 'unknown channel' });
        this.logger?.warn({ channel: name }, 'unknown notification channel');
        continue;
      }
      try {
        await channel.send(notice);
        results.push({ channel: name, ok: true });
        this.logger?.info(
          { channel: name, runId: notice.runId, kind: notice.kind ?? 'takeover' },
          'notification delivered',
        );
      } catch (error) {
        results.push({ channel: name, ok: false, error: (error as Error).message });
        this.logger?.error(
          { channel: name, err: (error as Error).message },
          'notification delivery failed',
        );
      }
    }
    return results;
  }
}
