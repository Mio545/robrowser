/**
 * `serve` assembly (spec 7.2 / 7.3).
 *
 * Wires the four moving parts together:
 *
 *   Fastify HTTP+WS  <->  TaskQueue  <->  WorkerSupervisor  ->  worker process
 *                                  \->  SqliteStorage (tasks, run history)
 *
 * Every task runs in its own worker process; takeover frames/input are relayed
 * through {@link CompositeTakeoverBackend}.
 */
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import type { FlowModel, RunEvent, RunResult } from '@robrowser/core';
import { toRoboError } from '@robrowser/core';
import type { ServerConfig } from './env.js';
import { SqliteStorage } from './storage.js';
import { TaskQueue } from './queue.js';
import { createHttpServer, type HttpServer } from './http.js';
import { TicketService } from './takeover/tokens.js';
import { CompositeTakeoverBackend } from './takeover/composite.js';
import { WorkerSupervisor } from './supervisor.js';

/** A running server plus its lifecycle helpers (used by tests). */
export interface ServeHandle {
  storage: SqliteStorage;
  queue: TaskQueue;
  takeover: CompositeTakeoverBackend;
  http: HttpServer;
  /** Cancel every running task and close every resource. */
  close(): Promise<void>;
}

/**
 * Build the full server without binding a port (tests use `http.listen()`).
 *
 * @param config - Validated server configuration.
 * @param logger - Process logger.
 */
export function createServe(config: ServerConfig, logger: Logger): ServeHandle {
  const storage = new SqliteStorage(join(resolve(config.RUN_DIR), 'robrowser.sqlite'));
  storage.failOrphanedTasks();

  const takeover = new CompositeTakeoverBackend(logger);
  const tickets = new TicketService({
    secret: config.SECRET,
    ttlSeconds: config.TAKEOVER_TTL_SECONDS,
  });

  const supervisor = new WorkerSupervisor({
    logger,
    config,
    storage,
    takeover,
    onEvent: (event) => queue.emit('run:event', event),
  });

  const queue = new TaskQueue({
    storage,
    logger,
    concurrency: config.MAX_CONCURRENCY,
    timeoutMs: config.TASK_TIMEOUT_MS,
    maxAttempts: config.TASK_RETRIES + 1,
  });

  queue.setExecutor(async (task, signal) => {
    const result = await supervisor.run(task, signal);
    await storage.saveRun({
      id: result.runId,
      flowId: result.flowId,
      flowName: result.flowName,
      status: result.status,
      reason: result.reason,
      stepCount: result.stepCount,
      durationMs: result.durationMs,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      runDir: join(resolve(config.RUN_DIR), 'runs', task.id),
      artifacts: result.artifacts,
      ...(result.error ? { errorCode: result.error.code, errorMessage: result.error.message } : {}),
    });
    return result;
  });

  const http = createHttpServer({
    logger,
    storage,
    queue,
    takeover,
    tickets,
    publicUrl: config.PUBLIC_URL,
    host: config.HOST,
    port: config.PORT,
  });

  queue.start();

  return {
    storage,
    queue,
    takeover,
    http,
    async close(): Promise<void> {
      await queue.stop();
      await supervisor.stop();
      await http.close().catch(() => undefined);
      await storage.close();
    },
  };
}

/** Narrow a stored task snapshot into a validated flow. */
export function taskFlow(task: { flowJson: string }): FlowModel {
  try {
    return JSON.parse(task.flowJson) as FlowModel;
  } catch (error) {
    throw toRoboError(error, 'VALIDATION_ERROR');
  }
}

/** Emit a run event to the queue fan-out (kept for tests). */
export type RunEventSink = (event: RunEvent) => void;

/** Re-export for convenience. */
export type { RunResult };
