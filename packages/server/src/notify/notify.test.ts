/**
 * Notification tests (spec 8.7 / 11): channel payloads, signing, fan-out
 * isolation. Every test injects a fetch stub, so nothing touches the network.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { pino } from 'pino';
import { Notifier, type NotifyNotice } from './notifier.js';
import {
  buildNotifier,
  deliverRunFailure,
  runFailureNotice,
  warnMissingChannels,
} from './build.js';
import { FeishuNotificationChannel } from './channels/feishu.js';
import { DingTalkNotificationChannel } from './channels/dingtalk.js';
import { WebhookNotificationChannel } from './channels/webhook.js';
import { EmailNotificationChannel } from './channels/email.js';
import { LogNotificationChannel } from './channels/log.js';
import { noticeMarkdown, noticeText } from './format.js';
import type { RunResult } from '@robrowser/core';

const logger = pino({ level: 'silent' });

/** A takeover notice with every field populated. */
function takeoverNotice(overrides: Partial<NotifyNotice> = {}): NotifyNotice {
  return {
    runId: 'run-1',
    stepId: 'human',
    reason: 'captcha',
    message: 'type the code',
    url: 'https://example.test/takeover/?ticket=abc',
    expiresAt: '2026-01-01T00:00:00.000Z',
    sessionId: 'tk-1',
    ...overrides,
  };
}

/** A terminal failure result. */
function failedRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-9',
    flowId: 'demo',
    flowName: 'Demo flow',
    status: 'failed',
    reason: 'error',
    stepCount: 3,
    durationMs: 4_200,
    artifacts: [],
    error: { code: 'STEP_TIMEOUT', message: 'click timed out' },
    failedStepId: 'submit',
    variables: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:04.200Z',
    ...overrides,
  };
}

/** A fetch stub recording calls and answering with a canned body. */
function stubFetch(
  body: unknown = { code: 0, errcode: 0 },
  init: { ok?: boolean; status?: number } = {},
): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, requestInit?: RequestInit) => {
    calls.push({ url: String(url), ...(requestInit ? { init: requestInit } : {}) });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('notice rendering', () => {
  it('renders a takeover notice as text with the link last', () => {
    const text = noticeText(takeoverNotice());
    expect(text).toContain('Manual takeover required (captcha)');
    expect(text).toContain('Run: run-1');
    expect(text).toContain('Step: human');
    expect(text).toContain('Open: https://example.test/takeover/?ticket=abc');
  });

  it('renders a run failure without a link and marks it as markdown', () => {
    const notice = runFailureNotice(failedRun());
    expect(notice.kind).toBe('run-failed');
    expect(notice.stepId).toBe('submit');
    expect(notice.reason).toBe('STEP_TIMEOUT');
    const markdown = noticeMarkdown(notice);
    expect(markdown).toContain('Run stopped and needs attention (STEP_TIMEOUT)');
    expect(markdown).toContain('Flow: Demo flow');
    expect(markdown).not.toContain('[Open the takeover page]');
  });
});

describe('FeishuNotificationChannel', () => {
  it('posts an interactive card with a clickable takeover button', async () => {
    const { impl, calls } = stubFetch();
    const channel = new FeishuNotificationChannel({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      fetchImpl: impl,
    });

    await channel.send(takeoverNotice());

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      msg_type: string;
      card: { header: { title: { content: string } }; elements: Array<Record<string, unknown>> };
    };
    expect(body.msg_type).toBe('interactive');
    expect(body.card.header.title.content).toBe('Manual takeover required (captcha)');
    expect(JSON.stringify(body.card.elements)).toContain(
      'https://example.test/takeover/?ticket=abc',
    );
  });

  it('signs the request when a secret is configured', async () => {
    const { impl, calls } = stubFetch();
    const channel = new FeishuNotificationChannel({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      secret: 'feishu-secret',
      fetchImpl: impl,
    });

    await channel.send(takeoverNotice());

    const url = new URL(calls[0]!.url);
    const timestamp = url.searchParams.get('timestamp');
    const sign = url.searchParams.get('sign');
    expect(timestamp).toMatch(/^\d+$/);
    const expected = createHmac('sha256', `${timestamp}\nfeishu-secret`)
      .digest('base64');
    expect(sign).toBe(expected);
  });

  it('throws when the bot rejects the message despite HTTP 200', async () => {
    const { impl } = stubFetch({ code: 9499, msg: 'Bad Request' });
    const channel = new FeishuNotificationChannel({
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/token',
      fetchImpl: impl,
    });

    await expect(channel.send(takeoverNotice())).rejects.toThrow(/9499/);
  });
});

describe('DingTalkNotificationChannel', () => {
  it('posts markdown by default', async () => {
    const { impl, calls } = stubFetch({ errcode: 0, errmsg: 'ok' });
    const channel = new DingTalkNotificationChannel({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
      fetchImpl: impl,
    });

    await channel.send(takeoverNotice());

    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      msgtype: string;
      markdown: { title: string; text: string };
    };
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.title).toBe('Manual takeover required (captcha)');
    expect(body.markdown.text).toContain('https://example.test/takeover/?ticket=abc');
  });

  it('supports the plain-text format', async () => {
    const { impl, calls } = stubFetch({ errcode: 0, errmsg: 'ok' });
    const channel = new DingTalkNotificationChannel({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
      format: 'text',
      fetchImpl: impl,
    });

    await channel.send(runFailureNotice(failedRun()));

    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      msgtype: string;
      text: { content: string };
    };
    expect(body.msgtype).toBe('text');
    expect(body.text.content).toContain('Run stopped and needs attention');
  });

  it('signs the request with timestamp + HMAC over the secret', async () => {
    const { impl, calls } = stubFetch({ errcode: 0, errmsg: 'ok' });
    const channel = new DingTalkNotificationChannel({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
      secret: 'SECtest',
      fetchImpl: impl,
    });

    await channel.send(takeoverNotice());

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('access_token')).toBe('t');
    const timestamp = url.searchParams.get('timestamp')!;
    const expected = createHmac('sha256', 'SECtest')
      .update(`${timestamp}\nSECtest`)
      .digest('base64');
    expect(url.searchParams.get('sign')).toBe(expected);
  });

  it('throws when errcode is non-zero', async () => {
    const { impl } = stubFetch({ errcode: 310000, errmsg: 'keywords not in content' });
    const channel = new DingTalkNotificationChannel({
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
      fetchImpl: impl,
    });

    await expect(channel.send(takeoverNotice())).rejects.toThrow(/310000/);
  });
});

describe('WebhookNotificationChannel', () => {
  it('carries both the structured fields and a ready-to-forward text body', async () => {
    const { impl, calls } = stubFetch({});
    const channel = new WebhookNotificationChannel({
      url: 'https://hooks.example.test/notify',
      headers: { authorization: 'Bearer t' },
      fetchImpl: impl,
    });

    await channel.send(runFailureNotice(failedRun()));

    expect(calls[0]!.init?.headers).toMatchObject({ authorization: 'Bearer t' });
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body.type).toBe('run.failed');
    expect(body.kind).toBe('run-failed');
    expect(body.runId).toBe('run-9');
    expect(body.reason).toBe('STEP_TIMEOUT');
    expect(body.flowName).toBe('Demo flow');
    expect(String(body.text)).toContain('click timed out');
  });

  it('uses the takeover type for manual steps', async () => {
    const { impl, calls } = stubFetch({});
    const channel = new WebhookNotificationChannel({
      url: 'https://hooks.example.test/notify',
      fetchImpl: impl,
    });

    await channel.send(takeoverNotice());

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body.type).toBe('takeover.requested');
    expect(body.sessionId).toBe('tk-1');
  });

  it('throws on a non-2xx response', async () => {
    const { impl } = stubFetch({}, { ok: false, status: 503 });
    const channel = new WebhookNotificationChannel({
      url: 'https://hooks.example.test/notify',
      fetchImpl: impl,
    });

    await expect(channel.send(takeoverNotice())).rejects.toThrow(/503/);
  });
});

describe('EmailNotificationChannel', () => {
  it('posts to an HTTP relay with a subject naming the run', async () => {
    const { impl, calls } = stubFetch({});
    const channel = new EmailNotificationChannel({
      transport: 'https://mail.example.test/send',
      to: 'ops@example.test',
      subjectPrefix: '[RoboBrowser]',
      fetchImpl: impl,
    });

    await channel.send(runFailureNotice(failedRun()));

    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, string>;
    expect(body.to).toBe('ops@example.test');
    expect(body.subject).toBe('[RoboBrowser] Run stopped and needs attention (STEP_TIMEOUT) - run run-9');
    expect(body.text).toContain('Step: submit');
  });

  it('reports a missing nodemailer dependency instead of crashing', async () => {
    const channel = new EmailNotificationChannel({
      transport: 'smtp://user:pass@smtp.example.test:587',
      to: 'ops@example.test',
    });

    await expect(channel.send(takeoverNotice())).rejects.toThrow(/nodemailer/);
  });

  it('rejects an unsupported transport scheme', async () => {
    const channel = new EmailNotificationChannel({
      transport: 'ftp://mail.example.test',
      to: 'ops@example.test',
    });

    await expect(channel.send(takeoverNotice())).rejects.toThrow(/Unsupported email transport/);
  });
});

describe('Notifier fan-out', () => {
  it('isolates a failing channel from the others', async () => {
    const notifier = new Notifier(logger);
    notifier.register({
      name: 'boom',
      send: async () => {
        throw new Error('channel exploded');
      },
    });
    const delivered: string[] = [];
    notifier.register({
      name: 'ok',
      send: async (notice) => {
        delivered.push(notice.runId);
      },
    });

    const results = await notifier.notify(['boom', 'ok'], takeoverNotice());

    expect(results).toEqual([
      { channel: 'boom', ok: false, error: 'channel exploded' },
      { channel: 'ok', ok: true },
    ]);
    expect(delivered).toEqual(['run-1']);
  });

  it('reports an unknown channel instead of throwing', async () => {
    const notifier = new Notifier(logger);
    const results = await notifier.notify(['nope'], takeoverNotice());
    expect(results).toEqual([{ channel: 'nope', ok: false, error: 'unknown channel' }]);
  });

  it('falls back to the log channel when nothing is requested', async () => {
    const notifier = new Notifier(logger);
    const seen: string[] = [];
    notifier.register({
      name: 'log',
      send: async () => {
        seen.push('log');
      },
    });

    await notifier.notify([], takeoverNotice());

    expect(seen).toEqual(['log']);
  });
});

describe('buildNotifier', () => {
  it('registers exactly the channels that are configured', () => {
    const notifier = buildNotifier(
      {
        webhookUrl: 'https://hooks.example.test/notify',
        feishuWebhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/t',
        dingtalkWebhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=t',
        smtpUrl: 'https://mail.example.test/send',
        notifyTo: 'ops@example.test',
      },
      logger,
    );

    expect(notifier.names().sort()).toEqual(['dingtalk', 'email', 'feishu', 'log', 'webhook']);
  });

  it('registers only the log channel when nothing is configured', () => {
    expect(buildNotifier({}, logger).names()).toEqual(['log']);
  });

  it('does not register the email channel without a recipient', () => {
    const notifier = buildNotifier({ smtpUrl: 'https://mail.example.test/send' }, logger);
    expect(notifier.names()).toEqual(['log']);
  });

  it('warns about a requested channel whose settings are missing', () => {
    const warn = vi.fn();
    const fakeLogger = { warn } as unknown as typeof logger;
    const notifier = buildNotifier({}, logger);

    warnMissingChannels(notifier, ['feishu', 'bogus'], fakeLogger);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![1]).toContain('feishu');
    expect(warn.mock.calls[1]![1]).toContain('unknown notification channel');
  });
});

describe('LogNotificationChannel', () => {
  it('warns with the takeover URL so an operator can copy it', async () => {
    const warn = vi.fn();
    const channel = new LogNotificationChannel({ warn } as unknown as typeof logger);

    await channel.send(takeoverNotice());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toContain('https://example.test/takeover/?ticket=abc');
  });
});

describe('deliverRunFailure', () => {
  it('sends a run-failure notice to every requested channel', async () => {
    const notifier = new Notifier(logger);
    const seen: NotifyNotice[] = [];
    notifier.register({
      name: 'feishu',
      send: async (notice) => {
        seen.push(notice);
      },
    });

    const results = await deliverRunFailure(
      notifier,
      ['feishu'],
      failedRun(),
      logger,
      { runDir: '/tmp/run-9' },
    );

    expect(results).toEqual([{ channel: 'feishu', ok: true }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.kind).toBe('run-failed');
    expect(seen[0]!.details?.['Run dir']).toBe('/tmp/run-9');
  });

  it('reports a failing channel without throwing', async () => {
    const notifier = new Notifier(logger);
    notifier.register({
      name: 'boom',
      send: async () => {
        throw new Error('webhook down');
      },
    });

    const results = await deliverRunFailure(notifier, ['boom'], failedRun(), logger);

    expect(results).toEqual([{ channel: 'boom', ok: false, error: 'webhook down' }]);
  });

  it('still resolves when the notifier itself blows up', async () => {
    const notifier = {
      notify: async () => {
        throw new Error('catastrophic');
      },
    } as unknown as Notifier;

    await expect(deliverRunFailure(notifier, ['log'], failedRun(), logger)).resolves.toEqual([]);
  });

  it('invokes the result observer so the CLI can print warnings', async () => {
    const notifier = new Notifier(logger);
    const observed: string[] = [];

    await deliverRunFailure(notifier, ['missing'], failedRun(), logger, {
      onResult: (results) => observed.push(...results.map((entry) => entry.channel)),
    });

    expect(observed).toEqual(['missing']);
  });
});
