/**
 * StepRegistry: maps step types to handlers (spec 5.2).
 *
 * Adding a new step type is a one-line registration here (or in a host); the
 * orchestrator never changes.
 */
import type { Step, StepType } from '../flow/schema.js';
import { RoboError } from '../errors.js';
import type { StepHandler } from './types.js';

/** Outcome of a registry validation pass. */
export interface RegistryValidation {
  ok: boolean;
  issues: Array<{ stepId: string; type: StepType; problems: string[] }>;
}

/**
 * A mutable collection of {@link StepHandler}s.
 */
export class StepRegistry {
  private readonly handlers = new Map<StepType, StepHandler<Step>>();

  /**
   * Register (or replace) a handler.
   *
   * @throws {RoboError} When a handler for the same type already exists, to make
   *   accidental double-registration loud.
   */
  public register<S extends Step>(
    handler: StepHandler<S>,
    options: { replace?: boolean } = {},
  ): this {
    const existing = this.handlers.get(handler.type);
    if (existing && !options.replace) {
      throw new RoboError(
        'INTERNAL_ERROR',
        `Handler already registered for step type "${handler.type}"`,
        {
          type: handler.type,
        },
      );
    }
    this.handlers.set(handler.type, handler as unknown as StepHandler<Step>);
    return this;
  }

  /** Replace an existing handler, or add it when absent. */
  public override<S extends Step>(handler: StepHandler<S>): this {
    return this.register(handler, { replace: true });
  }

  /** Look up a handler, throwing when the type is unknown. */
  public get(type: StepType): StepHandler<Step> {
    const handler = this.handlers.get(type);
    if (!handler) {
      throw new RoboError('NOT_IMPLEMENTED', `No handler registered for step type "${type}"`, {
        type,
      });
    }
    return handler;
  }

  /** True when a handler exists for the type. */
  public has(type: StepType): boolean {
    return this.handlers.has(type);
  }

  /** All registered step types. */
  public types(): StepType[] {
    return [...this.handlers.keys()];
  }

  /**
   * Validate a step using its handler.
   *
   * @returns The list of problems (empty when valid).
   */
  public validateStep(step: Step): string[] {
    if (!this.has(step.type)) return [`No handler registered for step type "${step.type}"`];
    return this.get(step.type).validate(step);
  }

  /**
   * Validate a whole flow's steps (recursively) against registered handlers.
   */
  public validateFlow(steps: readonly Step[]): RegistryValidation {
    const issues: RegistryValidation['issues'] = [];
    const visit = (list: readonly Step[]): void => {
      for (const step of list) {
        const problems = this.validateStep(step);
        if (problems.length > 0) issues.push({ stepId: step.id, type: step.type, problems });
        if (step.type === 'branch') {
          visit(step.then);
          if (step.else) visit(step.else);
        } else if (step.type === 'loop') {
          visit(step.steps);
        }
      }
    };
    visit(steps);
    return { ok: issues.length === 0, issues };
  }
}
