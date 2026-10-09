/**
 * Storage abstraction (spec 3: `storage/repo.ts`).
 *
 * `core` defines the interface only; the SQLite implementation lives in the
 * `server` package so that `core` stays free of native dependencies.
 */
import type { FlowModel } from '../flow/schema.js';
import type { RunStatus, RunStopReason } from '../events/bus.js';

/** Summary of a completed / in-flight run. */
export interface RunRecord {
  id: string;
  flowId: string;
  flowName: string;
  status: RunStatus;
  reason?: RunStopReason;
  /** Number of steps executed. */
  stepCount: number;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  startedAt: string;
  finishedAt?: string;
  /** Path to the run directory holding artefacts and the checkpoint. */
  runDir?: string;
  /** Artefact paths produced by the run. */
  artifacts?: string[];
  /** Terminal error code, when the run failed. */
  errorCode?: string;
  /** Terminal error message, when the run failed. */
  errorMessage?: string;
}

/** A stored flow plus metadata. */
export interface StoredFlow {
  id: string;
  name: string;
  /** The flow document. */
  flow: FlowModel;
  createdAt: string;
  updatedAt: string;
}

/** Filter used by {@link FlowRepository.listRuns}. */
export interface RunQuery {
  status?: RunStatus;
  flowId?: string;
  limit?: number;
  offset?: number;
}

/** Persistence contract for flows and run history. */
export interface FlowRepository {
  /** Insert or update a flow. */
  saveFlow(flow: FlowModel): Promise<StoredFlow>;
  /** Fetch a flow by id. */
  getFlow(id: string): Promise<StoredFlow | null>;
  /** List flows ordered by update time (newest first). */
  listFlows(): Promise<StoredFlow[]>;
  /** Delete a flow and (depending on implementation) its runs. */
  deleteFlow(id: string): Promise<void>;

  /** Create or update a run record. */
  saveRun(run: RunRecord): Promise<void>;
  /** Fetch a run by id. */
  getRun(id: string): Promise<RunRecord | null>;
  /** Query runs with optional filtering and pagination. */
  listRuns(query?: RunQuery): Promise<{ items: RunRecord[]; total: number }>;

  /** Release resources (close the database handle). */
  close(): Promise<void>;
}

/** In-memory implementation used by tests and the desktop fallback path. */
export class InMemoryFlowRepository implements FlowRepository {
  private readonly flows = new Map<string, StoredFlow>();
  private readonly runs = new Map<string, RunRecord>();

  public async saveFlow(flow: FlowModel): Promise<StoredFlow> {
    const now = new Date().toISOString();
    const existing = this.flows.get(flow.id);
    const record: StoredFlow = {
      id: flow.id,
      name: flow.name,
      flow,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.flows.set(flow.id, record);
    return record;
  }

  public async getFlow(id: string): Promise<StoredFlow | null> {
    return this.flows.get(id) ?? null;
  }

  public async listFlows(): Promise<StoredFlow[]> {
    return [...this.flows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async deleteFlow(id: string): Promise<void> {
    this.flows.delete(id);
  }

  public async saveRun(run: RunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
  }

  public async getRun(id: string): Promise<RunRecord | null> {
    const found = this.runs.get(id);
    return found ? { ...found } : null;
  }

  public async listRuns(query: RunQuery = {}): Promise<{ items: RunRecord[]; total: number }> {
    let items = [...this.runs.values()];
    if (query.status) items = items.filter((run) => run.status === query.status);
    if (query.flowId) items = items.filter((run) => run.flowId === query.flowId);
    items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const total = items.length;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return { items: items.slice(offset, offset + limit).map((run) => ({ ...run })), total };
  }

  public async close(): Promise<void> {
    this.flows.clear();
    this.runs.clear();
  }
}
