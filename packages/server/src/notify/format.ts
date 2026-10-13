/**
 * Shared rendering for notification channels.
 *
 * Keeping the wording in one place means the log line, the Feishu card, the
 * DingTalk message, the generic webhook payload and the email body all say the
 * same thing - an operator reading two of them at once is never confused.
 */
import type { NotifyNotice } from './notifier.js';

/** Notice kind with the `takeover` default applied. */
export function noticeKind(notice: NotifyNotice): 'takeover' | 'run-failed' {
  return notice.kind === 'run-failed' ? 'run-failed' : 'takeover';
}

/** True when the notice asks a human to act on a live page. */
export function isTakeover(notice: NotifyNotice): boolean {
  return noticeKind(notice) === 'takeover';
}

/** Headline shown as the email subject / chat card title / log line. */
export function noticeTitle(notice: NotifyNotice): string {
  const headline = isTakeover(notice)
    ? 'Manual takeover required'
    : 'Run stopped and needs attention';
  return `${headline} (${notice.reason})`;
}

/** `key: value` rows rendered by every channel, in a stable order. */
export function noticeFields(notice: NotifyNotice): Array<[string, string]> {
  const fields: Array<[string, string]> = [['Run', notice.runId]];
  if (notice.flowName) fields.push(['Flow', notice.flowName]);
  if (notice.stepId) fields.push(['Step', notice.stepId]);
  fields.push(['Reason', notice.reason], ['Message', notice.message]);
  if (notice.expiresAt) fields.push(['Link expires', notice.expiresAt]);
  for (const [key, value] of Object.entries(notice.details ?? {})) {
    if (value !== undefined) fields.push([key, String(value)]);
  }
  return fields;
}

/** Plain-text rendering (log, email, generic webhook). */
export function noticeText(notice: NotifyNotice): string {
  const lines = [
    noticeTitle(notice),
    ...noticeFields(notice).map(([key, value]) => `${key}: ${value}`),
  ];
  if (notice.url) lines.push('', `Open: ${notice.url}`);
  return lines.join('\n');
}

/** Markdown rendering (Feishu / DingTalk chat messages). */
export function noticeMarkdown(notice: NotifyNotice): string {
  const lines = [`**${noticeTitle(notice)}**`, ''];
  for (const [key, value] of noticeFields(notice)) {
    lines.push(`- ${key}: ${value}`);
  }
  if (notice.url) {
    lines.push('', `[Open the takeover page](${notice.url})`);
  }
  return lines.join('\n');
}
