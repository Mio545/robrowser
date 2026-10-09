/**
 * Default page fingerprint registry.
 *
 * Flows reference pages by name (`waitForPage.target`, `Condition.pageIs`). The
 * registry maps those names to {@link PageRule} fingerprints. Hosts can override
 * or extend it; this default covers the bundled local fixtures so the demo flow
 * and the integration tests are self-contained.
 *
 * Rules match on URL substrings (case-insensitive) which keeps them portable
 * across file:// paths on Windows and Linux.
 */
import type { PageRegistry } from '../engine/context.js';
import type { PageRule } from './schema.js';

/** Built-in fingerprints for the bundled fixtures. */
export const DEFAULT_PAGE_RULES: Record<string, PageRule> = {
  login: {
    name: 'login',
    match: { url: 'fixtures/login.html', title: 'Sign in' },
  },
  dashboard: {
    name: 'dashboard',
    match: { url: 'fixtures/dashboard.html', any: [{ selector: '[data-testid="welcome"]' }] },
  },
  captcha: {
    name: 'captcha',
    match: { url: 'fixtures/captcha.html', title: 'Verify' },
  },
  iframe: {
    name: 'iframe',
    match: { url: 'fixtures/iframe.html' },
  },
};

/**
 * Build a page registry.
 *
 * @param rules - Rules to expose; defaults to {@link DEFAULT_PAGE_RULES}.
 * @param extended - When true, the defaults stay available alongside `rules`.
 */
export function createPageRegistry(
  rules: Record<string, PageRule> = DEFAULT_PAGE_RULES,
  extended = false,
): PageRegistry {
  const table = extended ? { ...DEFAULT_PAGE_RULES, ...rules } : rules;
  return {
    get: (name) => table[name] ?? null,
    names: () => Object.keys(table),
  };
}
