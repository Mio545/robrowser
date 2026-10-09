/**
 * Typed event bus used to stream run progress to every host.
 *
 * The payload map is the contract between the engine and the hosts (CLI JSON
 * output, HTTP WebSocket fan-out, Electron IPC). Adding a new event is a
 * compile-time breaking change for listeners, which is intentional.
 */
import type { Step, StepType } from '../flow/schema.js';
import type { ErrorCode } from '../errors.js';

/** Terminal run status. */
export type RunStatus = 'pending' | 'running' | 'paused' | 'success' | 'failed' | 'aborted';

/** Reason a run stopped. */
export type RunStopReason = 'completed' | 'error' | 'aborted' | 'paused';

/** Payload for `step:start`. */
export interface StepStartEvent {
  runId: string;
  stepId: string;
  stepType: StepType;
  index: number;
  total: number;
  /** Human readable summary for logs / UI. */
  summary: string;
  timestamp: number;
}

/** Payload for `step:ok`. */
export interface StepOkEvent {
  runId: string;
  stepId: string;
  stepType: StepType;
  durationMs: number;
  /** Handler output (may include extracted values). */
  output?: unknown;
  timestamp: number;
}

/** Payload for `step:fail`. */
export interface StepFailEvent {
  runId: string;
  stepId: string;
  stepType: StepType;
  durationMs: number;
  code: ErrorCode;
  message: string;
  attempt: number;
  willRetry: boolean;
  timestamp: number;
}

/** Payload for `step:skip`. */
export interface StepSkipEvent {
  runId: string;
  stepId: string;
  stepType: StepType;
  reason: string;
  timestamp: number;
}

/** Payload for `log`. */
export interface LogEvent {
  runId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  stepId?: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** Payload for `screenshot`. */
export interface ScreenshotEvent {
  runId: string;
  stepId: string;
  /** Absolute path of the written PNG, when persisted. */
  path?: string;
  /** Base64 PNG payload for in-memory preview (omitted when large/not requested). */
  base64?: string;
  timestamp: number;
}

/** Payload for `var:set`. */
export interface VarSetEvent {
  runId: string;
  name: string;
  /** Redacted value for secrets. */
  value: unknown;
  scope: 'const' | 'env' | 'secret' | 'input' | 'runtime';
  timestamp: number;
}

/** Payload for `run:start` / `run:end`. */
export interface RunLifecycleEvent {
  runId: string;
  flowId: string;
  flowName: string;
  timestamp: number;
  status?: RunStatus;
  reason?: RunStopReason;
  durationMs?: number;
  stepCount?: number;
}

/** Payload for `manual:request` — emitted when automation pauses for a human. */
export interface ManualRequestEvent {
  runId: string;
  stepId: string;
  reason: string;
  message: string;
  timeoutMs: number;
  timestamp: number;
}

/** Payload for `manual:resolved`. */
export interface ManualResolvedEvent {
  runId: string;
  stepId: string;
  status: 'resolved' | 'timeout' | 'aborted';
  by?: string;
  timestamp: number;
}

/** Payload for `checkpoint`. */
export interface CheckpointEvent {
  runId: string;
  stepId: string;
  index: number;
  path: string;
  timestamp: number;
}

/** The complete event map emitted by the orchestrator. */
export interface RunEventMap {
  'run:start': RunLifecycleEvent;
  'run:end': RunLifecycleEvent;
  'run:aborted': RunLifecycleEvent;
  'step:start': StepStartEvent;
  'step:ok': StepOkEvent;
  'step:fail': StepFailEvent;
  'step:skip': StepSkipEvent;
  log: LogEvent;
  screenshot: ScreenshotEvent;
  'var:set': VarSetEvent;
  'manual:request': ManualRequestEvent;
  'manual:resolved': ManualResolvedEvent;
  checkpoint: CheckpointEvent;
}

/** Event name union. */
export type RunEventName = keyof RunEventMap;

/** Discriminated union of all emitted events (handy for WebSocket payloads). */
export type RunEvent = {
  [K in RunEventName]: { type: K; payload: RunEventMap[K] };
}[RunEventName];

/** Listener signature for a specific event. */
export type Listener<K extends RunEventName> = (payload: RunEventMap[K]) => void;

/**
 * Minimal, dependency-free typed event bus.
 *
 * Listener exceptions are isolated so that one bad subscriber cannot break a run.
 */
export class EventBus {
  private readonly listeners = new Map<RunEventName, Set<(payload: never) => void>>();
  private readonly anyListeners = new Set<(event: RunEvent) => void>();

  /**
   * Subscribe to a single event type.
   *
   * @returns An unsubscribe function.
   */
  public on<K extends RunEventName>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as (payload: never) => void);
    return () => this.off(event, listener);
  }

  /** Unsubscribe a previously registered listener. */
  public off<K extends RunEventName>(event: K, listener: Listener<K>): void {
    this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  /** Subscribe to every event; useful for logging and WebSocket fan-out. */
  public onAny(listener: (event: RunEvent) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  /** Emit a typed event to all subscribers. */
  public emit<K extends RunEventName>(event: K, payload: RunEventMap[K]): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const listener of set) {
        try {
          (listener as Listener<K>)(payload);
        } catch {
          // A failing listener must never break the run.
        }
      }
    }
    for (const listener of this.anyListeners) {
      try {
        listener({ type: event, payload } as RunEvent);
      } catch {
        // ignore
      }
    }
  }

  /** Remove all listeners. */
  public clear(): void {
    this.listeners.clear();
    this.anyListeners.clear();
  }
}

/** Helper: build a one-line human summary for a step, used by `step:start`. */
export function summarizeStep(step: Step): string {
  switch (step.type) {
    case 'goto':
      return `goto ${step.url}`;
    case 'click':
      return `click ${JSON.stringify(step.selector)}`;
    case 'type':
      return `type into ${JSON.stringify(step.selector)}`;
    case 'select':
      return `select ${step.value} on ${JSON.stringify(step.selector)}`;
    case 'hover':
      return `hover ${JSON.stringify(step.selector)}`;
    case 'scroll':
      return step.selector
        ? `scroll to ${JSON.stringify(step.selector)}`
        : `scroll to (${step.x ?? 0}, ${step.y ?? 0})`;
    case 'waitForPage':
      return `wait for page "${step.target}"`;
    case 'waitForSelector':
      return `wait for selector ${JSON.stringify(step.selector)}${step.state ? ` (${step.state})` : ''}`;
    case 'waitForUrl':
      return `wait for url ~ ${step.pattern}`;
    case 'waitForNetworkIdle':
      return `wait for network idle`;
    case 'waitForDownload':
      return `wait for download`;
    case 'extract':
      return `extract into "${step.into}"`;
    case 'screenshot':
      return `screenshot${step.saveTo ? ` -> ${step.saveTo}` : ''}`;
    case 'branch':
      return 'branch';
    case 'loop':
      return `loop over ${typeof step.items === 'string' ? step.items : `${step.items.length} items`} as "${step.as}"`;
    case 'setVar':
      return `setVar ${step.name}`;
    case 'httpCall':
      return `${step.method.toUpperCase()} ${step.url}`;
    case 'manual':
      return `manual (${step.reason}): ${step.message}`;
    default: {
      const exhaustive: never = step;
      return String(exhaustive);
    }
  }
}
