/**
 * `waitForPage` step: block until a named page fingerprint matches.
 *
 * The named rule is resolved through the host supplied page registry so that
 * fingerprints can live outside the flow (host level reuse).
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { resolveTimeout } from './helpers.js';
import { RoboError } from '../errors.js';

type WaitForPageStep = Extract<Step, { type: 'waitForPage' }>;

/** Handler for `waitForPage`. */
export const waitForPageHandler = defineHandler<WaitForPageStep>({
  type: 'waitForPage',
  validate(config) {
    return config.target.trim().length === 0 ? ['target must not be empty'] : [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const target = ctx.vars.interpolate(config.target);
    const timeout = resolveTimeout(config.timeout, 30_000);
    const rule = await ctx.pages.get(target);
    if (!rule) {
      throw new RoboError('STEP_FAILED', `Unknown page fingerprint "${target}"`, {
        stepId: config.id,
        target,
        known: ctx.pages.names(),
      });
    }
    ctx.log('info', `waiting for page "${target}"`, { timeout });
    const result = await ctx.observer.waitForPage(ctx.page, rule, {
      timeout,
      pollIntervalMs: 200,
    });
    ctx.log('debug', 'page matched', {
      target,
      details: result.details.map((d) => d.reason),
    });
    return { status: 'ok', output: { target } };
  },
});
