/**
 * `waitForUrl` step: block until the current URL matches a pattern.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { resolveTimeout } from './helpers.js';

type WaitForUrlStep = Extract<Step, { type: 'waitForUrl' }>;

/** Handler for `waitForUrl`. */
export const waitForUrlHandler = defineHandler<WaitForUrlStep>({
  type: 'waitForUrl',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const pattern = ctx.vars.interpolate(config.pattern);
    const timeout = resolveTimeout(config.timeout, 30_000);
    ctx.log('info', `wait for url ~ ${pattern}`, { timeout });
    await ctx.page.waitForUrl(pattern, { timeout });
    const url = await ctx.page.url();
    return { status: 'ok', output: { url } };
  },
});
