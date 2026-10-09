/**
 * Matching for {@link PageRule} and `MatchCondition` fingerprints, plus
 * evaluation of `Condition` expressions used by `branch` steps.
 */
import type { Condition, MatchCondition, PageRule } from '../flow/schema.js';
import type { PagePort } from '../engine/ports.js';
import type { VariableStore } from '../vars/store.js';
import type { PageRegistry } from '../engine/context.js';
import { SelectorNotFoundError } from '../errors.js';

/** Detail describing why a page rule did or did not match (used in logs / UI). */
export interface MatchDetail {
  /** Name of the attempted rule. */
  rule: string;
  matched: boolean;
  /** `url` / `title` / `any` / `all`. */
  kind: 'url' | 'title' | 'any' | 'all';
  /** Human readable explanation. */
  reason: string;
}

/** Result returned by {@link matchPage}. */
export interface MatchResult {
  matched: boolean;
  details: MatchDetail[];
}

/** Subset of page info needed for fingerprint matching. */
export interface PageFingerprint {
  url: string;
  title: string;
}

/** Evaluate one DOM `MatchCondition` against the live page. */
export async function matchCondition(
  page: PagePort,
  condition: MatchCondition,
): Promise<{ matched: boolean; reason: string }> {
  const state = condition.state ?? (condition.selector ? 'attached' : undefined);

  if (condition.selector !== undefined) {
    const count = await countSelector(page, condition.selector);
    // A malformed/unsupported evaluation must never be treated as a satisfied
    // predicate: that silently let `resolveWhen` resume a manual step early.
    if (!Number.isFinite(count)) {
      return { matched: false, reason: `count(${condition.selector}) unavailable` };
    }
    if (condition.count) {
      if (condition.count.eq !== undefined && count !== condition.count.eq) {
        return {
          matched: false,
          reason: `count(${condition.selector})=${count} != ${condition.count.eq}`,
        };
      }
      if (condition.count.gte !== undefined && count < condition.count.gte) {
        return {
          matched: false,
          reason: `count(${condition.selector})=${count} < ${condition.count.gte}`,
        };
      }
    } else if (state === 'hidden') {
      if (count > 0) return { matched: false, reason: `selector ${condition.selector} is present` };
    } else if (count === 0) {
      return { matched: false, reason: `selector ${condition.selector} not found` };
    }
  }

  if (condition.text !== undefined) {
    const haystack = condition.selector
      ? ((await textOf(page, condition.selector)) ?? '')
      : await page.evaluate<string>('document.body ? document.body.innerText : ""');
    if (!haystack.includes(condition.text)) {
      return { matched: false, reason: `text "${condition.text}" not found` };
    }
  }

  return { matched: true, reason: 'ok' };
}

async function countSelector(page: PagePort, selector: string): Promise<number> {
  try {
    return await page.evaluate<number>(
      `(function (sel) {
         try { return document.querySelectorAll(sel).length; } catch (e) { return 0; }
       })`,
      selector,
    );
  } catch {
    return 0;
  }
}

async function textOf(page: PagePort, selector: string): Promise<string | null> {
  try {
    return await page.evaluate<string | null>(
      `(function (sel) {
         try { var el = document.querySelector(sel); return el ? (el.innerText || el.textContent || '') : null; }
         catch (e) { return null; }
       })`,
      selector,
    );
  } catch {
    return null;
  }
}

/**
 * Match a {@link PageRule} against the current page.
 *
 * Semantics: `url` and `title` are substring / regex-source matchers; `all`
 * conditions must all hold; `any` needs at least one. All supplied groups must
 * hold (logical AND across url/title/any/all).
 */
export async function matchPage(page: PagePort, rule: PageRule): Promise<MatchResult> {
  const fingerprint = await page.fingerprint();
  const details: MatchDetail[] = [];
  const name = rule.name ?? 'unnamed';

  if (rule.match.url !== undefined) {
    const matched = matchesPattern(fingerprint.url, rule.match.url);
    details.push({
      rule: name,
      matched,
      kind: 'url',
      reason: `url "${fingerprint.url}" ${matched ? '~' : '!~'} "${rule.match.url}"`,
    });
  }

  if (rule.match.title !== undefined) {
    const matched = matchesPattern(fingerprint.title, rule.match.title);
    details.push({
      rule: name,
      matched,
      kind: 'title',
      reason: `title "${fingerprint.title}" ${matched ? '~' : '!~'} "${rule.match.title}"`,
    });
  }

  if (rule.match.all) {
    for (const condition of rule.match.all) {
      const result = await matchCondition(page, condition);
      details.push({ rule: name, matched: result.matched, kind: 'all', reason: result.reason });
    }
  }

  if (rule.match.any) {
    const results: MatchDetail[] = [];
    let anyMatched = false;
    for (const condition of rule.match.any) {
      const result = await matchCondition(page, condition);
      if (result.matched) anyMatched = true;
      results.push({ rule: name, matched: result.matched, kind: 'any', reason: result.reason });
    }
    details.push({
      rule: name,
      matched: anyMatched,
      kind: 'any',
      reason: anyMatched ? 'at least one matched' : 'none matched',
    });
  }

  if (details.length === 0) {
    return {
      matched: false,
      details: [{ rule: name, matched: false, kind: 'all', reason: 'empty rule' }],
    };
  }

  return { matched: details.every((d) => d.matched), details };
}

/** Glob-ish matcher: exact, substring, or `/regex/` source. */
export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const end = pattern.lastIndexOf('/');
    const body = pattern.slice(1, end);
    const flags = pattern.slice(end + 1);
    try {
      return new RegExp(body, flags).test(value);
    } catch {
      return value.includes(body);
    }
  }
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      return new RegExp(`^${escaped}$`).test(value);
    } catch {
      return value === pattern;
    }
  }
  return value.includes(pattern);
}

/** Signature of the condition evaluator injected into the context. */
export type ConditionEvaluator = (condition: Condition) => Promise<boolean>;

/**
 * Build a condition evaluator bound to a page, variables and page registry.
 */
export function createConditionEvaluator(deps: {
  page: PagePort;
  vars: VariableStore;
  pages: PageRegistry;
}): ConditionEvaluator {
  const evaluate = async (condition: Condition): Promise<boolean> => {
    if ('pageIs' in condition) {
      const rule = await deps.pages.get(condition.pageIs);
      if (!rule) {
        throw new SelectorNotFoundError(
          condition.pageIs,
          `Unknown page "${condition.pageIs}". Known pages: ${deps.pages.names().join(', ') || '(none)'}`,
        );
      }
      const result = await matchPage(deps.page, rule);
      return result.matched;
    }
    if ('varEquals' in condition) {
      const { name, value } = condition.varEquals;
      const actual = deps.vars.tryGet(name);
      return deepEqual(actual, value);
    }
    if ('selectorExists' in condition) {
      const info = await deps.page.query(condition.selectorExists);
      return info !== null;
    }
    if ('not' in condition) {
      return !(await evaluate(condition.not));
    }
    if ('all' in condition) {
      const results = await Promise.all(condition.all.map((c) => evaluate(c)));
      return results.every(Boolean);
    }
    if ('any' in condition) {
      const results = await Promise.all(condition.any.map((c) => evaluate(c)));
      return results.some(Boolean);
    }
    const exhaustive: never = condition;
    return Boolean(exhaustive);
  };
  return evaluate;
}

/** Structural deep equality tolerant of ordering differences in objects. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}
