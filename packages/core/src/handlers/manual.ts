/**
 * Manual intervention abstraction (spec 5.6).
 *
 * `core` only depends on this interface. The desktop host implements it with a
 * modal window; the headless server implements it with remote takeover.
 */
import type { PagePort } from '../engine/ports.js';

/** Reason a run needs a human. */
export type ManualReason = 'captcha' | 'sms' | 'otp' | 'confirm' | 'other';

/** Request handed to a {@link ManualHandler}. */
export interface ManualRequest {
  /** Run identifier. */
  runId: string;
  /** Step identifier that triggered the pause. */
  stepId: string;
  /** Why a human is needed. */
  reason: ManualReason;
  /** Message shown to the operator. */
  message: string;
  /** Hard deadline for the human interaction. */
  timeoutMs: number;
  /** The page the human is allowed to control (scoped, single page). */
  page: PagePort;
  /**
   * Optional completion predicate evaluated server side. When present the
   * handler may auto-resume as soon as it holds.
   */
  resolveWhen?: import('../flow/schema.js').PageRule;
  /** Notification channels requested by the flow step. */
  notify?: string[];
}

/** Outcome of a manual interaction. */
export interface ManualResult {
  status: 'resolved' | 'timeout' | 'aborted';
  /** Operator identifier, when known (remote takeover audit trail). */
  by?: string;
}

/** Contract implemented by desktop and headless hosts. */
export interface ManualHandler {
  /**
   * Request human intervention and resolve once the operator (or the automatic
   * completion predicate) finishes.
   */
  request(req: ManualRequest): Promise<ManualResult>;
}

/**
 * Default handler used when a host does not provide one.
 *
 * It fails fast with a clear message instead of hanging, which keeps headless
 * runs from blocking forever on an unconfigured `manual` step.
 */
export class UnsupportedManualHandler implements ManualHandler {
  public async request(req: ManualRequest): Promise<ManualResult> {
    throw new Error(
      `Manual step "${req.stepId}" requires a ManualHandler but none was configured (reason: ${req.reason}).`,
    );
  }
}

/** Auto-resolve handler used by tests and by `--auto-manual` CLI mode. */
export class AutoResolveManualHandler implements ManualHandler {
  public constructor(private readonly by = 'auto') {}

  public async request(_req: ManualRequest): Promise<ManualResult> {
    return { status: 'resolved', by: this.by };
  }
}
