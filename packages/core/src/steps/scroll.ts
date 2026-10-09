/**
 * `scroll` step: scroll the viewport to coordinates, or bring an element into view.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { interpolateConfig, resolveTimeout, selectorLabel } from './helpers.js';

type ScrollStep = Extract<Step, { type: 'scroll' }>;

/** Handler for `scroll`. */
export const scrollHandler = defineHandler<ScrollStep>({
  type: 'scroll',
  validate(config) {
    if (config.selector === undefined && config.x === undefined && config.y === undefined) {
      return ['scroll requires either a selector or x/y coordinates'];
    }
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const selector = config.selector ? interpolateConfig(config.selector, ctx) : undefined;
    const label = selector ? selectorLabel(selector) : `(${config.x ?? 0}, ${config.y ?? 0})`;
    ctx.log('info', `scroll to ${label}`);
    await ctx.page.scroll(
      { x: config.x, y: config.y, selector },
      { timeout: resolveTimeout(undefined) },
    );
    return { status: 'ok' };
  },
});
