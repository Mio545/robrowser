/**
 * SQLite persistence (spec 2: better-sqlite3).
 *
 * Implements the core {@link FlowRepository} contract plus the task queue schema
 * used by {@link TaskQueue}. WAL mode keeps readers (HTTP status queries) fast
 * while a worker writes run events.
 */
import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FlowRepository, FlowModel, RunQuery, RunRecord, StoredFlow } from '@robrowser/core';
import { RoboError } from '@robrowser/core';

/** A queued task row. */
export interface TaskRow {
  id: string;
  flowId: string;
  /** Serialised FlowModel (the task owns its flow snapshot). */
  flowJson: string;
  /** `--var` overrides / input values. */
  varsJson: string;
  vars: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  runDir?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Incremented whenever the task row changes (used for IPC/WS diffing). */
  revision: number;
}

/** Storage facade for flows, runs, and the task queue. */
export class SqliteStorage implements FlowRepository {
  private readonly db: Database.Database;

  public constructor(filePath: string) {
    const absolute = resolve(filePath);
    // better-sqlite3 requires the directory to exist before opening the file.
    // `mkdirSync` keeps the constructor usable without an async factory.
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new Database(absolute);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  /** The raw handle, exposed for migrations / tests. */
  public get handle(): Database.Database {
    return this.db;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS flows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        flow_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        flow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        step_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        run_dir TEXT,
        artifacts_json TEXT,
        error_code TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_flow ON runs (flow_id);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        flow_id TEXT NOT NULL,
        flow_json TEXT NOT NULL,
        vars_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        run_id TEXT,
        run_dir TEXT,
        error_code TEXT,
        error_message TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status, created_at);
    `);
  }

  /* ----------------------------------------------------------- flows */

  public async saveFlow(flow: FlowModel): Promise<StoredFlow> {
    const now = new Date().toISOString();
    const existing = this.db.prepare('SELECT created_at FROM flows WHERE id = ?').get(flow.id) as
      { created_at: string } | undefined;
    this.db
      .prepare(
        `INSERT INTO flows (id, name, flow_json, created_at, updated_at)
         VALUES (@id, @name, @flowJson, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET name = @name, flow_json = @flowJson, updated_at = @updatedAt`,
      )
      .run({
        id: flow.id,
        name: flow.name,
        flowJson: JSON.stringify(flow),
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
      });
    return {
      id: flow.id,
      name: flow.name,
      flow,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
    };
  }

  public async getFlow(id: string): Promise<StoredFlow | null> {
    const row = this.db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as
      | { id: string; name: string; flow_json: string; created_at: string; updated_at: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      flow: JSON.parse(row.flow_json) as FlowModel,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public async listFlows(): Promise<StoredFlow[]> {
    const rows = this.db.prepare('SELECT * FROM flows ORDER BY updated_at DESC').all() as Array<{
      id: string;
      name: string;
      flow_json: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      flow: JSON.parse(row.flow_json) as FlowModel,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  public async deleteFlow(id: string): Promise<void> {
    this.db.prepare('DELETE FROM flows WHERE id = ?').run(id);
  }

  /* ------------------------------------------------------------ runs */

  public async saveRun(run: RunRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO runs (id, flow_id, flow_name, status, reason, step_count, duration_ms,
                           started_at, finished_at, run_dir, artifacts_json, error_code, error_message)
         VALUES (@id, @flowId, @flowName, @status, @reason, @stepCount, @durationMs,
                 @startedAt, @finishedAt, @runDir, @artifacts, @errorCode, @errorMessage)
         ON CONFLICT(id) DO UPDATE SET
           status = @status, reason = @reason, step_count = @stepCount, duration_ms = @durationMs,
           finished_at = @finishedAt, run_dir = @runDir, artifacts_json = @artifacts,
           error_code = @errorCode, error_message = @errorMessage`,
      )
      .run({
        id: run.id,
        flowId: run.flowId,
        flowName: run.flowName,
        status: run.status,
        reason: run.reason ?? null,
        stepCount: run.stepCount,
        durationMs: run.durationMs,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        runDir: run.runDir ?? null,
        artifacts: run.artifacts ? JSON.stringify(run.artifacts) : null,
        errorCode: run.errorCode ?? null,
        errorMessage: run.errorMessage ?? null,
      });
  }

  public async getRun(id: string): Promise<RunRecord | null> {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row ? mapRunRow(row) : null;
  }

  public async listRuns(query: RunQuery = {}): Promise<{ items: RunRecord[]; total: number }> {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (query.status) {
      conditions.push('status = @status');
      params.status = query.status;
    }
    if (query.flowId) {
      conditions.push('flow_id = @flowId');
      params.flowId = query.flowId;
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM runs ${where}`).get(params) as {
      total: number;
    };
    const rows = this.db
      .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT @limit OFFSET @offset`)
      .all({ ...params, limit: query.limit ?? 50, offset: query.offset ?? 0 }) as Array<
      Record<string, unknown>
    >;
    return { items: rows.map(mapRunRow), total: totalRow.total };
  }

  /* ----------------------------------------------------------- tasks */

  /** Insert a new queued task. */
  public insertTask(task: {
    id: string;
    flowId: string;
    flow: FlowModel;
    vars?: Record<string, unknown>;
    maxAttempts?: number;
  }): TaskRow {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (id, flow_id, flow_json, vars_json, status, attempts, max_attempts,
                            created_at, updated_at, revision)
         VALUES (@id, @flowId, @flowJson, @varsJson, 'queued', 0, @maxAttempts, @now, @now, 1)`,
      )
      .run({
        id: task.id,
        flowId: task.flowId,
        flowJson: JSON.stringify(task.flow),
        varsJson: JSON.stringify(task.vars ?? {}),
        maxAttempts: task.maxAttempts ?? 1,
        now,
      });
    return this.getTask(task.id)!;
  }

  /** Fetch a task by id. */
  public getTask(id: string): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return row ? mapTaskRow(row) : null;
  }

  /** List tasks (queue introspection / tests). */
  public listTasks(status?: TaskRow['status']): TaskRow[] {
    const rows = (
      status
        ? this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at').all(status)
        : this.db.prepare('SELECT * FROM tasks ORDER BY created_at').all()
    ) as Array<Record<string, unknown>>;
    return rows.map(mapTaskRow);
  }

  /** Atomically claim the oldest queued task for execution. */
  public claimNextTask(): TaskRow | null {
    const claim = this.db.transaction((): TaskRow | null => {
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT 1")
        .get() as Record<string, unknown> | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE tasks SET status = 'running', attempts = attempts + 1, started_at = @now,
                            updated_at = @now, revision = revision + 1
           WHERE id = @id`,
        )
        .run({ id: row.id as string, now });
      return this.getTask(row.id as string);
    });
    return claim();
  }

  /** Update a task's lifecycle fields. */
  public updateTask(
    id: string,
    patch: Partial<
      Pick<TaskRow, 'status' | 'runId' | 'runDir' | 'errorCode' | 'errorMessage' | 'finishedAt'>
    >,
  ): TaskRow | null {
    const current = this.getTask(id);
    if (!current) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET
           status = @status,
           run_id = @runId,
           run_dir = @runDir,
           error_code = @errorCode,
           error_message = @errorMessage,
           finished_at = @finishedAt,
           updated_at = @now,
           revision = revision + 1
         WHERE id = @id`,
      )
      .run({
        id,
        status: patch.status ?? current.status,
        runId: patch.runId ?? current.runId ?? null,
        runDir: patch.runDir ?? current.runDir ?? null,
        errorCode: patch.errorCode ?? current.errorCode ?? null,
        errorMessage: patch.errorMessage ?? current.errorMessage ?? null,
        finishedAt: patch.finishedAt ?? current.finishedAt ?? null,
        now,
      });
    return this.getTask(id);
  }

  /** Force a task back to `queued` for a retry. */
  public requeueTask(id: string, error: { code?: string; message?: string }): TaskRow | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'queued', error_code = @code, error_message = @message,
                          finished_at = NULL, updated_at = @now, revision = revision + 1
         WHERE id = @id`,
      )
      .run({ id, code: error.code ?? null, message: error.message ?? null, now });
    return this.getTask(id);
  }

  /** Mark running tasks as failed (called on startup: no worker survived a restart). */
  public failOrphanedTasks(message = 'Interrupted by server restart'): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', error_code = 'INTERNAL_ERROR',
                          error_message = @message, finished_at = @now, updated_at = @now,
                          revision = revision + 1
         WHERE status = 'running'`,
      )
      .run({ message, now });
    return result.changes;
  }

  public async close(): Promise<void> {
    this.db.close();
  }
}

/** Create the storage directory (helper used by the CLI before constructing). */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(resolve(path), { recursive: true });
}

function mapRunRow(row: Record<string, unknown>): RunRecord {
  const artifacts = row.artifacts_json
    ? (JSON.parse(row.artifacts_json as string) as string[])
    : undefined;
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    flowName: row.flow_name as string,
    status: row.status as RunRecord['status'],
    ...(row.reason ? { reason: row.reason as RunRecord['reason'] } : {}),
    stepCount: Number(row.step_count ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    startedAt: row.started_at as string,
    ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}),
    ...(row.run_dir ? { runDir: row.run_dir as string } : {}),
    ...(artifacts ? { artifacts } : {}),
    ...(row.error_code ? { errorCode: row.error_code as string } : {}),
    ...(row.error_message ? { errorMessage: row.error_message as string } : {}),
  };
}

function mapTaskRow(row: Record<string, unknown>): TaskRow {
  const varsJson = (row.vars_json as string) ?? '{}';
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    flowJson: row.flow_json as string,
    varsJson,
    vars: JSON.parse(varsJson) as Record<string, unknown>,
    status: row.status as TaskRow['status'],
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 1),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...(row.started_at ? { startedAt: row.started_at as string } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at as string } : {}),
    ...(row.run_id ? { runId: row.run_id as string } : {}),
    ...(row.run_dir ? { runDir: row.run_dir as string } : {}),
    ...(row.error_code ? { errorCode: row.error_code as string } : {}),
    ...(row.error_message ? { errorMessage: row.error_message as string } : {}),
    revision: Number(row.revision ?? 0),
  };
}

/** Convenience factory that also ensures the parent directory exists. */
export async function openStorage(filePath: string): Promise<SqliteStorage> {
  await ensureDirectory(dirname(resolve(filePath)));
  return new SqliteStorage(filePath);
}

/** Wrap database failures in the platform error taxonomy. */
export function wrapStorageError(error: unknown, context: string): RoboError {
  return new RoboError(
    'STORAGE_ERROR',
    `Storage failure while ${context}: ${(error as Error).message}`,
    {
      cause: undefined,
    },
    { cause: error },
  );
}
