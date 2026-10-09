/**
 * `goto` step: navigate to a URL and wait for the requested lifecycle event.
 */
import { defineHandler, type StepResult } from './types.js';
import type { GotoStep } from '../flow/schema.js';
import { interpolateConfig, withStepTimeout } from './helpers.js';
import { RoboError } from '../errors.js';
import { resolveNavigationUrl } from '../flow/url.js';

/** Handler for `goto`. */
export const gotoHandler = defineHandler<GotoStep>({
  type: 'goto',
  validate(config) {
    const problems: string[] = [];
    if (!config.url || config.url.trim().length === 0) problems.push('url must not be empty');
    return problems;
  },
  async execute(config, ctx): Promise<StepResult> {
    const url = resolveNavigationUrl(interpolateConfig(config.url, ctx));
    const waitUntil = config.waitUntil ?? 'load';
    ctx.log('info', `navigating to ${url}`, { waitUntil });
    try {
      await withStepTimeout(config.id, 60_000, ctx.page.goto(url, { waitUntil, timeout: 60_000 }));
    } catch (error) {
      throw new RoboError(
        'NAVIGATION_FAILED',
        `Failed to navigate to ${url}: ${(error as Error).message}`,
        { url, stepId: config.id },
        { cause: error },
      );
    }
    const finalUrl = await ctx.page.url();
    ctx.log('debug', 'navigation complete', { url: finalUrl });
    return { status: 'ok', output: { url: finalUrl } };
  },
});
