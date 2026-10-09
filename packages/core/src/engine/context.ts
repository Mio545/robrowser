/**
 * Per-run execution context handed to every step handler.
 *
 * The context is the *only* way handlers talk to the outside world, which keeps
 * them unit-testable (hosts inject fake pages / handlers) and host agnostic.
 */
import type { PagePort, LoggerPort } from './ports.js';
import type { EventBus } from '../events/bus.js';
import type { VariableStore } from '../vars/store.js';
import type { ManualHandler } from '../handlers/manual.js';
import type { PageObserver } from '../observer/observer.js';
import type { ConditionEvaluator } from './condition.js';

/** Resolves a page fingerprint name into a PageRule (host supplied registry). */
export interface PageRegistry {
  /** Look up a named page rule; undefined when unknown. */
  get(
    name: string,
  ):
    | Promise<import('../flow/schema.js').PageRule | null>
    | import('../flow/schema.js').PageRule
    | null;
  /** Names known to the registry (used in error messages). */
  names(): string[];
}

/** Downloads / artefacts raised during a run. */
export interface RunArtifacts {
  /** Directory for screenshots, downloads and checkpoints. */
  readonly runDir: string;
  /** Persist a buffer into the run directory, returning the absolute path. */
  save(filename: string, data: Buffer | string): Promise<string>;
  /** Record an artefact path so the RunResult can report it. */
  add(path: string): void;
  /** All artefacts recorded so far. */
  list(): string[];
}

/** The context object passed to {@link StepHandler.execute}. */
export interface StepContext {
  readonly runId: string;
  readonly flowId: string;
  /** The step currently executing. */
  readonly stepId: string;
  /** Zero-based index of this step within its immediate step list. */
  readonly index: number;
  /** The active page. */
  readonly page: PagePort;
  /** Flow variables with interpolation. */
  readonly vars: VariableStore;
  /** Typed event bus for progress reporting. */
  readonly bus: EventBus;
  /** Cancellation signal for the whole run. */
  readonly signal: AbortSignal;
  /** Host supplied manual-interaction handler. */
  readonly manual: ManualHandler;
  /** Page fingerprint observer. */
  readonly observer: PageObserver;
  /** Named page registry backing `waitForPage` / `pageIs`. */
  readonly pages: PageRegistry;
  /** Condition evaluator used by `branch`. */
  readonly evaluate: ConditionEvaluator;
  /** Run artefacts helper. */
  readonly artifacts: RunArtifacts;
  /** Structured logger. */
  readonly logger: LoggerPort;
  /** Emit a log line associated with the current step. */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>,
  ): void;
  /** Emit a `screenshot` event (used by the screenshot handler). */
  emitScreenshot(payload: { path?: string; base64?: string }): void;
  /** Await a cancellable timeout; rejects with an abort error when cancelled. */
  sleep(ms: number): Promise<void>;
}
