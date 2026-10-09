/**
 * `click` step: click the first matching selector candidate.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { interpolateConfig, resolveTimeout, selectorLabel } from './helpers.js';
import { SelectorNotFoundError } from '../errors.js';

type ClickStep = Extract<Step, { type: 'click' }>;

/** Handler for `click`. */
export const clickHandler = defineHandler<ClickStep>({
  type: 'click',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const selector = interpolateConfig(config.selector, ctx);
    const button = config.button ?? 'left';
    const clickCount = config.clickCount ?? 1;
    const timeout = resolveTimeout(undefined);
    ctx.log('info', `click ${selectorLabel(selector)}`, { button, clickCount });
    try {
      await ctx.page.click(selector, { button, clickCount, timeout });
    } catch (error) {
      if (error instanceof SelectorNotFoundError) throw error;
      throw new SelectorNotFoundError(
        selector,
        `Failed to click ${selectorLabel(selector)}: ${(error as Error).message}`,
      );
    }
    return { status: 'ok', output: { selector } };
  },
});
