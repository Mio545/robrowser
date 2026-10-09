/**
 * `waitForSelector` step: block until a selector reaches the requested state.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { interpolateConfig, resolveTimeout, selectorLabel } from './helpers.js';

type WaitForSelectorStep = Extract<Step, { type: 'waitForSelector' }>;

/** Handler for `waitForSelector`. */
export const waitForSelectorHandler = defineHandler<WaitForSelectorStep>({
  type: 'waitForSelector',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const selector = interpolateConfig(config.selector, ctx);
    const state = config.state ?? 'visible';
    const timeout = resolveTimeout(config.timeout);
    ctx.log('info', `wait for ${selectorLabel(selector)} (${state})`, { timeout });
    await ctx.page.waitForSelector(selector, { state, timeout });
    return { status: 'ok', output: { state } };
  },
});
