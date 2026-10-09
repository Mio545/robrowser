/**
 * The orchestrator (spec 5.1): executes a FlowModel step by step.
 *
 * Design notes
 * - No `switch (step.type)`: handlers are looked up in the {@link StepRegistry}.
 * - `branch` / `loop` are ordinary handlers that receive a nested executor, so
 *   nesting works to arbitrary depth without special-casing in this file.
 * - Retries honour `flow.onError` (flow level) merged with the step's own
 *   `retry` override where present.
 */
import type { FlowModel, Step } from '../flow/schema.js';
import { EventBus, summarizeStep } from '../events/bus.js';
import type { RunStopReason } from '../events/bus.js';
import type { LoggerPort, PagePort } from './ports.js';
import { nullLogger } from './ports.js';
import type { ManualHandler } from '../handlers/manual.js';
import type { PageObserver } from '../observer/observer.js';
import { DefaultPageObserver } from '../observer/observer.js';
import { VariableStore } from '../vars/store.js';
import { createConditionEvaluator } from './condition.js';
import { writeCheckpoint, clearCheckpoint, type Checkpoint } from './checkpoint.js';
import { StepRegistry } from '../steps/registry.js';
import type { StepResult } from '../steps/types.js';
import { createDefaultRegistry } from '../steps/index.js';
import { RoboError, RunAbortedError, StepTimeoutError, toRoboError } from '../errors.js';
import type { PageRegistry, RunArtifacts } from './context.js';
import { createRunArtifacts } from './artifacts.js';
import { sleep as sleepUtil } from './timing.js';

/** Dependency bag for {@link Orchestrator.run}. */
export interface OrchestratorDeps {
  /** Active page (already navigated or blank). */
  page: PagePort;
  /** Registry of step handlers; defaults to the built-in registry. */
  registry?: StepRegistry;
  /** Typed event bus. */
  bus?: EventBus;
  /** Variable store; created empty when omitted. */
  variableStore?: VariableStore;
  /** Directory for artefacts / checkpoint. */
  runDir: string;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Manual interaction handler. */
  manual: ManualHandler;
  /** Page observer; defaults to {@link DefaultPageObserver}. */
  observer?: PageObserver;
  /** Named page registry. */
  pages?: PageRegistry;
  /** Structured logger. */
  logger?: LoggerPort;
}

/** Outcome of executing a list of steps. */
export interface StepRunOutcome {
  status: 'ok' | 'fail' | 'paused' | 'jumped';
  /** Number of steps executed (including nested). */
  executed: number;
  /** Id of the step that failed, when `status === 'fail'`. */
  failedStepId?: string;
  /** Error raised, when `status === 'fail'`. */
  error?: RoboError;
  /** Resume path when `status === 'paused'`. */
  path?: number[];
}

/** Final result of {@link Orchestrator.run}. */
export interface RunResult {
  runId: string;
  flowId: string;
  flowName: string;
  status: 'success' | 'failed' | 'aborted';
  reason: RunStopReason;
  /** Total steps executed, including nested ones. */
  stepCount: number;
  durationMs: number;
  artifacts: string[];
  error?: { code: string; message: string };
  variables: Record<string, unknown>;
  startedAt: string;
  finishedAt: string;
}

/** Options for {@link Orchestrator.run}. */
export interface RunOptions {
  /** Resume from a previous checkpoint (skip already-completed steps). */
  resumeFrom?: Checkpoint;
}

/** Empty page registry used when the host supplies none. */
const emptyPageRegistry: PageRegistry = {
  get: () => null,
  names: () => [],
};

/**
 * Recover the original {@link RoboError} from a failed {@link StepResult}.
 *
 * xecuteStep stores the typed error on output so that the stable error code
 * (STEP_TIMEOUT, SELECTOR_NOT_FOUND, …) survives the trip through the generic
 * status/message result contract. Handlers that return fail directly may
 * instead supply an output payload — in that case we fall back to the message.
 */
function resolveStepError(result: StepResult): RoboError {
  if (result.output instanceof RoboError) return result.output;
  return toRoboError(result.message ?? 'step failed', 'STEP_FAILED');
}

/**
 * Executes a FlowModel against a page.
 *
 * The orchestrator is safe to reuse serially; a host that runs flows in parallel
 * must create one orchestrator per run.
 */
export class Orchestrator {
  private readonly registry: StepRegistry;
  private readonly bus: EventBus;
  private readonly observer: PageObserver;
  private readonly logger: LoggerPort;
  private readonly vars: VariableStore;
  private readonly pages: PageRegistry;
  private readonly signal: AbortSignal | undefined;
  private readonly artifacts: RunArtifacts;
  private runId = '';
  private flow: FlowModel | undefined;
  private executed = 0;
  private abortHandler: (() => void) | undefined;

  public constructor(private readonly deps: OrchestratorDeps) {
    this.registry = deps.registry ?? createDefaultRegistry();
    this.bus = deps.bus ?? new EventBus();
    this.logger = deps.logger ?? nullLogger;
    this.observer = deps.observer ?? new DefaultPageObserver(this.logger);
    this.vars = deps.variableStore ?? new VariableStore();
    this.pages = deps.pages ?? emptyPageRegistry;
    this.signal = deps.signal;
    this.artifacts = createRunArtifacts(deps.runDir);
  }

  /** The event bus in use (hosts subscribe before calling {@link run}). */
  public get events(): EventBus {
    return this.bus;
  }

  /** The variable store in use. */
  public get variables(): VariableStore {
    return this.vars;
  }

  /**
   * Execute a flow to completion.
   *
   * @param flow - The validated flow definition.
   * @param options - Resume configuration.
   * @returns A structured {@link RunResult}.
   */
  public async run(flow: FlowModel, options: RunOptions = {}): Promise<RunResult> {
    const startedAt = new Date();
    this.flow = flow;
    this.runId = `${flow.id}-${startedAt.getTime().toString(36)}`;
    this.executed = 0;

    this.bus.emit('run:start', {
      runId: this.runId,
      flowId: flow.id,
      flowName: flow.name,
      timestamp: Date.now(),
      status: 'running',
    });
    this.logger.info('run started', { runId: this.runId, flowId: flow.id });

    let status: RunResult['status'] = 'success';
    let reason: RunStopReason = 'completed';
    let error: RoboError | undefined;

    this.registerAbortHandler();

    try {
      const outcome = await this.executeSteps(flow.steps, [], options.resumeFrom);
      if (outcome.status === 'fail') {
        // An aborted run is a distinct terminal state, not a generic failure.
        const aborted = outcome.error?.code === 'RUN_ABORTED';
        status = aborted ? 'aborted' : 'failed';
        reason = aborted ? 'aborted' : 'error';
        error = outcome.error;
      } else if (outcome.status === 'paused') {
        // A paused run is reported as a failure with a dedicated reason so that
        // the caller can choose to resume from the checkpoint.
        status = 'failed';
        reason = 'paused';
      }
      this.executed = outcome.executed;
    } catch (thrown) {
      const robo = toRoboError(thrown);
      if (robo instanceof RunAbortedError || this.signal?.aborted) {
        status = 'aborted';
        reason = 'aborted';
      } else {
        status = 'failed';
        reason = 'error';
      }
      error = robo;
    } finally {
      this.unregisterAbortHandler();
    }

    if (status === 'success') {
      await clearCheckpoint(this.deps.runDir).catch(() => undefined);
    }

    const finishedAt = new Date();
    const result: RunResult = {
      runId: this.runId,
      flowId: flow.id,
      flowName: flow.name,
      status,
      reason,
      stepCount: this.executed,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      artifacts: this.artifacts.list(),
      ...(error ? { error: { code: error.code, message: error.message } } : {}),
      variables: this.variablesSnapshot(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };

    const lifecycle = {
      runId: this.runId,
      flowId: flow.id,
      flowName: flow.name,
      timestamp: Date.now(),
      status:
        result.status === 'failed' && reason === 'error' ? ('failed' as const) : result.status,
      reason,
      durationMs: result.durationMs,
      stepCount: result.stepCount,
    };
    if (status === 'aborted') this.bus.emit('run:aborted', lifecycle);
    this.bus.emit('run:end', lifecycle);
    this.logger.info('run finished', {
      runId: this.runId,
      status: result.status,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Execute a list of steps in order. Exposed to nested handlers (`branch`,
   * `loop`) through the injected context.
   */
  public async executeSteps(
    steps: readonly Step[],
    parentPath: number[],
    resumeFrom?: Checkpoint,
  ): Promise<StepRunOutcome> {
    let index = 0;
    let executed = 0;

    if (resumeFrom && parentPath.length === 0) {
      // Only the top-level list honours the resume pointer directly; nested
      // lists are re-entered by their parent handler on resume.
      index = this.resolveResumeIndex(steps, resumeFrom);
    }

    while (index < steps.length) {
      if (this.signal?.aborted) {
        return { status: 'fail', executed, error: new RunAbortedError(this.runId) };
      }
      const step = steps[index];
      if (!step) break;
      const path = [...parentPath, index];

      const result = await this.executeStep(step, index, path);

      if (result.status === 'fail') {
        return { status: 'fail', executed, failedStepId: step.id, error: resolveStepError(result) };
      }
      if (result.status === 'pause') {
        return { status: 'paused', executed, failedStepId: step.id, path };
      }
      if (result.status === 'jump' && result.jumpTo) {
        const target = steps.findIndex((candidate) => candidate.id === result.jumpTo);
        if (target >= 0) {
          index = target;
          continue;
        }
        const error = new RoboError('STEP_FAILED', `jumpTo target "${result.jumpTo}" not found`, {
          stepId: step.id,
        });
        this.emitStepFail(step, index, 1, false, error, 0);
        return { status: 'fail', executed, failedStepId: step.id, error };
      }
      if (result.status === 'ok' || result.status === 'skip') {
        executed += this.countExecuted(result);
      }
      index += 1;
    }

    return { status: 'ok', executed };
  }

  /**
   * Execute a single step with retry / backoff / timeout and event emission.
   */
  private async executeStep(step: Step, index: number, path: number[]): Promise<StepResult> {
    const handler = this.registry.get(step.type);
    const totalSteps = this.flow?.steps.length ?? 0;

    const startTs = Date.now();
    this.bus.emit('step:start', {
      runId: this.runId,
      stepId: step.id,
      stepType: step.type,
      index,
      total: totalSteps,
      summary: summarizeStep(step),
      timestamp: startTs,
    });

    const attempts = this.resolveAttempts(step);
    let lastError: RoboError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const attemptStart = Date.now();
      try {
        const result = await this.withTimeout(
          handler.execute(step, await this.buildContext(step, index, path)),
          this.resolveStepTimeout(step),
          step.id,
        );
        const durationMs = Date.now() - attemptStart;
        this.applyResultEvents(step, index, result, durationMs);
        if (result.status === 'ok' || result.status === 'skip') {
          await this.persistCheckpoint(step, index, path);
          if (result.status === 'ok' && result.output !== undefined) {
            this.bus.emit('step:ok', {
              runId: this.runId,
              stepId: step.id,
              stepType: step.type,
              durationMs,
              output: result.output,
              timestamp: Date.now(),
            });
          }
        }
        return result;
      } catch (thrown) {
        const error = toRoboError(thrown);
        lastError = error;
        const willRetry = attempt < attempts;
        this.emitStepFail(step, index, attempt, willRetry, error, Date.now() - attemptStart);
        this.logger.warn('step failed', {
          runId: this.runId,
          stepId: step.id,
          attempt,
          attempts,
          code: error.code,
          message: error.message,
        });
        if (!willRetry) break;
        await this.backoff(attempt);
      }
    }

    const failure = lastError ?? new RoboError('STEP_FAILED', `Step "${step.id}" failed`);
    if (this.flow?.onError?.screenshot) {
      await this.captureFailureScreenshot(step).catch(() => undefined);
    }
    return { status: 'fail', message: failure.message, output: failure };
  }

  /** Build the per-step context object. */
  private async buildContext(
    step: Step,
    index: number,
    path: number[],
  ): Promise<import('./context.js').StepContext> {
    const evaluate = createConditionEvaluator({
      page: this.deps.page,
      vars: this.vars,
      pages: this.pages,
    });

    const ctx: import('./context.js').StepContext = {
      runId: this.runId,
      flowId: this.flow?.id ?? 'unknown',
      stepId: step.id,
      index,
      page: this.deps.page,
      vars: this.vars,
      bus: this.bus,
      signal: this.signal ?? new AbortController().signal,
      manual: this.deps.manual,
      observer: this.observer,
      pages: this.pages,
      evaluate,
      artifacts: this.artifacts,
      logger: this.logger,
      log: (level, message, data) => {
        this.bus.emit('log', {
          runId: this.runId,
          level,
          message,
          stepId: step.id,
          ...(data ? { data } : {}),
          timestamp: Date.now(),
        });
      },
      emitScreenshot: (payload) => {
        this.bus.emit('screenshot', {
          runId: this.runId,
          stepId: step.id,
          ...payload,
          timestamp: Date.now(),
        });
      },
      sleep: (ms) => sleepUtil(ms, this.signal),
    };

    // Nested step execution support for branch/loop handlers.
    (ctx as { executeSteps?: unknown }).executeSteps = (
      steps: readonly Step[],
      childPath: number[],
    ): Promise<StepRunOutcome> => this.executeSteps(steps, childPath);

    // `path` is currently only used for checkpointing / future resume.
    void path;
    return ctx;
  }

  private applyResultEvents(
    step: Step,
    index: number,
    result: StepResult,
    durationMs: number,
  ): void {
    if (result.status === 'skip') {
      this.bus.emit('step:skip', {
        runId: this.runId,
        stepId: step.id,
        stepType: step.type,
        reason: result.message ?? 'skipped',
        timestamp: Date.now(),
      });
    } else if (result.status === 'ok') {
      if (result.output === undefined) {
        this.bus.emit('step:ok', {
          runId: this.runId,
          stepId: step.id,
          stepType: step.type,
          durationMs,
          timestamp: Date.now(),
        });
      }
    }
    void index;
  }

  private emitStepFail(
    step: Step,
    index: number,
    attempt: number,
    willRetry: boolean,
    error: RoboError,
    durationMs: number,
  ): void {
    this.bus.emit('step:fail', {
      runId: this.runId,
      stepId: step.id,
      stepType: step.type,
      durationMs,
      code: error.code,
      message: error.message,
      attempt,
      willRetry,
      timestamp: Date.now(),
    });
    void index;
  }

  private async persistCheckpoint(step: Step, index: number, path: number[]): Promise<void> {
    const checkpoint: Checkpoint = {
      version: 1,
      runId: this.runId,
      flowId: this.flow?.id ?? 'unknown',
      path,
      stepId: step.id,
      completed: this.executed,
      variables: this.variablesSnapshot(),
      updatedAt: new Date().toISOString(),
    };
    try {
      const file = await writeCheckpoint(this.deps.runDir, checkpoint);
      this.bus.emit('checkpoint', {
        runId: this.runId,
        stepId: step.id,
        index,
        path: file,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.warn('failed to write checkpoint', { error: String(error) });
    }
  }

  private variablesSnapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(this.vars.snapshot({ redactSecrets: true }))) {
      out[name] = entry.value;
    }
    return out;
  }

  private resolveResumeIndex(steps: readonly Step[], checkpoint: Checkpoint): number {
    if (!checkpoint.stepId) return 0;
    const found = steps.findIndex((step) => step.id === checkpoint.stepId);
    if (found < 0) return 0;
    // Resume *after* the last completed step.
    return found + 1;
  }

  private resolveAttempts(step: Step): number {
    const flowRetry = this.flow?.onError?.retry ?? 0;
    const stepRetry = (step as { retry?: unknown }).retry;
    const retry = typeof stepRetry === 'number' ? stepRetry : flowRetry;
    return Math.max(1, retry + 1);
  }

  private resolveStepTimeout(step: Step): number {
    const candidate = (step as { timeout?: unknown; timeoutMs?: unknown }).timeout;
    const timeoutMs = (step as { timeoutMs?: unknown }).timeoutMs;
    if (typeof candidate === 'number' && candidate > 0) return candidate;
    if (step.type === 'manual' && typeof timeoutMs === 'number' && timeoutMs > 0) {
      // `manual` manages its own budget; give the orchestrator extra slack.
      return timeoutMs + 5_000;
    }
    return DEFAULT_STEP_TIMEOUT;
  }

  private async backoff(attempt: number): Promise<void> {
    const policy = this.flow?.onError?.backoff ?? 'none';
    if (policy === 'none') return;
    const base = 250;
    const delay = policy === 'linear' ? base * attempt : base * 2 ** (attempt - 1);
    await sleepUtil(Math.min(delay, 30_000), this.signal);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, stepId: string): Promise<T> {
    if (timeoutMs <= 0) return promise;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new StepTimeoutError(stepId, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async captureFailureScreenshot(step: Step): Promise<void> {
    const buffer = await this.deps.page.screenshot({ format: 'png' });
    const path = await this.artifacts.save(`${step.id}-failure.png`, buffer);
    this.bus.emit('screenshot', {
      runId: this.runId,
      stepId: step.id,
      path,
      timestamp: Date.now(),
    });
  }

  private countExecuted(result: StepResult): number {
    if (result.status === 'ok' && typeof result.output === 'object' && result.output !== null) {
      const nested = (result.output as { executed?: unknown }).executed;
      if (typeof nested === 'number') return nested + 1;
    }
    return 1;
  }

  private registerAbortHandler(): void {
    if (!this.signal) return;
    this.abortHandler = (): void => {
      this.logger.warn('run aborted by signal', { runId: this.runId });
    };
    this.signal.addEventListener('abort', this.abortHandler, { once: true });
  }

  private unregisterAbortHandler(): void {
    if (this.signal && this.abortHandler) {
      this.signal.removeEventListener('abort', this.abortHandler);
    }
    this.abortHandler = undefined;
  }
}

const DEFAULT_STEP_TIMEOUT = 60_000;
