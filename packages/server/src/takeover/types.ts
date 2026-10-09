/**
 * Remote takeover types (spec 8).
 *
 * The state machine is explicit because correctness depends on it:
 *
 *   IDLE -> PENDING -> ACTIVE -> COMPLETED
 *                          \-> TIMEOUT
 *                          \-> ABORTED
 */
import type { PagePort, PageRule } from '@robrowser/core';

/** Session life-cycle states. */
export type TakeoverState = 'IDLE' | 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'TIMEOUT' | 'ABORTED';

/** Why a takeover was created. */
export type TakeoverReason = 'captcha' | 'sms' | 'otp' | 'confirm' | 'other';

/** Public (non-secret) session description handed to clients and the UI. */
export interface TakeoverSessionInfo {
  sessionId: string;
  runId: string;
  stepId: string;
  reason: TakeoverReason;
  message: string;
  state: TakeoverState;
  createdAt: string;
  expiresAt: string;
  /** Set once a client has claimed the session (first wins). */
  claimedBy?: string;
  /** Active client count (0 when nobody is connected). */
  clients: number;
  /** True when the automatic `resolveWhen` poller has satisfied the condition. */
  resolveWhenSatisfied: boolean;
}

/** Internal session record. */
export interface TakeoverSession {
  info: TakeoverSessionInfo;
  /** The single page this session may control. */
  page: PagePort;
  /** Optional automatic completion predicate. */
  resolveWhen?: PageRule;
  /** Resolves the owning `manual` step. */
  resolve: (result: { status: 'resolved' | 'timeout' | 'aborted'; by?: string }) => void;
  /** Timer that enforces `timeoutMs` while pending / active. */
  timer?: NodeJS.Timeout;
  /** Timer that polls `resolveWhen`. */
  poller?: NodeJS.Timeout;
  /** Notification channels requested by the step. */
  notify: string[];
}

/* --------------------------------------------------------------- messages */

/** Messages sent from server to the takeover client. */
export type ServerMessage =
  | {
      type: 'hello';
      session: TakeoverSessionInfo;
      frame?: { data: string; metadata: ScreencastMetadata };
    }
  | { type: 'frame'; data: string; metadata: ScreencastMetadata }
  | { type: 'state'; session: TakeoverSessionInfo }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number }
  | { type: 'resolved'; by: string }
  | { type: 'revoked'; reason: string };

/** Messages sent from the takeover client to the server. */
export type ClientMessage =
  | { type: 'claim' }
  | {
      type: 'mouse';
      action: 'move' | 'down' | 'up' | 'wheel';
      x: number;
      y: number;
      button?: string;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: string[];
      canvasWidth: number;
      canvasHeight: number;
    }
  | { type: 'key'; action: 'down' | 'up' | 'press'; key: string; modifiers?: string[] }
  | { type: 'text'; text: string }
  | { type: 'complete' }
  | { type: 'ping'; t: number };

/** Screencast frame metadata forwarded to the client (subset used for scaling). */
export interface ScreencastMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

/** Options for {@link TakeoverService.create}. */
export interface CreateTakeoverOptions {
  runId: string;
  stepId: string;
  reason: TakeoverReason;
  message: string;
  page: PagePort;
  timeoutMs: number;
  resolveWhen?: PageRule;
  notify?: string[];
}
