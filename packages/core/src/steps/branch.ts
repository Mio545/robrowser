/**
 * `branch` step: evaluate a condition and run the `then` or `else` sub-list.
 *
 * Sub-steps execute through the nested executor injected by the orchestrator,
 * so nested branches / loops work without special casing here.
 */
import { defineHandler, requireNestedExecutor, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';

type BranchStep = Extract<Step, { type: 'branch' }>;

/** Handler for `branch`. */
export const branchHandler = defineHandler<BranchStep>({
  type: 'branch',
  validate(config) {
    const problems: string[] = [];
    if (!config.condition) problems.push('condition is required');
    return problems;
  },
  async execute(config, ctx): Promise<StepResult> {
    const execute = requireNestedExecutor(ctx);
    const matched = await ctx.evaluate(config.condition);
    const branch = matched ? config.then : (config.else ?? []);
    ctx.log('info', `branch condition ${matched ? 'matched' : 'did not match'}`, {
      taking: matched ? 'then' : 'else',
      steps: branch.length,
    });
    const outcome = await execute(branch, []);
    if (outcome.status === 'fail') {
      return {
        status: 'fail',
        message: outcome.error?.message ?? 'branch sub-step failed',
        output: outcome.error,
      };
    }
    if (outcome.status === 'paused') {
      return { status: 'pause', stopReason: 'paused' };
    }
    return { status: 'ok', output: { matched, executed: outcome.executed } };
  },
});
