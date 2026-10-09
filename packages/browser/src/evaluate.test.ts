/**
 * Regression tests for the `CdpPage.evaluate` argument-passing bug.
 *
 * Before the fix, a string expression plus arguments (as used by
 * `core/engine/condition.ts`) was sent to `Runtime.evaluate` WITHOUT being
 * invoked. The IIFE was returned by value as `undefined`, `countSelector`
 * produced null, and `matchCondition` then reported a false positive - which
 * let `manual.resolveWhen` resume a step that was not actually satisfied.
 *
 * These tests use a mock CDPSession, so no browser is required.
 */
import { describe, expect, it } from 'vitest';
import { CdpPage } from './adapter.js';
import type { CDPSession, CdpEventHandler } from './cdp-session.js';

/** Records every Runtime.evaluate expression and returns a canned value. */
function recordingSession(value: unknown): {
  session: CDPSession;
  expressions: string[];
} {
  const expressions: string[] = [];
  const session: CDPSession = {
    async send<T>(method: string, params?: object): Promise<T> {
      if (method === 'Runtime.evaluate') {
        expressions.push(String((params as { expression?: unknown } | undefined)?.expression));
        return { result: { value } } as T;
      }
      return {} as T;
    },
    on(_event: string, _handler: CdpEventHandler): void {},
    off(_event: string, _handler: CdpEventHandler): void {},
    async detach(): Promise<void> {},
  };
  return { session, expressions };
}

describe('CdpPage.evaluate argument passing', () => {
  it('invokes a STRING expression with its arguments (previously dropped)', async () => {
    const { session, expressions } = recordingSession(2);
    const page = new CdpPage(session, 'test');

    const count = await page.evaluate<number>(
      '(function (sel) { return document.querySelectorAll(sel).length; })',
      '#missing',
    );

    expect(count).toBe(2);
    const expression = expressions[0] ?? '';
    // The IIFE must actually be called with the serialized selector.
    expect(expression).toContain('.apply(null, ["#missing"])');
  });

  it('leaves a bare string expression uninvoked (e.g. location.href)', async () => {
    const { session, expressions } = recordingSession('https://example.test/');
    const page = new CdpPage(session, 'test');

    await page.evaluate<string>('location.href');

    expect(expressions[0]).toBe('location.href');
  });

  it('still invokes function expressions with arguments', async () => {
    const { session, expressions } = recordingSession(3);
    const page = new CdpPage(session, 'test');

    await page.evaluate<number>((sel: string) => sel.length, 'abc');

    expect(expressions[0]).toContain('.apply(null, ["abc"])');
  });
});
