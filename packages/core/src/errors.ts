/**
 * Custom error taxonomy for the whole platform.
 *
 * Every error carries a stable machine-readable {@link ErrorCode} so that hosts
 * (CLI, HTTP server, Electron IPC) can map failures to exit codes / HTTP status
 * codes without string matching.
 */

/** Stable, machine-readable error codes. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'FLOW_NOT_FOUND'
  | 'VARIABLE_UNDEFINED'
  | 'SELECTOR_NOT_FOUND'
  | 'STEP_FAILED'
  | 'STEP_TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'NETWORK_ERROR'
  | 'BROWSER_ERROR'
  | 'CDP_ERROR'
  | 'DOWNLOAD_ERROR'
  | 'MANUAL_TIMEOUT'
  | 'MANUAL_ABORTED'
  | 'RUN_ABORTED'
  | 'CHECKPOINT_ERROR'
  | 'EXPORT_ERROR'
  | 'STORAGE_ERROR'
  | 'TAKEOVER_ERROR'
  | 'TOKEN_INVALID'
  | 'TOKEN_REPLAYED'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

/** Base class for every error thrown by platform code. */
export class RoboError extends Error {
  /** Stable machine-readable code. */
  public readonly code: ErrorCode;
  /** Optional structured details (never contains secrets). */
  public readonly details?: Record<string, unknown>;

  public constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Invalid or malformed FlowModel / step configuration. */
export class ValidationError extends RoboError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, details);
  }
}

/** Thrown when a `{{var}}` reference cannot be resolved. */
export class VariableUndefinedError extends RoboError {
  public constructor(name: string, path: string) {
    super('VARIABLE_UNDEFINED', `Undefined variable "${name}" referenced at ${path}`, {
      name,
      path,
    });
  }
}

/** Thrown when no selector candidate matched / the element could not be validated. */
export class SelectorNotFoundError extends RoboError {
  public constructor(selector: unknown, message?: string) {
    super(
      'SELECTOR_NOT_FOUND',
      message ?? `No element matched selector: ${describeSelector(selector)}`,
      { selector },
    );
  }
}

/** Generic step failure wrapper. */
export class StepError extends RoboError {
  public readonly stepId?: string;
  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    if (details && typeof details.stepId === 'string') this.stepId = details.stepId;
  }
}

/** Step exceeded its timeout. */
export class StepTimeoutError extends RoboError {
  public constructor(stepId: string, timeoutMs: number, message?: string) {
    super('STEP_TIMEOUT', message ?? `Step "${stepId}" timed out after ${timeoutMs}ms`, {
      stepId,
      timeoutMs,
    });
  }
}

/** Low level CDP failure. */
export class CdpError extends RoboError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('CDP_ERROR', message, details);
  }
}

/** Run was aborted through its AbortSignal. */
export class RunAbortedError extends RoboError {
  public constructor(runId: string) {
    super('RUN_ABORTED', `Run "${runId}" was aborted`, { runId });
  }
}

/** Manual interaction exceeded its budget. */
export class ManualTimeoutError extends RoboError {
  public constructor(stepId: string, timeoutMs: number) {
    super('MANUAL_TIMEOUT', `Manual step "${stepId}" timed out after ${timeoutMs}ms`, {
      stepId,
      timeoutMs,
    });
  }
}

/** Thrown by the exporters when a flow cannot be expressed in the target form. */
export class ExportError extends RoboError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super('EXPORT_ERROR', message, details);
  }
}

/** Errors raised by the remote takeover subsystem. */
export class TakeoverError extends RoboError {
  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
  }
}

/** Human readable description of a SelectorSpec, used in error messages. */
export function describeSelector(selector: unknown): string {
  if (typeof selector === 'string') return selector;
  if (selector && typeof selector === 'object') {
    const record = selector as Record<string, unknown>;
    if (Array.isArray(record.candidates)) {
      return record.candidates.map((c) => describeSelector(c)).join(' | ');
    }
    const keys = Object.keys(record);
    if (keys.length > 0) {
      return keys.map((k) => `${k}=${String(record[k])}`).join(' ');
    }
  }
  return String(selector);
}

/** True when the unknown value looks like a RoboError. */
export function isRoboError(value: unknown): value is RoboError {
  return value instanceof RoboError;
}

/** Normalise any thrown value into a RoboError (never throws). */
export function toRoboError(value: unknown, fallbackCode: ErrorCode = 'INTERNAL_ERROR'): RoboError {
  if (value instanceof RoboError) return value;
  if (value instanceof Error) {
    return new RoboError(fallbackCode, value.message, { name: value.name }, { cause: value });
  }
  return new RoboError(fallbackCode, typeof value === 'string' ? value : 'Unknown error', {
    value: safeStringify(value),
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
