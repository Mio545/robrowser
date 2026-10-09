/**
 * SelectorSpec resolution (spec 6).
 *
 * The engine hands us a `SelectorSpec`; this module turns it into an ordered
 * list of concrete CSS/XPath strategies and a browser-side matcher function so
 * that CDP `Runtime.evaluate` can find the element.
 *
 * Priority (per spec): data-testid -> role -> text -> css -> xpath. `candidates`
 * is flattened in declaration order, and every candidate is tried in order.
 */
import type { SelectorSpec } from '@robrowser/core';

/** One concrete strategy derived from a `SelectorSpec`. */
export interface ResolvedSelector {
  /** The strategy used, for error messages and tests. */
  kind: 'css' | 'xpath';
  /** The selector string handed to the DOM. */
  value: string;
  /** The original spec fragment (for diagnostics). */
  source: SelectorSpec;
}

/**
 * Flatten a {@link SelectorSpec} into an ordered list of DOM strategies.
 *
 * @param spec - The selector specification from the flow.
 * @returns Ordered strategies; never empty for a valid spec.
 */
export function resolveSelectorSpec(spec: SelectorSpec): ResolvedSelector[] {
  if (Array.isArray(spec)) {
    // Guard against malformed input from untyped JS callers.
    return spec.flatMap((entry) => resolveSelectorSpec(entry as SelectorSpec));
  }
  if (typeof spec === 'string') {
    return [{ kind: 'css', value: spec, source: spec }];
  }
  if ('candidates' in spec) {
    return spec.candidates.flatMap((candidate) => resolveSelectorSpec(candidate));
  }
  if ('testId' in spec) {
    return [{ kind: 'css', value: `[data-testid="${cssEscape(spec.testId)}"]`, source: spec }];
  }
  if ('role' in spec) {
    // ARIA role matching: `[role=x]` plus implicit roles for common elements.
    const implicit = implicitRoleSelectors(spec.role);
    const attr = `[role="${cssEscape(spec.role)}"]`;
    const all = [attr, ...implicit];
    if (spec.name !== undefined) {
      const name = cssEscape(spec.name);
      // Accessible-name approximations, most specific first:
      //   1. explicit aria-label / title on role-bearing elements;
      //   2. the element's own text content, scoped to the role's concrete tags
      //      (never match <html>/<body> the way an unscoped //* fallback would).
      const ariaNamed = all.map<ResolvedSelector>((base) => ({
        kind: 'css',
        value: `${base}:is([aria-label="${name}"],[title="${name}"])`,
        source: spec,
      }));
      const textNamed = [...new Set(all.flatMap(tagNamesFor))].map<ResolvedSelector>((tag) => ({
        kind: 'xpath',
        value: `//${tag}[contains(normalize-space(string(.)), ${xpathLiteral(spec.name!)})]`,
        source: spec,
      }));
      return [...ariaNamed, ...textNamed];
    }
    return all.map<ResolvedSelector>((value) => ({ kind: 'css', value, source: spec }));
  }
  if ('text' in spec) {
    const value = spec.exact ? xpathExactText(spec.text) : xpathByText(spec.text);
    return [{ kind: 'xpath', value, source: spec }];
  }
  if ('css' in spec) {
    return [{ kind: 'css', value: spec.css, source: spec }];
  }
  if ('xpath' in spec) {
    return [{ kind: 'xpath', value: spec.xpath, source: spec }];
  }
  return [];
}

/**
 * Turn a CSS selector produced by {@link implicitRoleSelectors} into tag names.
 *
 * The named-role fallback must be scoped to concrete tags; an unscoped
 * `//*[contains(...)]` would match `<html>` for nearly every page.
 */
function tagNamesFor(selector: string): string[] {
  const match = /^[a-z0-9]+/i.exec(selector);
  return match ? [match[0].toLowerCase()] : [];
}

/** Implicit ARIA role selectors for elements that do not carry `role=`. */
function implicitRoleSelectors(role: string): string[] {
  switch (role) {
    case 'button':
      return ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]'];
    case 'link':
      return ['a[href]'];
    case 'textbox':
      return [
        'input:not([type])',
        'input[type="text"]',
        'input[type="email"]',
        'input[type="password"]',
        'textarea',
      ];
    case 'checkbox':
      return ['input[type="checkbox"]'];
    case 'radio':
      return ['input[type="radio"]'];
    case 'combobox':
      return ['select'];
    case 'heading':
      return ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    case 'list':
      return ['ul', 'ol'];
    case 'listitem':
      return ['li'];
    case 'img':
      return ['img'];
    default:
      return [];
  }
}

/** XPath matching elements whose normalised text contains `text`. */
function xpathByText(text: string): string {
  return `//*[contains(normalize-space(string(.)), ${xpathLiteral(text)})]`;
}

/** XPath matching elements whose normalised text equals `text`. */
function xpathExactText(text: string): string {
  return `//*[normalize-space(string(.)) = ${xpathLiteral(text)}]`;
}

/** Quote a string for use inside an XPath literal (handles quotes correctly). */
export function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  const parts = value.split("'");
  return `concat(${parts.map((part) => `'${part}'`).join(', "\'", ')})`;
}

/** Escape a string for use inside a CSS attribute selector. */
export function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a self-contained JS expression that finds the first element matching any
 * of the resolved strategies.
 *
 * The expression is a function body evaluated with `Runtime.evaluate`, so it can
 * also be inlined into the injected helper for repeated use.
 *
 * @param strategies - Ordered strategies from {@link resolveSelectorSpec}.
 * @returns A JS expression returning the element or `null`.
 */
export function buildQueryExpression(strategies: readonly ResolvedSelector[]): string {
  const checks = strategies.map((strategy) => {
    if (strategy.kind === 'css') {
      return `{kind:'css',value:${JSON.stringify(strategy.value)},source:${JSON.stringify(strategy.source)}}`;
    }
    return `{kind:'xpath',value:${JSON.stringify(strategy.value)},source:${JSON.stringify(strategy.source)}}`;
  });
  return `(function(){var strategies=[${checks.join(',')}];
for(var i=0;i<strategies.length;i++){
  var s=strategies[i], node=null;
  try{
    if(s.kind==='css'){ node=document.querySelector(s.value); }
    else { node=document.evaluate(s.value,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue; }
  }catch(e){ node=null; }
  if(node){ return {node:node,kind:s.kind,value:s.value,index:i}; }
}
return null;})()`;
}

/**
 * Build an expression returning *all* elements matching the first strategy that
 * yields at least one node (mirrors the engine's candidate semantics).
 */
export function buildQueryAllExpression(strategies: readonly ResolvedSelector[]): string {
  const checks = strategies.map((strategy) =>
    strategy.kind === 'css'
      ? `{kind:'css',value:${JSON.stringify(strategy.value)}}`
      : `{kind:'xpath',value:${JSON.stringify(strategy.value)}}`,
  );
  return `(function(){var strategies=[${checks.join(',')}];
for(var i=0;i<strategies.length;i++){
  var s=strategies[i], nodes=[];
  try{
    if(s.kind==='css'){ nodes=Array.from(document.querySelectorAll(s.value)); }
    else {
      var it=document.evaluate(s.value,document,null,XPathResult.ORDERED_NODE_ITERATOR_TYPE,null), n;
      while((n=it.iterateNext())){ nodes.push(n); }
    }
  }catch(e){ nodes=[]; }
  if(nodes.length>0){ return nodes; }
}
return [];})()`;
}

/**
 * Compact, human readable selector description for logs / error messages.
 */
export function describeSelector(spec: SelectorSpec): string {
  return resolveSelectorSpec(spec)
    .map((strategy) => `${strategy.kind}=${strategy.value}`)
    .join(' | ');
}
