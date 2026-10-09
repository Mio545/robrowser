/**
 * `manual` step: pause automation and hand control of the current page to a
 * human through the injected {@link ManualHandler} (spec 5.6).
 *
 * The handler is responsible for the actual UX (desktop modal or remote
 * takeover). This step only translates the flow config into a request and maps
 * the outcome back onto a {@link StepResult}.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { ManualTimeoutError } from '../errors.js';

type ManualStep = Extract<Step, { type: 'manual' }>;

/** Default human-interaction budget. */
const DEFAULT_MANUAL_TIMEOUT = 5 * 60_000;

/** Handler for `manual`. */
export const manualHandler = defineHandler<ManualStep>({
  type: 'manual',
  validate(config) {
    const problems: string[] = [];
    if (config.message.trim().length === 0) problems.push('message must not be empty');
    return problems;
  },
  async execute(config, ctx): Promise<StepResult> {
    const message = ctx.vars.interpolate(config.message);
    const timeoutMs = config.timeoutMs ?? DEFAULT_MANUAL_TIMEOUT;

    ctx.bus.emit('manual:request', {
      runId: ctx.runId,
      stepId: config.id,
      reason: config.reason,
      message,
      timeoutMs,
      timestamp: Date.now(),
    });
    ctx.log('warn', `manual intervention required (${config.reason}): ${message}`, { timeoutMs });

    const result = await ctx.manual.request({
      runId: ctx.runId,
      stepId: config.id,
      reason: config.reason,
      message,
      timeoutMs,
      page: ctx.page,
      ...(config.resolveWhen ? { resolveWhen: config.resolveWhen } : {}),
      ...(config.notify ? { notify: config.notify } : {}),
    });

    ctx.bus.emit('manual:resolved', {
      runId: ctx.runId,
      stepId: config.id,
      status: result.status,
      ...(result.by ? { by: result.by } : {}),
      timestamp: Date.now(),
    });

    if (result.status === 'aborted') {
      return { status: 'fail', message: 'manual interaction aborted' };
    }
    if (result.status === 'timeout') {
      throw new ManualTimeoutError(config.id, timeoutMs);
    }
    ctx.log('info', 'manual interaction resolved', { by: result.by ?? 'unknown' });
    return { status: 'ok', output: { by: result.by ?? null } };
  },
});
