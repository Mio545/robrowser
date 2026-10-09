/**
 * SQLite-backed task queue with concurrency, retries and timeouts
 * (spec 7.3).
 *
 * The queue itself is process local (in-process scheduler) but the *state* is
 * durable: tasks survive a restart, and `failOrphanedTasks` marks anything that
 * was running when the process died.
 */
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { FlowModel, RunResult } from '@robrowser/core';
import { toRoboError } from '@robrowser/core';
import type { SqliteStorage, TaskRow } from './storage.js';

/** A task executor: runs one flow and resolves with its result. */
export type TaskExecutor = (task: TaskRow, signal: AbortSignal) => Promise<RunResult>;

/** Options for {@link TaskQueue}. */
export interface TaskQueueOptions {
  storage: SqliteStorage;
  logger: Logger;
  /** Maximum number of tasks executing at once. */
  concurrency: number;
  /** Wall-clock budget per attempt. */
  timeoutMs: number;
  /** Default retry budget stored on the task. */
  maxAttempts: number;
  /** Delay between retries (ms). */
  retryDelayMs?: number;
}

/** Events emitted by the queue (used by the HTTP layer for progress). */
export interface TaskQueueEvents {
  'task:start': [TaskRow];
  'task:success': [TaskRow, RunResult];
  'task:failed': [TaskRow, { code: string; message: string }];
  'task:retry': [TaskRow, { code: string; message: string }];
}

/**
 * Durable, concurrency-limited task queue.
 *
 * Usage: construct, `setExecutor(executor)`, then `start()`.
 */
export class TaskQueue extends EventEmitter {
  private executor: TaskExecutor | undefined;
  private running = false;
  private active = 0;
  private pumpScheduled = false;
  private readonly controllers = new Map<string, AbortController>();

  public constructor(private readonly options: TaskQueueOptions) {
    super();
  }

  /** Number of tasks currently executing. */
  public activeCount(): number {
    return this.active;
  }

  /** Register the executor used to run tasks. */
  public setExecutor(executor: TaskExecutor): void {
    this.executor = executor;
  }

  /**
   * Enqueue a flow for execution.
   *
   * @returns The created task row.
   */
  public enqueue(flow: FlowModel, vars: Record<string, unknown> = {}): TaskRow {
    const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const task = this.options.storage.insertTask({
      id,
      flowId: flow.id,
      flow,
      vars,
      maxAttempts: this.options.maxAttempts,
    });
    this.options.logger.info({ taskId: id, flowId: flow.id }, 'task enqueued');
    this.schedule();
    return task;
  }

  /** Start the pump (also resumes any queued tasks from a previous process). */
  public start(): void {
    this.running = true;
    this.schedule();
  }

  /** Stop the pump; running tasks are aborted. */
  public async stop(): Promise<void> {
    this.running = false;
    for (const [taskId, controller] of this.controllers) {
      this.options.logger.warn({ taskId }, 'aborting task on shutdown');
      controller.abort();
    }
    // Give aborts a moment to settle so their state is persisted.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /** Cancel a queued or running task by id. */
  public cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    const task = this.options.storage.getTask(taskId);
    if (task?.status === 'queued') {
      this.options.storage.updateTask(taskId, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }

  /** Trigger a scheduling pass (safe to call repeatedly). */
  private schedule(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (!this.running || !this.executor) return;
    while (this.active < this.options.concurrency) {
      const task = this.options.storage.claimNextTask();
      if (!task) break;
      this.active += 1;
      void this.runTask(task).finally(() => {
        this.active -= 1;
        this.schedule();
      });
    }
  }

  private async runTask(task: TaskRow): Promise<void> {
    const executor = this.executor;
    if (!executor) return;

    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.emit('task:start', task);
    this.options.logger.info({ taskId: task.id, attempt: task.attempts }, 'task started');

    const timer = setTimeout(() => {
      this.options.logger.warn({ taskId: task.id }, 'task timed out; aborting');
      controller.abort();
    }, this.options.timeoutMs);

    try {
      const result = await executor(task, controller.signal);
      clearTimeout(timer);

      if (result.status === 'success') {
        this.options.storage.updateTask(task.id, {
          status: 'succeeded',
          runId: result.runId,
          finishedAt: result.finishedAt,
        });
        this.emit('task:success', task, result);
        this.options.logger.info({ taskId: task.id, runId: result.runId }, 'task succeeded');
        return;
      }
      throw Object.assign(new Error(result.error?.message ?? 'flow failed'), {
        code: result.error?.code ?? 'STEP_FAILED',
      });
    } catch (thrown) {
      clearTimeout(timer);
      const error = toRoboError(thrown);
      const failedTask = this.options.storage.getTask(task.id);

      if (failedTask && failedTask.attempts < failedTask.maxAttempts) {
        this.options.storage.requeueTask(task.id, { code: error.code, message: error.message });
        this.emit('task:retry', failedTask, { code: error.code, message: error.message });
        this.options.logger.warn(
          { taskId: task.id, attempt: failedTask.attempts, code: error.code },
          'task failed; scheduling retry',
        );
        await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 500));
        return;
      }

      this.options.storage.updateTask(task.id, {
        status: 'failed',
        errorCode: error.code,
        errorMessage: error.message,
        finishedAt: new Date().toISOString(),
      });
      this.emit('task:failed', task, { code: error.code, message: error.message });
      this.options.logger.error(
        { taskId: task.id, code: error.code, err: error.message },
        'task failed',
      );
    } finally {
      this.controllers.delete(task.id);
    }
  }
}
