/**
 * `select` step: choose an option by value (native `<select>`).
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { interpolateConfig, resolveTimeout, selectorLabel } from './helpers.js';

type SelectStep = Extract<Step, { type: 'select' }>;

/** Handler for `select`. */
export const selectHandler = defineHandler<SelectStep>({
  type: 'select',
  validate(config) {
    return config.value.length === 0 ? ['value must not be empty'] : [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const selector = interpolateConfig(config.selector, ctx);
    const value = interpolateConfig(config.value, ctx);
    ctx.log('info', `select "${value}" on ${selectorLabel(selector)}`);
    await ctx.page.selectOption(selector, value, { timeout: resolveTimeout(undefined) });
    return { status: 'ok', output: { value } };
  },
});
