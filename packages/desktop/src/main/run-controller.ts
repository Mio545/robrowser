/**
 * Run controller for the desktop host (spec 9).
 *
 * Owns the lifecycle of a single run against the embedded browser:
 * start -> stream typed engine events to the renderer -> stop / manual resolve.
 *
 * The engine code is exactly the same `Orchestrator` the headless server uses,
 * which is the guarantee that a flow behaves identically in both hosts.
 */
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Logger } from 'pino';
import {
  createDefaultRegistry,
  DefaultPageObserver,
  createPageRegistry,
  EventBus,
  Orchestrator,
  VariableStore,
  type FlowModel,
  type RunEvent,
  type RunResult,
} from '@robrowser/core';
import type { CdpPage } from '@robrowser/browser';
import type { LocalManualHandler } from './manual-handler.js';

/** Events emitted by the controller. */
export interface RunControllerEvents {
  event: [RunEvent];
  end: [RunResult];
}

/** Options for {@link RunController}. */
export interface RunControllerOptions {
  logger: Logger;
  page: CdpPage;
  runDir: string;
  manual: LocalManualHandler;
}

/** Runs one flow at a time against the embedded page. */
export class RunController extends EventEmitter {
  private controller: AbortController | undefined;
  private running = false;

  public constructor(private readonly options: RunControllerOptions) {
    super();
  }

  /** True while a flow is executing. */
  public get busy(): boolean {
    return this.running;
  }

  /**
   * Execute a flow to completion.
   *
   * @param flow - Validated flow document.
   * @param vars - Runtime variable overrides (UI inputs / `--var`).
   */
  public async run(flow: FlowModel, vars: Record<string, unknown> = {}): Promise<RunResult> {
    if (this.running) throw new Error('A run is already in progress');
    this.running = true;
    this.controller = new AbortController();

    const runId = `${flow.id}-${Date.now().toString(36)}`;
    const runDir = join(this.options.runDir, runId);
    const bus = new EventBus();
    const variables = new VariableStore();
    await variables.declare(flow.variables, vars);

    const off = bus.onAny((event) => this.emit('event', event));

    try {
      const orchestrator = new Orchestrator({
        page: this.options.page,
        registry: createDefaultRegistry(),
        bus,
        variableStore: variables,
        runDir,
        manual: this.options.manual,
        observer: new DefaultPageObserver(this.options.logger),
        pages: createPageRegistry(),
        logger: {
          debug: (message, data) => this.options.logger.debug(data ?? {}, message),
          info: (message, data) => this.options.logger.info(data ?? {}, message),
          warn: (message, data) => this.options.logger.warn(data ?? {}, message),
          error: (message, data) => this.options.logger.error(data ?? {}, message),
        },
        signal: this.controller.signal,
      });
      const result = await orchestrator.run(flow);
      this.emit('end', result);
      return result;
    } finally {
      off();
      this.running = false;
      this.controller = undefined;
      // Release any manual step still waiting (stop button / crash).
      if (this.options.manual.active) this.options.manual.abort();
    }
  }

  /** Cancel the active run. */
  public stop(): boolean {
    if (!this.controller) return false;
    this.controller.abort();
    return true;
  }
}
