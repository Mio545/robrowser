/**
 * PageObserver: event driven page waiting with a polling fallback (spec 5.3).
 *
 * Strategy: subscribe to CDP navigation / lifecycle events and to DOM mutation
 * signals, *and* run a lightweight JS probe on an interval. The first signal to
 * observe the condition wins; this removes the flakiness of pure polling while
 * keeping correctness when events are missed (e.g. same-document navigation).
 */
import type { PagePort, LoggerPort } from '../engine/ports.js';
import type { PageRule } from '../flow/schema.js';
import { matchPage, type MatchResult } from '../engine/condition.js';
import { StepTimeoutError } from '../errors.js';

/** Options for {@link PageObserver.waitForPage}. */
export interface WaitForPageOptions {
  /** Total budget in milliseconds. */
  timeout?: number;
  /** Polling interval for the fallback probe. */
  pollIntervalMs?: number;
}

/** Interface consumed by step handlers via the run context. */
export interface PageObserver {
  /** Resolve once the rule matches, or reject with a timeout error. */
  waitForPage(
    page: PagePort,
    rule: PageRule,
    opts?: WaitForPageOptions | number,
  ): Promise<MatchResult>;
  /** Non-blocking single evaluation of a rule. */
  matchPage(page: PagePort, rule: PageRule): Promise<MatchResult>;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_POLL = 250;

/**
 * Default observer implementation.
 *
 * Note: the observer never issues a fixed `sleep`-then-check loop without an
 * event subscription; events merely short-circuit the wait.
 */
export class DefaultPageObserver implements PageObserver {
  public constructor(private readonly logger: LoggerPort = silentLogger) {}

  public async matchPage(page: PagePort, rule: PageRule): Promise<MatchResult> {
    return matchPage(page, rule);
  }

  public async waitForPage(
    page: PagePort,
    rule: PageRule,
    opts: WaitForPageOptions | number = {},
  ): Promise<MatchResult> {
    const options: WaitForPageOptions = typeof opts === 'number' ? { timeout: opts } : opts;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL;

    const initial = await matchPage(page, rule);
    if (initial.matched) return initial;

    return new Promise<MatchResult>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        clearInterval(poll);
        page.off('load', onSignal);
        page.off('domcontentloaded', onSignal);
        page.off('framenavigated', onSignal);
        page.off('navigation', onSignal);
      };

      const finish = (result: MatchResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const probe = async (): Promise<void> => {
        if (settled) return;
        try {
          const result = await matchPage(page, rule);
          if (result.matched) finish(result);
        } catch (error) {
          // Transient evaluation failures (navigation in flight) are expected.
          this.logger.debug('waitForPage probe failed', { error: String(error) });
        }
      };

      const onSignal = (): void => {
        void probe();
      };

      const timer = setTimeout(() => {
        fail(
          new StepTimeoutError(
            rule.name ?? 'waitForPage',
            timeout,
            `Timed out after ${timeout}ms waiting for page "${rule.name ?? 'unnamed'}"`,
          ),
        );
      }, timeout);

      page.on('load', onSignal);
      page.on('domcontentloaded', onSignal);
      page.on('framenavigated', onSignal);
      page.on('navigation', onSignal);
      const poll = setInterval(() => void probe(), pollIntervalMs);
    });
  }
}

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
