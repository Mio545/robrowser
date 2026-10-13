/**
 * Wire the configured notification channels into a {@link Notifier}.
 *
 * Both the CLI (`run` / `takeover`) and the queue worker need the same set,
 * so the mapping from environment configuration to channels lives in one place.
 *
 * Every channel is registered even when its configuration is missing: an
 * unconfigured channel then reports a clear `... is not set` failure instead of
 * the flow silently losing its notification. Registration itself never throws.
 */
import type { Logger } from 'pino';
import type { RunResult } from '@robrowser/core';
import { Notifier, type DeliveryResult, type NotifyNotice } from './notifier.js';
import { LogNotificationChannel } from './channels/log.js';
import { WebhookNotificationChannel } from './channels/webhook.js';
import { EmailNotificationChannel } from './channels/email.js';
import { FeishuNotificationChannel } from './channels/feishu.js';
import { DingTalkNotificationChannel } from './channels/dingtalk.js';

/** Settings shared by the CLI and the worker. */
export interface NotifierSettings {
  /** URL for the generic `webhook` channel. */
  webhookUrl?: string;
  /** SMTP connection string (`smtp://...`) or HTTP relay URL. */
  smtpUrl?: string;
  /** Default email recipient(s). */
  notifyTo?: string;
  /** Feishu custom-bot webhook. */
  feishuWebhookUrl?: string;
  /** Feishu signing secret (required when the bot enables signature mode). */
  feishuSecret?: string;
  /** DingTalk custom-robot webhook (including `access_token`). */
  dingtalkWebhookUrl?: string;
  /** DingTalk signing secret (`SEC...`). */
  dingtalkSecret?: string;
  /** Email subject prefix. */
  subjectPrefix?: string;
}

/** Channel names this build can register. */
export const KNOWN_CHANNELS = [
  'log',
  'webhook',
  'email',
  'feishu',
  'dingtalk',
] as const;

/** A registered channel name. */
export type KnownChannel = (typeof KNOWN_CHANNELS)[number];

/** An injectable fetch, so tests never touch the network. */
export type FetchLike = typeof fetch;

/**
 * Build a notifier with every known channel registered.
 *
 * @param settings - Configuration read from the environment.
 * @param logger - Process logger.
 * @param fetchImpl - Fetch implementation override (tests).
 */
export function buildNotifier(
  settings: NotifierSettings,
  logger: Logger,
  fetchImpl: FetchLike = fetch,
): Notifier {
  const notifier = new Notifier(logger);
  notifier.register(new LogNotificationChannel(logger));

  if (settings.webhookUrl) {
    notifier.register(
      new WebhookNotificationChannel({ url: settings.webhookUrl, fetchImpl }),
    );
  }
  if (settings.feishuWebhookUrl) {
    notifier.register(
      new FeishuNotificationChannel({
        webhookUrl: settings.feishuWebhookUrl,
        ...(settings.feishuSecret ? { secret: settings.feishuSecret } : {}),
        fetchImpl,
      }),
    );
  }
  if (settings.dingtalkWebhookUrl) {
    notifier.register(
      new DingTalkNotificationChannel({
        webhookUrl: settings.dingtalkWebhookUrl,
        ...(settings.dingtalkSecret ? { secret: settings.dingtalkSecret } : {}),
        fetchImpl,
      }),
    );
  }
  if (settings.smtpUrl && settings.notifyTo) {
    notifier.register(
      new EmailNotificationChannel({
        transport: settings.smtpUrl,
        to: settings.notifyTo,
        subjectPrefix: settings.subjectPrefix ?? '[RoboBrowser]',
        fetchImpl,
      }),
    );
  }
  return notifier;
}

/**
 * Warn about requested channels that could not be configured.
 *
 * @param notifier - Result of {@link buildNotifier}.
 * @param requested - Channel names from `NOTIFY_CHANNELS` / `manual.notify`.
 * @param logger - Process logger.
 */
export function warnMissingChannels(
  notifier: Notifier,
  requested: readonly string[],
  logger: Logger,
): void {
  const registered = new Set(notifier.names());
  for (const channel of requested) {
    if (registered.has(channel)) continue;
    if ((KNOWN_CHANNELS as readonly string[]).includes(channel)) {
      logger.warn(
        { channel },
        `notification channel "${channel}" is configured but its settings are missing; it will fail when used`,
      );
    } else {
      logger.warn(
        { channel },
        `unknown notification channel "${channel}"; it will fail when used`,
      );
    }
  }
}

/**
 * Deliver a run-failure notice, never throwing.
 *
 * Notification is best effort: a broken webhook must not change the exit code of
 * an already-failed run, nor crash a worker. Problems are reported through
 * `logger` (and optionally `onResult`) so the operator can see them.
 *
 * @param notifier - Configured notifier.
 * @param channels - Channel names to use (`NOTIFY_CHANNELS` / `manual.notify`).
 * @param result - Terminal run result.
 * @param logger - Process logger.
 * @param options - Extra context (`runDir`) and a result observer.
 * @returns One delivery result per channel (empty when delivery itself threw).
 */
export async function deliverRunFailure(
  notifier: Notifier,
  channels: readonly string[],
  result: RunResult,
  logger: Logger,
  options: {
    runDir?: string;
    onResult?: (results: readonly DeliveryResult[]) => void;
  } = {},
): Promise<DeliveryResult[]> {
  try {
    const results = await notifier.notify(
      channels,
      runFailureNotice(result, options.runDir ? { runDir: options.runDir } : {}),
    );
    for (const entry of results) {
      if (!entry.ok) {
        logger.warn(
          { channel: entry.channel, err: entry.error, runId: result.runId },
          'run-failure notification not delivered',
        );
      }
    }
    options.onResult?.(results);
    return results;
  } catch (error) {
    logger.error(
      { err: String(error), runId: result.runId },
      'run-failure notification failed',
    );
    return [];
  }
}

/**
 * Translate a terminal {@link RunResult} into a notification.
 *
 * Only called for runs that stopped without succeeding: a step error, a step
 * timeout, a worker crash or an explicit abort. Successful runs are silent.
 *
 * @param result - Terminal result reported by the orchestrator / supervisor.
 * @param options - Extra context (`runDir` and a fallback step id).
 */
export function runFailureNotice(
  result: RunResult,
  options: { runDir?: string; stepId?: string } = {},
): NotifyNotice {
  const reason = result.error?.code ?? result.reason.toUpperCase();
  const message = result.error?.message ?? `run finished with status ${result.status} (${result.reason})`;
  const details: Record<string, string | number | boolean | undefined> = {
    Status: result.status,
    Reason: result.reason,
    Steps: result.stepCount,
    Duration: `${Math.round(result.durationMs / 1000)}s`,
  };
  if (options.runDir) details['Run dir'] = options.runDir;
  return {
    kind: 'run-failed',
    runId: result.runId,
    stepId: result.failedStepId ?? options.stepId ?? '',
    reason,
    message,
    flowName: result.flowName,
    details,
  };
}
