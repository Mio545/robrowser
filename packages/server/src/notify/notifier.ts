/**
 * Notification abstraction (spec 8.7).
 *
 * A notifier fans a single {@link TakeoverNotice} out to several channels. Every
 * channel must be non-throwing: a failed email must never break the flow, but it
 * must be logged.
 */
import type { Logger } from 'pino';

/** A notification about a pending takeover. */
export interface TakeoverNotice {
  runId: string;
  stepId: string;
  reason: string;
  message: string;
  /** Full URL the operator should open. */
  url: string;
  /** Ticket expiry (ISO). */
  expiresAt: string;
  sessionId: string;
}

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
  send(notice: TakeoverNotice): Promise<void>;
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
    notice: TakeoverNotice,
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
        this.logger?.info({ channel: name, runId: notice.runId }, 'takeover notification sent');
      } catch (error) {
        results.push({ channel: name, ok: false, error: (error as Error).message });
        this.logger?.error(
          { channel: name, err: (error as Error).message },
          'takeover notification failed',
        );
      }
    }
    return results;
  }
}
