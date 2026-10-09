/**
 * `type` step: focus an element, optionally clear it, then send characters.
 *
 * When `submit` is set the step presses Enter after typing, which is the common
 * way login forms are structured.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { interpolateConfig, resolveTimeout, selectorLabel } from './helpers.js';

type TypeStep = Extract<Step, { type: 'type' }>;

/** Handler for `type`. */
export const typeHandler = defineHandler<TypeStep>({
  type: 'type',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const selector = interpolateConfig(config.selector, ctx);
    const value = interpolateConfig(config.value, ctx);
    const clear = config.clear ?? true;
    const timeout = resolveTimeout(undefined);
    ctx.log('info', `type into ${selectorLabel(selector)}`, { length: value.length, clear });
    await ctx.page.type(selector, value, { clear, delayMs: config.delayMs, timeout });
    if (config.submit) {
      ctx.log('debug', 'pressing Enter to submit');
      await ctx.page.key('Enter');
    }
    return { status: 'ok', output: { value, submitted: Boolean(config.submit) } };
  },
});
