/**
 * Regression tests for page-condition matching (spec 5.3 / 5.6).
 *
 * The bug these lock down: `countSelector` returned \`null\` when the page
 * expression could not be evaluated (the browser adapter used to drop arguments
 * for string expressions). \`matchCondition\` then compared \`null === 0\`, which
 * is false, fell through the \`else if\` chain and reported a MATCH - so a
 * \`manual\` step's \`resolveWhen\` predicate was considered satisfied on a page
 * that never showed the expected element, resuming the run early.
 */
import { describe, expect, it } from 'vitest';
import { matchCondition, matchPage, matchesPattern } from './condition.js';
import type { PagePort } from './ports.js';

/** Page stub whose \`evaluate\` result is scripted per call. */
function stubPage(options: {
  url?: string;
  title?: string;
  evaluate?: (expr: string) => unknown;
}): PagePort {
  return {
    async url() {
      return options.url ?? 'https://example.test/';
    },
    async title() {
      return options.title ?? 'Example';
    },
    async fingerprint() {
      return { url: options.url ?? 'https://example.test/', title: options.title ?? 'Example' };
    },
    async evaluate<T>(expr: string): Promise<T> {
      return (options.evaluate ? options.evaluate(expr) : null) as T;
    },
  } as unknown as PagePort;
}

describe('matchCondition', () => {
  it('does NOT match when the selector count cannot be determined', async () => {
    // Exactly the old failure mode: evaluation yields null instead of a number.
    const page = stubPage({ evaluate: () => null });
    const result = await matchCondition(page, { selector: '#verified' });
    expect(result.matched).toBe(false);
    expect(result.reason).toContain('unavailable');
  });

  it('does not match while the awaited selector is absent', async () => {
    const page = stubPage({ evaluate: () => 0 });
    expect((await matchCondition(page, { selector: '#verified' })).matched).toBe(false);
  });

  it('matches once the awaited selector is present', async () => {
    const page = stubPage({ evaluate: () => 1 });
    expect((await matchCondition(page, { selector: '#verified' })).matched).toBe(true);
  });

  it('matches with an explicit count expectation', async () => {
    const page = stubPage({ evaluate: () => 3 });
    expect((await matchCondition(page, { selector: 'li', count: { gte: 2 } })).matched).toBe(true);
    expect((await matchCondition(page, { selector: 'li', count: { eq: 1 } })).matched).toBe(false);
  });
});

describe('matchPage (manual resolveWhen semantics)', () => {
  it('stays unmatched until every `all` condition holds', async () => {
    let solved = false;
    const page = stubPage({ evaluate: () => (solved ? 1 : 0) });

    const rule = { name: 'solved', match: { all: [{ selector: '#verified' }] } };
    expect((await matchPage(page, rule)).matched).toBe(false);

    solved = true;
    expect((await matchPage(page, rule)).matched).toBe(true);
  });
});

describe('matchesPattern', () => {
  it('supports exact, substring and /regex/ forms', () => {
    expect(matchesPattern('https://x.test/a', 'https://x.test/a')).toBe(true);
    expect(matchesPattern('https://x.test/a', 'x.test')).toBe(true);
    expect(matchesPattern('https://x.test/a', '/\\/a$/')).toBe(true);
    expect(matchesPattern('https://x.test/a', 'nope')).toBe(false);
  });
});
