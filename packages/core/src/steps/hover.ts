/**
 * `hover` step: move the mouse over an element (triggers CSS hover menus).
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { interpolateConfig, resolveTimeout, selectorLabel } from './helpers.js';

type HoverStep = Extract<Step, { type: 'hover' }>;

/** Handler for `hover`. */
export const hoverHandler = defineHandler<HoverStep>({
  type: 'hover',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const selector = interpolateConfig(config.selector, ctx);
    ctx.log('info', `hover ${selectorLabel(selector)}`);
    await ctx.page.hover(selector, { timeout: resolveTimeout(undefined) });
    return { status: 'ok' };
  },
});
