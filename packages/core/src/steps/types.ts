/**
 * Step handler contract (spec 5.2).
 *
 * Every step type is implemented as a {@link StepHandler} registered in the
 * {@link StepRegistry}. The orchestrator never switches on `step.type`; it only
 * asks the registry for the handler, which keeps the engine open for extension.
 */
import type { Step, StepType } from '../flow/schema.js';
import type { StepContext } from '../engine/context.js';
import type { RunStopReason } from '../events/bus.js';

/** Outcome of a single handler invocation. */
export type StepStatus = 'ok' | 'skip' | 'jump' | 'fail' | 'pause';

/** Result returned by {@link StepHandler.execute}. */
export interface StepResult {
  status: StepStatus;
  /** Value produced by the step (e.g. extracted text, download path). */
  output?: unknown;
  /** For `status: 'jump'`: the id of the step to continue from. */
  jumpTo?: string;
  /** For `status: 'skip'` / `'fail'`: human readable reason. */
  message?: string;
  /** For `status: 'pause'`: why the run stopped. */
  stopReason?: RunStopReason;
}

/**
 * A handler for one step type.
 *
 * `S` is narrowed so that `config` is fully typed inside `execute`.
 */
export interface StepHandler<S extends Step = Step> {
  /** The discriminated union tag this handler implements. */
  readonly type: S['type'];
  /**
   * Validate the step-specific configuration.
   *
   * @returns A list of human readable problems; empty means valid.
   */
  validate(config: S): string[];
  /**
   * Execute the step.
   *
   * Handlers must be cooperative: check `ctx.signal.aborted` between awaits and
   * never swallow an abort.
   */
  execute(config: S, ctx: StepContext): Promise<StepResult>;
}

/** Convenience helper to declare a handler with a narrowed step type. */
export function defineHandler<S extends Step>(
  handler: Omit<StepHandler<S>, 'type'> & { type: StepType },
): StepHandler<S> {
  return handler as StepHandler<S>;
}

/**
 * Context extension used by the `branch` / `loop` handlers: the orchestrator
 * attaches a nested executor so composite steps can run sub-lists without
 * importing the orchestrator (avoiding a circular dependency).
 */
export interface CompositeStepContext extends StepContext {
  /** Execute a nested list of steps; `path` tracks the nesting position. */
  executeSteps?: (
    steps: readonly Step[],
    path: number[],
  ) => Promise<import('../engine/orchestrator.js').StepRunOutcome>;
}

/** Retrieve the composite executor from a context, throwing when absent. */
export function requireNestedExecutor(
  ctx: StepContext,
): NonNullable<CompositeStepContext['executeSteps']> {
  const executor = (ctx as CompositeStepContext).executeSteps;
  if (!executor) {
    throw new Error('Nested step execution is unavailable in this context');
  }
  return executor;
}
