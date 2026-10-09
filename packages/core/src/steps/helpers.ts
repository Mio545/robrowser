/**
 * Shared helpers used by several step handlers.
 */
import type { StepContext } from '../engine/context.js';
import type { SelectorSpec } from '../flow/schema.js';
import { describeSelector, SelectorNotFoundError, StepTimeoutError } from '../errors.js';
import type { PagePort } from '../engine/ports.js';

/** Default per-step selector timeout. */
export const DEFAULT_SELECTOR_TIMEOUT = 15_000;

/**
 * Interpolate a step's string fields (recursively) using the run variables.
 *
 * @param value - Config value to interpolate.
 * @param ctx - Step context providing the variable store.
 */
export function interpolateConfig<T>(value: T, ctx: StepContext): T {
  return ctx.vars.interpolate(value);
}

/**
 * Wait for a selector to exist and return its handle info.
 *
 * @throws {SelectorNotFoundError} When the element never appears.
 */
export async function resolveSelector(
  page: PagePort,
  selector: SelectorSpec,
  timeout = DEFAULT_SELECTOR_TIMEOUT,
): Promise<NonNullable<Awaited<ReturnType<PagePort['query']>>>> {
  const info = await page.query(selector, { timeout, state: 'attached' });
  if (!info) {
    throw new SelectorNotFoundError(selector);
  }
  return info;
}

/**
 * Run `work` with a timeout, translating a timeout into a {@link StepTimeoutError}.
 */
export async function withStepTimeout<T>(
  stepId: string,
  timeoutMs: number,
  work: Promise<T>,
): Promise<T> {
  if (timeoutMs <= 0) return work;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(stepId, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Normalise a possibly-undefined timeout to the default. */
export function resolveTimeout(
  value: number | undefined,
  fallback = DEFAULT_SELECTOR_TIMEOUT,
): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Human readable selector for log lines. */
export function selectorLabel(selector: SelectorSpec): string {
  return describeSelector(selector);
}

/** True when the run has been aborted; handlers should bail out early. */
export function isAborted(ctx: Pick<StepContext, 'signal'>): boolean {
  return ctx.signal.aborted;
}
