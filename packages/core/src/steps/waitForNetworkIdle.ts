/**
 * `waitForNetworkIdle` step: block until the network is quiet for `idleMs`.
 */
import { defineHandler, type StepResult } from './types.js';
import type { Step } from '../flow/schema.js';
import { resolveTimeout } from './helpers.js';

type WaitForNetworkIdleStep = Extract<Step, { type: 'waitForNetworkIdle' }>;

/** Handler for `waitForNetworkIdle`. */
export const waitForNetworkIdleHandler = defineHandler<WaitForNetworkIdleStep>({
  type: 'waitForNetworkIdle',
  validate() {
    return [];
  },
  async execute(config, ctx): Promise<StepResult> {
    const idleMs = config.idleMs ?? 500;
    const timeout = resolveTimeout(config.timeout, 30_000);
    ctx.log('info', `wait for network idle (${idleMs}ms)`, { timeout });
    await ctx.page.waitForNetworkIdle({ idleMs, timeout });
    return { status: 'ok' };
  },
});
