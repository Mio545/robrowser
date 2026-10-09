/**
 * Cancellable timing helpers.
 *
 * Spec 6 forbids固定 sleep for *waiting semantics*; this helper exists only for
 * explicit `delay`-style pauses, retry backoff and timeout budgets. It still
 * respects the run's AbortSignal so cancellation is immediate.
 */
import { RunAbortedError } from '../errors.js';

/**
 * Wait `ms`, rejecting with {@link RunAbortedError} when the signal aborts.
 *
 * @param ms - Duration in milliseconds.
 * @param signal - Optional cancellation signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RunAbortedError('run'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RunAbortedError('run'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Race a promise against a timeout.
 *
 * @param promise - Work to await.
 * @param timeoutMs - Budget in milliseconds; `<= 0` disables the timeout.
 * @param onTimeout - Factory producing the rejection error.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exponential backoff delay for a given attempt (1-based), capped. */
export function backoffDelay(
  attempt: number,
  policy: 'none' | 'linear' | 'exponential',
  baseMs = 250,
  capMs = 30_000,
): number {
  if (policy === 'none') return 0;
  const delay = policy === 'linear' ? baseMs * attempt : baseMs * 2 ** (attempt - 1);
  return Math.min(delay, capMs);
}
