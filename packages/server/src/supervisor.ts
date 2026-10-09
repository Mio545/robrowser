/**
 * Worker supervisor (spec 7.3).
 *
 * `serve` runs every task in a dedicated child process so that a browser crash
 * or a runaway CDP session cannot take the HTTP server down. This module owns
 * the child-process lifecycle:
 *
 *   spawn -> send `task` -> stream events/logs -> await `done` -> persist run row
 *
 * Takeover frames flow up over IPC through a {@link WorkerTakeoverRelay}, which
 * is registered with the composite backend; operator input flows back down as
 * `takeover-input` messages.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { RunEvent, RunResult } from '@robrowser/core';
import { toRoboError } from '@robrowser/core';
import type { ServerConfig } from './env.js';
import { chromeArgs, notifyChannels } from './env.js';
import type { SqliteStorage, TaskRow } from './storage.js';
import type { WorkerMessage } from './worker-protocol.js';
import { WorkerTakeoverRelay } from './takeover/worker-relay.js';
import type { CompositeTakeoverBackend } from './takeover/composite.js';

/** Options for {@link WorkerSupervisor}. */
export interface WorkerSupervisorOptions {
  logger: Logger;
  config: ServerConfig;
  storage: SqliteStorage;
  takeover: CompositeTakeoverBackend;
  /** Fan run events out to the HTTP/WS layer (usually `queue.emit`). */
  onEvent?: (event: RunEvent) => void;
}

/** One live child process and its IPC plumbing. */
interface WorkerHandle {
  child: ChildProcess;
  relay: WorkerTakeoverRelay;
  settle: (result: RunResult | Error) => void;
  settled: boolean;
}

/**
 * Executes queue tasks in isolated worker processes.
 *
 * Implements the {@link TaskExecutor} contract: `run(task, signal)` resolves
 * with the {@link RunResult} produced by the child, or rejects when the child
 * crashes / reports a hard error.
 */
export class WorkerSupervisor {
  private readonly workers = new Map<string, WorkerHandle>();

  public constructor(private readonly options: WorkerSupervisorOptions) {}

  /** Number of live children (health-check diagnostics). */
  public activeWorkers(): number {
    return this.workers.size;
  }

  /**
   * Run one task in a child process.
   *
   * @param task - Claimed task row.
   * @param signal - Cancellation signal owned by the queue.
   */
  public run(task: TaskRow, signal: AbortSignal): Promise<RunResult> {
    const { logger, config, takeover } = this.options;
    const runDir = resolve(task.runDir ?? join(config.RUN_DIR, 'runs', task.id));
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'worker.js');

    return new Promise<RunResult>((resolvePromise, rejectPromise) => {
      const child = fork(workerPath, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, LOG_LEVEL: config.LOG_LEVEL },
      });
      const relay = new WorkerTakeoverRelay(child, logger);
      takeover.register(relay);

      const handle: WorkerHandle = {
        child,
        relay,
        settled: false,
        settle: (outcome) => {
          if (handle.settled) return;
          handle.settled = true;
          if (outcome instanceof Error) rejectPromise(outcome);
          else resolvePromise(outcome);
        },
      };
      this.workers.set(task.id, handle);

      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        child.send({ type: 'cancel' } satisfies { type: 'cancel' });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.on('message', (raw: unknown) => {
        const message = raw as WorkerMessage;
        switch (message?.type) {
          case 'event':
            this.options.onEvent?.(message.event);
            break;
          case 'takeover-session':
            logger.info(
              { taskId: task.id, sessionId: message.session.sessionId },
              'worker takeover session created',
            );
            break;
          case 'done': {
            const result = message.result;
            if (result) {
              handle.settle(result);
            } else if (message.error) {
              handle.settle(
                Object.assign(new Error(message.error.message), { code: message.error.code }),
              );
            } else {
              handle.settle(new Error('worker finished without a result'));
            }
            break;
          }
          default:
            break;
        }
      });

      child.on('error', (error) => {
        logger.error({ taskId: task.id, err: error.message }, 'worker process error');
        handle.settle(error);
      });

      child.on('exit', (code, signalName) => {
        signal.removeEventListener('abort', onAbort);
        this.workers.delete(task.id);
        takeover.unregister(relay);
        if (!handle.settled) {
          const message = aborted
            ? 'worker aborted by request'
            : `worker exited before completing (code=${code}, signal=${signalName ?? 'none'})`;
          const error = toRoboError(new Error(message), 'INTERNAL_ERROR');
          handle.settle(error);
        }
      });

      child.send({
        type: 'task',
        taskId: task.id,
        runId: task.id,
        flow: JSON.parse(task.flowJson),
        vars: task.vars,
        runDir,
        flowsDir: config.FLOWS_DIR,
        chromeArgs: chromeArgs(config),
        ...(config.CHROME_PATH ? { chromePath: config.CHROME_PATH } : {}),
        headless: config.HEADLESS,
        secret: config.SECRET,
        notifyChannels: notifyChannels(config),
        ...(config.WEBHOOK_URL ? { webhookUrl: config.WEBHOOK_URL } : {}),
        ...(config.NOTIFY_TO ? { notifyTo: config.NOTIFY_TO } : {}),
        publicUrl: config.PUBLIC_URL,
      });
    }).finally(() => {
      const handle = this.workers.get(task.id);
      if (handle) {
        handle.child.send({ type: 'shutdown' });
      }
    });
  }

  /** Terminate every live child (server shutdown). */
  public async stop(): Promise<void> {
    const handles = [...this.workers.values()];
    for (const handle of handles) {
      handle.child.send({ type: 'shutdown' });
      handle.child.kill();
    }
    this.workers.clear();
  }
}

/** Re-export so tests can construct relays directly. */
export { WorkerTakeoverRelay };
void EventEmitter;
