/**
 * `extract` step: read text or an attribute from one or many elements and store
 * the result in a variable (spec 4 `extract`).
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { interpolateConfig, resolveTimeout } from './helpers.js';
import { SelectorNotFoundError } from '../errors.js';

type ExtractStep = Extract<Step, { type: 'extract' }>;

/** Handler for `extract`. */
export const extractHandler = defineHandler<ExtractStep>({
  type: 'extract',
  validate(config) {
    const problems: string[] = [];
    if (config.into.trim().length === 0) problems.push('into must not be empty');
    return problems;
  },
  async execute(config, ctx): Promise<StepResult> {
    const selector = interpolateConfig(config.selector, ctx);
    const attr = config.attr ? ctx.vars.interpolate(config.attr) : undefined;
    const all = config.all ?? false;
    const timeout = resolveTimeout(undefined);

    // `state: 'attached'` mirrors Playwright's default extract semantics: the
    // element must exist, visibility is not required.
    await ctx.page.waitForSelector(selector, { state: 'attached', timeout });

    // The page port exposes `readAll` so the single/all code paths stay in the
    // browser package, where selector resolution already lives.
    const values = await ctx.page.readAll(selector, attr);
    if (values.length === 0) throw new SelectorNotFoundError(selector);

    const value: unknown = all ? values : (values[0] ?? null);
    ctx.vars.set(config.into, value, 'runtime');
    ctx.bus.emit('var:set', {
      runId: ctx.runId,
      name: config.into,
      value,
      scope: 'runtime',
      timestamp: Date.now(),
    });
    ctx.log(
      'info',
      `extracted ${Array.isArray(value) ? value.length : 1} value(s) into "${config.into}"`,
    );
    return { status: 'ok', output: value };
  },
});
