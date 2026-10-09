/**
 * `setVar` step: assign a literal or interpolated value to a variable.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';

type SetVarStep = Extract<Step, { type: 'setVar' }>;

/** Handler for `setVar`. */
export const setVarHandler = defineHandler<SetVarStep>({
  type: 'setVar',
  validate(config) {
    return config.name.trim().length === 0 ? ['name must not be empty'] : [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const value = ctx.vars.interpolate(config.value);
    ctx.vars.set(config.name, value, 'runtime');
    ctx.bus.emit('var:set', {
      runId: ctx.runId,
      name: config.name,
      value,
      scope: 'runtime',
      timestamp: Date.now(),
    });
    ctx.log('debug', `set variable "${config.name}"`);
    return { status: 'ok', output: value };
  },
});
