/**
 * Local manual handler for the desktop host (spec 5.6 / 9).
 *
 * When the engine reaches a `manual` step the embedded browser keeps showing the
 * live page; the main process asks the renderer to open the "human needed"
 * dialog. The user interacts with the WebContentsView directly (it is the real
 * browser, not a screencast), then clicks "继续" which calls
 * {@link LocalManualHandler.resolve}.
 *
 * The handler also honours `resolveWhen`: even if the operator forgets to press
 * the button, the page predicate is polled and the run resumes automatically.
 */
import type {
  ManualHandler,
  ManualRequest,
  ManualResult,
  PageRule,
  PagePort,
} from '@robrowser/core';
import { matchPage } from '@robrowser/core';

/** Callbacks the main process provides to talk to the renderer. */
export interface LocalManualHost {
  /** Show the manual dialog in the renderer. */
  notify(request: ManualRequest): void;
  /** Hide the dialog (run resumed / timed out). */
  settled(request: ManualRequest, result: ManualResult): void;
}

/** One in-flight manual request. */
interface Pending {
  request: ManualRequest;
  resolve: (result: ManualResult) => void;
  timer: NodeJS.Timeout;
  poller?: NodeJS.Timeout;
}

/** Poll a completion predicate until it matches or the window expires. */
async function waitForRule(page: PagePort, rule: PageRule, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await matchPage(page, rule).catch(() => ({ matched: false, details: [] }));
    if (result.matched) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

/** Desktop {@link ManualHandler}: waits for a human in the embedded browser. */
export class LocalManualHandler implements ManualHandler {
  private pending: Pending | undefined;

  public constructor(private readonly host: LocalManualHost) {}

  public async request(request: ManualRequest): Promise<ManualResult> {
    if (this.pending) {
      return { status: 'aborted' };
    }
    return new Promise<ManualResult>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(request, { status: 'timeout' });
      }, request.timeoutMs);
      timer.unref?.();

      const entry: Pending = { request, resolve, timer };

      if (request.resolveWhen) {
        entry.poller = setInterval(() => {
          void this.checkResolveWhen(request, request.resolveWhen!);
        }, 1_000);
        entry.poller.unref?.();
      }

      this.pending = entry;
      this.host.notify(request);
    });
  }

  /**
   * The operator pressed "继续" in the dialog.
   *
   * @returns `true` when the manual step settled, `false` when the completion
   *   predicate (`resolveWhen`) was still unsatisfied, so the caller can keep
   *   the dialog open instead of reporting a false success.
   */
  public async resolve(stepId: string, by = 'local'): Promise<boolean> {
    const pending = this.pending;
    if (!pending || pending.request.stepId !== stepId) return false;
    // Mirror the headless behaviour: verify `resolveWhen` for a short window
    // before resuming, so "继续" cannot skip an unfinished challenge.
    if (pending.request.resolveWhen) {
      const satisfied = await waitForRule(pending.request.page, pending.request.resolveWhen, 3_000);
      if (!satisfied) return false;
    }
    this.settle(pending.request, { status: 'resolved', by });
    return true;
  }

  /** Abort the current manual step (run cancelled). */
  public abort(): void {
    if (!this.pending) return;
    this.settle(this.pending.request, { status: 'aborted' });
  }

  /** True when a manual step is waiting. */
  public get active(): boolean {
    return this.pending !== undefined;
  }

  private async checkResolveWhen(request: ManualRequest, rule: PageRule): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.request.stepId !== request.stepId) return;
    try {
      const result = await matchPage(request.page, rule);
      if (result.matched) this.settle(request, { status: 'resolved', by: 'auto' });
    } catch {
      // Page may be navigating; try again next tick.
    }
  }

  private settle(request: ManualRequest, result: ManualResult): void {
    const pending = this.pending;
    if (!pending || pending.request.stepId !== request.stepId) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.poller) clearInterval(pending.poller);
    this.host.settled(request, result);
    pending.resolve(result);
  }
}

/** Keep the TS import of `PagePort` meaningful for consumers of this file. */
export type { PagePort };
