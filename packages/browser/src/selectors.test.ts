/**
 * SelectorSpec resolution tests (spec 6 / 11: browser package).
 *
 * The regression that motivated these tests: a `{ role, name }` selector used
 * to fall back to an unscoped `//*[contains(...)]`, which matched `<html>` and
 * made clicks land on the document body instead of the intended button.
 */
import { describe, expect, it } from 'vitest';
import { describeSelector, resolveSelectorSpec } from './selectors.js';

describe('resolveSelectorSpec', () => {
  it('maps data-testid to a CSS attribute selector', () => {
    expect(resolveSelectorSpec({ testId: 'submit' })).toEqual([
      { kind: 'css', value: '[data-testid="submit"]', source: { testId: 'submit' } },
    ]);
  });

  it('passes plain strings and css/xpath through verbatim', () => {
    expect(resolveSelectorSpec('#a').map((r) => r.value)).toEqual(['#a']);
    expect(resolveSelectorSpec({ css: '#b' }).map((r) => r.value)).toEqual(['#b']);
    expect(resolveSelectorSpec({ xpath: '//div' }).map((r) => r.value)).toEqual(['//div']);
  });

  it('flattens candidates in declaration order (all are tried)', () => {
    const resolved = resolveSelectorSpec({
      candidates: [{ testId: 'one' }, { css: '#two' }, { text: 'three' }],
    });
    expect(resolved.map((r) => r.value)).toEqual([
      '[data-testid="one"]',
      '#two',
      expect.stringContaining('three') as unknown as string,
    ]);
  });

  it('flattens nested candidates', () => {
    const resolved = resolveSelectorSpec({
      candidates: [{ candidates: [{ css: '#a' }, { css: '#b' }] }, { css: '#c' }],
    });
    expect(resolved.map((r) => r.value)).toEqual(['#a', '#b', '#c']);
  });

  it('matches role without a name using [role=…] plus implicit roles', () => {
    const resolved = resolveSelectorSpec({ role: 'button' });
    const values = resolved.map((r) => r.value);
    expect(values).toContain('[role="button"]');
    expect(values).toContain('button');
  });

  it('never emits an unscoped //* fallback for named roles (regression)', () => {
    const resolved = resolveSelectorSpec({ role: 'button', name: 'Sign in' });
    expect(resolved.length).toBeGreaterThan(0);
    for (const entry of resolved) {
      expect(entry.value).not.toMatch(/^\/\/\*/);
    }
    // Accessible-name approximations are tried first.
    expect(resolved[0]?.value).toContain('aria-label');
    expect(
      resolved.some((entry) => entry.kind === 'xpath' && entry.value.startsWith('//button[')),
    ).toBe(true);
  });

  it('builds exact and fuzzy text XPath selectors', () => {
    const fuzzy = resolveSelectorSpec({ text: 'Sign in' })[0]!;
    expect(fuzzy.kind).toBe('xpath');
    expect(fuzzy.value).toContain('normalize-space');

    const exact = resolveSelectorSpec({ text: 'Sign in', exact: true })[0]!;
    expect(exact.kind).toBe('xpath');
    expect(exact.value).toContain('=');
  });

  it('escapes quotes / special characters in testId and role names', () => {
    const [testId] = resolveSelectorSpec({ testId: 'we"ird' });
    expect(testId?.value).toBe('[data-testid="we\\"ird"]');
    const [role] = resolveSelectorSpec({ role: 'button', name: "it's" });
    expect(role?.value).toContain('"it\'s"');
  });

  it('returns an empty list for malformed input from untyped callers', () => {
    expect(resolveSelectorSpec({} as never)).toEqual([]);
  });
});

describe('describeSelector', () => {
  it('renders a human readable summary', () => {
    expect(describeSelector({ candidates: [{ testId: 'a' }, 'b'] })).toBe(
      'css=[data-testid="a"] | css=b',
    );
  });
});
