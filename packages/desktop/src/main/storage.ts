/**
 * Desktop persistence (spec 9: better-sqlite3 in `userData`).
 *
 * Stores flows and a compact run history. The schema intentionally mirrors the
 * server's flow/run tables so a flow can be copied between the two hosts
 * without translation — that is what makes the shared FlowModel contract real.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialSummary, FlowModel, RunResult } from '@robrowser/core';
import type { FlowSummary, RunSummary } from '../shared/types.js';

/**
 * One `credentials` row as stored on disk.
 *
 * `secret` holds the OS-keychain ciphertext for the password; the plaintext is
 * never written here and the column is never handed to the renderer.
 */
export interface StoredCredentialRow {
  key: string;
  username?: string;
  secret?: Buffer;
  url?: string;
  updatedAt: string;
}

/** SQLite-backed desktop store. */
export class DesktopStorage {
  private readonly db: Database.Database;

  public constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, 'robrowser-desktop.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.migrate();
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
        error_code TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_desktop_runs_started ON runs (started_at DESC);
      CREATE TABLE IF NOT EXISTS credentials (
        key TEXT PRIMARY KEY,
        username TEXT,
        secret BLOB,
        url TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /** List stored flows, newest first. */
  public listFlows(): FlowSummary[] {
    return this.db
      .prepare('SELECT id, name, updated_at FROM flows ORDER BY updated_at DESC')
      .all()
      .map((row) => {
        const record = row as { id: string; name: string; updated_at: string };
        return { id: record.id, name: record.name, updatedAt: record.updated_at };
      });
  }

  /** Load one flow. */
  public loadFlow(id: string): FlowModel | null {
    const row = this.db.prepare('SELECT flow_json FROM flows WHERE id = ?').get(id) as
      { flow_json: string } | undefined;
    return row ? (JSON.parse(row.flow_json) as FlowModel) : null;
  }

  /** Insert or update a flow. */
  public saveFlow(flow: FlowModel): void {
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
  }

  /** Delete a flow. */
  public deleteFlow(id: string): void {
    this.db.prepare('DELETE FROM flows WHERE id = ?').run(id);
  }

  /** Read one credential row, including the encrypted password blob. */
  public getCredential(key: string): StoredCredentialRow | undefined {
    const row = this.db
      .prepare('SELECT key, username, secret, url, updated_at FROM credentials WHERE key = ?')
      .get(key) as CredentialRow | undefined;
    return row ? toCredentialRow(row) : undefined;
  }

  /** Insert or replace a credential row. */
  public saveCredential(row: StoredCredentialRow): void {
    this.db
      .prepare(
        `INSERT INTO credentials (key, username, secret, url, updated_at)
         VALUES (@key, @username, @secret, @url, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET
           username = @username, secret = @secret, url = @url, updated_at = @updatedAt`,
      )
      .run({
        key: row.key,
        username: row.username ?? null,
        secret: row.secret ?? null,
        url: row.url ?? null,
        updatedAt: row.updatedAt,
      });
  }

  /** Delete a credential row; `true` when a row was removed. */
  public deleteCredential(key: string): boolean {
    return this.db.prepare('DELETE FROM credentials WHERE key = ?').run(key).changes > 0;
  }

  /**
   * Redacted credential metadata for the UI.
   *
   * The `secret` column is deliberately not selected: the renderer has no
   * keychain key, so it must never receive the ciphertext at all.
   */
  public listCredentials(): CredentialSummary[] {
    return this.db
      .prepare('SELECT key, username, url, updated_at FROM credentials ORDER BY key')
      .all()
      .map((row) => {
        const record = row as {
          key: string;
          username: string | null;
          url: string | null;
          updated_at: string;
        };
        return {
          key: record.key,
          ...(record.username ? { username: record.username } : {}),
          ...(record.url ? { url: record.url } : {}),
          ...(record.updated_at ? { updatedAt: record.updated_at } : {}),
        };
      });
  }

  /** Persist the outcome of a run. */
  public saveRun(result: RunResult, runDir: string): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, flow_id, flow_name, status, reason, step_count, duration_ms,
                           started_at, finished_at, run_dir, error_code, error_message)
         VALUES (@id, @flowId, @flowName, @status, @reason, @stepCount, @durationMs,
                 @startedAt, @finishedAt, @runDir, @errorCode, @errorMessage)
         ON CONFLICT(id) DO UPDATE SET
           status = @status, reason = @reason, step_count = @stepCount, duration_ms = @durationMs,
           finished_at = @finishedAt, error_code = @errorCode, error_message = @errorMessage`,
      )
      .run({
        id: result.runId,
        flowId: result.flowId,
        flowName: result.flowName,
        status: result.status,
        reason: result.reason,
        stepCount: result.stepCount,
        durationMs: result.durationMs,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        runDir,
        errorCode: result.error?.code ?? null,
        errorMessage: result.error?.message ?? null,
      });
  }

  /** Run history, newest first. */
  public listRuns(limit = 50): RunSummary[] {
    return this.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit)
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          id: record.id as string,
          flowId: record.flow_id as string,
          flowName: record.flow_name as string,
          status: record.status as RunSummary['status'],
          ...(record.reason ? { reason: record.reason as string } : {}),
          stepCount: Number(record.step_count ?? 0),
          durationMs: Number(record.duration_ms ?? 0),
          startedAt: record.started_at as string,
          ...(record.finished_at ? { finishedAt: record.finished_at as string } : {}),
          ...(record.run_dir ? { runDir: record.run_dir as string } : {}),
          ...(record.error_code ? { errorCode: record.error_code as string } : {}),
          ...(record.error_message ? { errorMessage: record.error_message as string } : {}),
        };
      });
  }

  /** Close the database handle. */
  public close(): void {
    this.db.close();
  }
}

/** Raw `credentials` row as SQLite returns it (nullable columns). */
interface CredentialRow {
  key: string;
  username: string | null;
  secret: Buffer | null;
  url: string | null;
  updated_at: string;
}

/** Drop the SQL NULLs so the rest of the app sees optional fields. */
function toCredentialRow(row: CredentialRow): StoredCredentialRow {
  return {
    key: row.key,
    ...(row.username !== null ? { username: row.username } : {}),
    ...(row.secret !== null ? { secret: row.secret } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
    updatedAt: row.updated_at,
  };
}
