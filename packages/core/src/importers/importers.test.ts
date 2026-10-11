/**
 * Script importer tests.
 *
 * The central guarantee is **round-trip idempotence**: feeding an exported
 * script back through the importer and re-exporting it must reproduce the same
 * source. That is what makes the importer a usable editing surface for
 * generated scripts — anything the exporter does not emit cannot be recovered,
 * but nothing that *is* emitted may be mangled.
 *
 * The second guarantee is **no silent loss on hand-written input**: unknown
 * constructs must surface as warnings.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FlowModel, Step } from '../flow/schema.js';
import { parseFlow } from '../flow/loader.js';
import { exportFlow, exportPlaywright, exportRawCdp } from '../exporters/index.js';
import { detectImportTarget, importFlow, importPlaywright, importRawCdp } from './index.js';
import { findMatching, splitTopLevel, tokenize } from './source.js';

/* ------------------------------------------------------------------ fixtures */

/** `flows/demo.json` — the flow shipped with the repository. */
function demoFlow(): FlowModel {
  const path = fileURLToPath(new URL('../../../../flows/demo.json', import.meta.url));
  return parseFlow(readFileSync(path, 'utf8'));
}

/**
 * A flow that exercises every step type and every option the exporters emit.
 *
 * Options the exporters ignore (`loop.maxIterations`, `waitForPage.timeout`,
 * `manual.timeoutMs`, …) are deliberately included: they must survive as *lost*
 * without breaking the round trip.
 */
function tortureFlow(): FlowModel {
  return {
    version: '1.0',
    id: 'torture',
    name: 'Torture: every step type',
    variables: {
      fixtures: { type: 'const', value: '../fixtures/' },
      user: { type: 'input', label: 'User name', default: 'alice' },
      token: { type: 'secret', key: 'DEMO_TOKEN', default: 's3cret' },
      host: { type: 'env', key: 'DEMO_HOST' },
    },
    steps: [
      { id: 'open', type: 'goto', url: '{{fixtures}}login.html', waitUntil: 'domcontentloaded' },
      { id: 'page-login', type: 'waitForPage', target: 'login', timeout: 10_000 },
      {
        id: 'wait-input',
        type: 'waitForSelector',
        selector: { css: '#username' },
        state: 'attached',
        timeout: 1_234,
      },
      { id: 'wait-url', type: 'waitForUrl', pattern: '/dashboard/i', timeout: 5_000 },
      { id: 'wait-glob', type: 'waitForUrl', pattern: '/app/*' },
      { id: 'type-plain', type: 'type', selector: { testId: 'username' }, value: '{{user}}' },
      {
        id: 'type-slow',
        type: 'type',
        selector: { css: '#password' },
        value: '{{token}}',
        clear: false,
        delayMs: 30,
        submit: true,
      },
      { id: 'pick', type: 'select', selector: { css: '#role' }, value: 'admin' },
      { id: 'hover-help', type: 'hover', selector: { role: 'button', name: 'Help' } },
      { id: 'scroll-to', type: 'scroll', selector: { css: '#footer' } },
      { id: 'scroll-by', type: 'scroll', x: 0, y: 400 },
      {
        id: 'click-row',
        type: 'click',
        selector: {
          candidates: [{ testId: 'row-1' }, { text: 'Row 1', exact: true }, { xpath: '//tr[1]' }],
        },
        button: 'right',
        clickCount: 2,
      },
      { id: 'idle', type: 'waitForNetworkIdle', idleMs: 250, timeout: 3_000 },
      { id: 'download', type: 'waitForDownload', saveTo: 'report.csv' },
      { id: 'read-orders', type: 'extract', selector: { css: '#orders' }, into: 'orders' },
      {
        id: 'read-href',
        type: 'extract',
        selector: { css: '#link' },
        attr: 'href',
        into: 'href',
      },
      { id: 'read-rows', type: 'extract', selector: { testId: 'row' }, into: 'rows', all: true },
      {
        id: 'read-ids',
        type: 'extract',
        selector: { testId: 'row' },
        attr: 'data-id',
        into: 'ids',
        all: true,
      },
      { id: 'shot', type: 'screenshot', fullPage: true },
      { id: 'shot-file', type: 'screenshot', saveTo: 'custom.png' },
      { id: 'counter', type: 'setVar', name: 'count', value: { n: 3, list: [1, 2] } },
      {
        id: 'guard',
        type: 'branch',
        condition: {
          any: [
            { pageIs: 'dashboard' },
            { varEquals: { name: 'count', value: 'failed' } },
            { selectorExists: { testId: 'welcome' } },
            { not: { selectorExists: { css: '#error' } } },
            { all: [{ selectorExists: { css: '#a' } }, { any: [{ selectorExists: { css: '#b' } }] }] },
          ],
        },
        then: [{ id: 'inner-set', type: 'setVar', name: 'ok', value: true }],
        else: [
          {
            id: 'inner-branch',
            type: 'branch',
            condition: { selectorExists: { css: '#x' } },
            then: [{ id: 'deep-set', type: 'setVar', name: 'deep', value: 1 }],
          },
        ],
      },
      {
        id: 'per-row',
        type: 'loop',
        items: 'rows',
        as: 'row',
        maxIterations: 5,
        steps: [{ id: 'cell', type: 'extract', selector: { css: '.cell' }, into: 'cell' }],
      },
      {
        id: 'per-literal',
        type: 'loop',
        items: ['a', 'b'],
        as: 'letter',
        steps: [{ id: 'tag', type: 'setVar', name: 'tagged', value: 'yes' }],
      },
      {
        id: 'api',
        type: 'httpCall',
        method: 'post',
        url: 'https://api.example.com/x?u={{user}}',
        headers: { 'X-Token': '{{token}}' },
        body: { keep: true },
        into: 'response',
      },
      { id: 'human', type: 'manual', reason: 'captcha', message: 'solve the captcha' },
    ],
  };
}

/** Export -> import -> export, twice. */
function roundTrip(target: 'playwright' | 'raw-cdp', flow: FlowModel) {
  const first = exportFlow(flow, target);
  const firstImport = importFlow(first, target);
  const second = exportFlow(firstImport.flow, target);
  const secondImport = importFlow(second, target);
  const third = exportFlow(secondImport.flow, target);
  return { first, firstImport, second, secondImport, third };
}

/** Flatten a step tree, for order/type assertions. */
function flatten(steps: readonly Step[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.type === 'branch') {
      out.push(...flatten(step.then));
      if (step.else) out.push(...flatten(step.else));
    } else if (step.type === 'loop') {
      out.push(...flatten(step.steps));
    }
  }
  return out;
}

/* ------------------------------------------------------------------- fixtures */

describe.each(['playwright', 'raw-cdp'] as const)('%s round trip', (target) => {
  it('reproduces the demo flow script byte for byte', () => {
    const { first, second, third } = roundTrip(target, demoFlow());
    expect(second).toBe(first);
    expect(third).toBe(second);
  });

  it('reproduces the every-step-type script byte for byte', () => {
    const { first, second, third } = roundTrip(target, tortureFlow());
    expect(second).toBe(first);
    expect(third).toBe(second);
  });

  it('produces syntactically valid JavaScript', () => {
    // `new Function` only compiles; it never runs the script.
    expect(() => new Function(exportFlow(tortureFlow(), target))).not.toThrow();
    expect(() => new Function(exportFlow(demoFlow(), target))).not.toThrow();
  });

  it('preserves step ids, order and nesting', () => {
    const { firstImport } = roundTrip(target, tortureFlow());
    expect(firstImport.flow.id).toBe('torture');
    expect(firstImport.flow.name).toBe('Torture: every step type');
    expect(flatten(firstImport.flow.steps).map((step) => step.id)).toEqual(
      flatten(tortureFlow().steps).map((step) => step.id),
    );
    expect(firstImport.flow.steps.map((step) => step.type)).toEqual(
      tortureFlow().steps.map((step) => step.type),
    );
  });

  it('marks exporter-generated scripts as generated', () => {
    const { firstImport } = roundTrip(target, demoFlow());
    expect(firstImport.generated).toBe(true);
    expect(firstImport.stats.steps).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- playwright */

describe('importPlaywright', () => {
  it('recovers selectors, options and variables from the demo flow', () => {
    const result = importPlaywright(exportPlaywright(demoFlow()));

    const goto = result.flow.steps[0];
    expect(goto).toMatchObject({ id: 'open-login', type: 'goto', url: '{{fixtures}}login.html' });

    const submit = result.flow.steps.find((step) => step.id === 'submit');
    expect(submit).toMatchObject({
      type: 'click',
      selector: {
        candidates: [{ role: 'button', name: 'Sign in' }, { testId: 'submit' }],
      },
    });

    const branch = result.flow.steps.find((step) => step.id === 'branch-on-dashboard');
    expect(branch?.type).toBe('branch');
    if (branch?.type !== 'branch') throw new Error('expected a branch');
    expect(branch.condition).toEqual({ selectorExists: { testId: 'welcome' } });
    expect(branch.then.map((step) => step.id)).toEqual(['read-orders', 'read-activities', 'shot']);
    expect(branch.else?.map((step) => step.id)).toEqual(['read-error']);

    expect(result.flow.variables).toMatchObject({
      fixtures: { type: 'const', value: '../fixtures/' },
      username: { type: 'input', default: 'alice' },
      password: { type: 'env', key: 'DEMO_PASSWORD', default: 's3cret' },
    });
    // The `secret` / `input` distinctions are not recoverable from the script.
    expect(result.warnings.map((warning) => warning.message)).toContainEqual(
      expect.stringContaining('env 与 secret'),
    );
  });

  it('collapses click + fill + pressSequentially back into one type step', () => {
    const flow: FlowModel = {
      version: '1.0',
      id: 'typing',
      name: 'Typing',
      steps: [
        {
          id: 'slow',
          type: 'type',
          selector: { css: '#search' },
          value: 'hello',
          clear: false,
          delayMs: 20,
        },
      ],
    };
    const script = exportPlaywright(flow);
    expect(script).toContain('pressSequentially');

    const imported = importPlaywright(script).flow.steps;
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      id: 'slow',
      type: 'type',
      value: 'hello',
      clear: false,
      delayMs: 20,
    });
  });

  it('imports a hand-written script using the page-level API', () => {
    const script = `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://example.com/login', { waitUntil: 'networkidle' });
  await page.fill('#username', 'alice');
  await page.locator('#password').fill('secret');
  await page.click('button[type="submit"]');
  await page.waitForSelector('#welcome', { timeout: 2000 });
  await page.selectOption('#role', 'admin');
  await page.hover('#menu');
  await page.screenshot({ path: 'after-login.png', fullPage: true });
})();
`;
    const result = importPlaywright(script);
    expect(flatten(result.flow.steps).map((step) => step.type)).toEqual([
      'goto',
      'type',
      'type',
      'click',
      'waitForSelector',
      'select',
      'hover',
      'screenshot',
    ]);
    // `networkidle` is normalised to `load` because the exporter only emits
    // `load` / `domcontentloaded`.
    expect(result.flow.steps[0]).toMatchObject({ type: 'goto', waitUntil: 'load' });
    expect(result.flow.steps[1]).toMatchObject({
      type: 'type',
      selector: { css: '#username' },
      value: 'alice',
      clear: true,
    });
    expect(result.flow.steps[4]).toMatchObject({
      type: 'waitForSelector',
      timeout: 2000,
      state: 'visible',
    });
    const shot = result.flow.steps[7];
    expect(shot).toMatchObject({ type: 'screenshot', saveTo: 'after-login.png', fullPage: true });
    expect(result.warnings).toEqual([]);
  });

  it('reports unmappable statements instead of dropping them silently', () => {
    const script = `
const { chromium } = require('playwright');
(async () => {
  const page = await chromium.launch().then((b) => b.newPage());
  await page.goto('https://example.com');
  await page.route('**/*', (route) => route.abort());
  await page.locator('#go').click();
})();
`;
    const result = importPlaywright(script);
    expect(result.flow.steps.map((step) => step.type)).toEqual(['goto', 'click']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain('无法映射');
    expect(result.warnings[0]?.snippet).toContain('page.route');
  });

  it('rejects a script with no recognisable entry point', () => {
    expect(() => importPlaywright('const answer = 42;\n')).toThrow(/无法定位主流程/);
  });

  it('rejects a script whose statements are all unmappable', () => {
    expect(() =>
      importPlaywright('(async () => {\n  await page.route("**/*", (r) => r.abort());\n})();'),
    ).toThrow(/未从脚本中识别出任何可映射的步骤/);
  });
});

/* ------------------------------------------------------------------ raw-cdp */

describe('importRawCdp', () => {
  it('recovers an extract with attributes (regression: invalid escaped output)', () => {
    const flow: FlowModel = {
      version: '1.0',
      id: 'attrs',
      name: 'Attribute reads',
      steps: [
        {
          id: 'href',
          type: 'extract',
          selector: { css: '#link' },
          attr: 'href',
          into: 'href',
        },
        {
          id: 'ids',
          type: 'extract',
          selector: { testId: 'row' },
          attr: 'data-id',
          into: 'ids',
          all: true,
        },
      ],
    };
    const script = exportRawCdp(flow);
    // The attribute name used to be interpolated unescaped into a quoted JS
    // string, producing a script that could not even be parsed.
    expect(() => new Function(script)).not.toThrow();

    const imported = importRawCdp(script).flow.steps;
    expect(imported[0]).toMatchObject({ type: 'extract', attr: 'href', into: 'href' });
    expect(imported[1]).toMatchObject({
      type: 'extract',
      attr: 'data-id',
      into: 'ids',
      all: true,
    });
  });

  it('recovers select, scroll and wait steps', () => {
    const imported = importRawCdp(exportRawCdp(tortureFlow())).flow;
    const byId = new Map(flatten(imported.steps).map((step) => [step.id, step]));
    expect(byId.get('pick')).toMatchObject({ type: 'select', value: 'admin' });
    expect(byId.get('scroll-by')).toMatchObject({ type: 'scroll', x: 0, y: 400 });
    expect(byId.get('scroll-to')).toMatchObject({ type: 'scroll' });
    // raw-CDP has no notion of `attached`, so only the selector and timeout
    // survive; the re-export is unchanged either way.
    expect(byId.get('wait-input')).toMatchObject({ type: 'waitForSelector', timeout: 1234 });
    expect(byId.get('download')).toMatchObject({ type: 'waitForDownload' });
    expect(byId.get('idle')).toMatchObject({ type: 'waitForNetworkIdle', idleMs: 250 });
  });

  it('rejects a script with no recognisable entry point', () => {
    expect(() => importRawCdp('const answer = 42;\n')).toThrow(/无法定位主流程/);
  });
});

/* ------------------------------------------------------------ dispatch aids */

describe('importFlow / detectImportTarget', () => {
  it('dispatches to both targets', () => {
    const flow = demoFlow();
    const script = exportPlaywright(flow);
    expect(importFlow(script, 'playwright').flow.steps).toEqual(
      importPlaywright(script).flow.steps,
    );
    const raw = exportRawCdp(flow);
    expect(importFlow(raw, 'raw-cdp').flow.steps).toEqual(importRawCdp(raw).flow.steps);
  });

  it('sniffs the script flavour', () => {
    expect(detectImportTarget(exportPlaywright(demoFlow()))).toBe('playwright');
    expect(detectImportTarget(exportRawCdp(demoFlow()))).toBe('raw-cdp');
    expect(detectImportTarget('console.log("nope");')).toBeNull();
  });
});

/* ------------------------------------------------------------------ scanner */

describe('source scanner', () => {
  it('does not split statements on the `;` inside a for-header', () => {
    const items = tokenize('for (let i = 0; i < 3; i += 1) {\n  x();\n}\ny();');
    const statements = items.filter((item) => item.kind === 'stmt').map((item) => item.text);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('for (let i = 0; i < 3; i += 1)');
    expect(statements[1]).toBe('y();');
  });

  it('ignores brackets and keywords inside strings, regexes and templates', () => {
    const items = tokenize(
      [
        'const re = /[;,]{2}/g;',
        "const s = '; } { ;';",
        'const t = `a ${vars["x"]} ; b`;',
        'const u = a / b;',
      ].join('\n'),
    );
    const statements = items.filter((item) => item.kind === 'stmt');
    expect(statements).toHaveLength(4);
  });

  it('matches balanced brackets and splits top-level lists', () => {
    expect(findMatching('f(a, [b, c], {d: 1})', 1)).toBe(19);
    expect(splitTopLevel('a, [b, c], {d: e, f: g}', ',')).toEqual(['a', '[b, c]', '{d: e, f: g}']);
  });
});
