/**
 * `loop` step: iterate a literal array or a variable holding an array, binding
 * each item to `config.as` and running the sub-steps.
 */
import { defineHandler, requireNestedExecutor, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { RoboError } from '../errors.js';

type LoopStep = Extract<Step, { type: 'loop' }>;

/** Handler for `loop`. */
export const loopHandler = defineHandler<LoopStep>({
  type: 'loop',
  validate(config) {
    const problems: string[] = [];
    if (config.as.trim().length === 0) problems.push('as must not be empty');
    if (Array.isArray(config.items) && config.items.length === 0) {
      problems.push('items must not be an empty array');
    }
    return problems;
  },
  async execute(config, ctx): Promise<StepResult> {
    const execute = requireNestedExecutor(ctx);
    const items = resolveItems(config, ctx);
    const max = config.maxIterations ?? 1_000;
    const limit = Math.min(items.length, max);
    ctx.log('info', `looping over ${limit} item(s) as "${config.as}"`, {
      total: items.length,
      maxIterations: max,
    });

    let executed = 0;
    for (let index = 0; index < limit; index += 1) {
      if (ctx.signal.aborted) return { status: 'fail', message: 'run aborted' };
      ctx.vars.set(config.as, items[index], 'runtime');
      ctx.vars.set(`${config.as}Index`, index, 'runtime');
      const outcome = await execute(config.steps, []);
      if (outcome.status === 'fail') {
        return {
          status: 'fail',
          message: outcome.error?.message ?? `loop iteration ${index} failed`,
          output: outcome.error,
        };
      }
      if (outcome.status === 'paused') {
        return { status: 'pause', stopReason: 'paused' };
      }
      executed += outcome.executed;
    }
    return { status: 'ok', output: { iterations: limit, executed } };
  },
});

/** Resolve `config.items` into a concrete array (interpolating string refs). */
function resolveItems(
  config: LoopStep,
  ctx: import('../engine/context.js').StepContext,
): unknown[] {
  if (Array.isArray(config.items)) return config.items;
  const raw = config.items;
  // A string may be either a `{{var}}` template or a bare variable name.
  const interpolated = ctx.vars.interpolate(raw);
  if (interpolated !== raw) {
    return asArray(interpolated, raw);
  }
  const looked = ctx.vars.tryGet(raw);
  return asArray(looked, raw);
}

function asArray(value: unknown, source: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) {
    throw new RoboError(
      'VARIABLE_UNDEFINED',
      `Loop items "${source}" did not resolve to an array`,
      {
        source,
      },
    );
  }
  // Strings are iterable but looping characters is almost never intended.
  throw new RoboError(
    'STEP_FAILED',
    `Loop items "${source}" is not an array (got ${typeof value})`,
    {
      source,
    },
  );
}
