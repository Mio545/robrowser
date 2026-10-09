/**
 * IPC protocol between the queue (parent) and a worker process (child)
 * (spec 7.3).
 *
 * The parent never runs browser code; the worker never touches the database.
 * Run events flow worker -> parent and are re-broadcast to HTTP/WS subscribers;
 * takeover input flows parent -> worker (see `takeover/worker-relay.ts`).
 */
import type { FlowModel, RunEvent, RunResult } from '@robrowser/core';
import type { ClientMessage, TakeoverSessionInfo } from './takeover/types.js';

/** Message sent from the parent to a worker. */
export type ParentMessage =
  | {
      type: 'task';
      taskId: string;
      runId: string;
      flow: FlowModel;
      vars: Record<string, unknown>;
      runDir: string;
      /** Base directory for relative `goto` URLs in the flow. */
      flowsDir: string;
      /** Chromium launch configuration. */
      chromeArgs: string[];
      chromePath?: string;
      headless: boolean;
      /** Secret used to sign tickets inside the worker. */
      secret: string;
      /** Default notification channels. */
      notifyChannels: string[];
      webhookUrl?: string;
      /** Default recipient for the email channel. */
      notifyTo?: string;
      /** Public origin the operator sees (the parent's PUBLIC_URL). */
      publicUrl: string;
    }
  | { type: 'cancel' }
  | { type: 'takeover-attach'; sessionId: string; clientId: string }
  | { type: 'takeover-detach'; sessionId: string; clientId: string }
  | {
      type: 'takeover-input';
      sessionId: string;
      clientId: string;
      message: ClientMessage;
    }
  | { type: 'shutdown' };

/** Message sent from a worker to the parent. */
export type WorkerMessage =
  | { type: 'ready'; pid: number }
  /** A typed run event to fan out to WebSocket subscribers. */
  | { type: 'log'; level: string; message: string }
  | { type: 'event'; event: RunEvent }
  /** A takeover session was created. */
  | { type: 'takeover-session'; session: WorkerTakeoverSession }
  | { type: 'takeover-frame'; sessionId: string; data: string; metadata: unknown }
  | { type: 'takeover-state'; sessionId: string; state: TakeoverSessionInfo['state'] }
  | { type: 'takeover-clients'; sessionId: string; clients: number }
  /** Terminal message carrying the run result (or a failure). */
  | { type: 'done'; result?: RunResult; error?: { code: string; message: string } };

/**
 * Compact session description forwarded to the parent so it can mirror the
 * session state for API responses. The operator URL is delivered by the worker's
 * notification channels (which already hold it), not relayed here.
 */
export interface WorkerTakeoverSession {
  sessionId: string;
  runId: string;
  stepId: string;
  reason: string;
  message: string;
  expiresAt: string;
}
