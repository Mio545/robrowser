/**
 * FlowModel -> raw CDP script exporter (spec 5.5).
 *
 * The emitted script talks the DevTools Protocol directly over WebSocket (no
 * Playwright). It reuses the same runtime helpers the engine uses, but inlined
 * so the output is dependency-free apart from `ws`.
 *
 * Environment:
 *   CDP_WS_URL  full webSocketDebuggerUrl of a page target (required)
 *   ROBO_OUT    output directory for screenshots/downloads
 */
import type { FlowModel, SelectorSpec, Step, VariableDef } from '../flow/schema.js';
import { ExportError } from '../errors.js';

/** Options for {@link exportRawCdp}. */
export interface RawCdpOptions {
  /** Indentation width (default 2). */
  indent?: number;
  /**
   * Directory the flow was loaded from. Relative `goto` URLs resolve against it
   * (mirroring `core/flow/url.ts`) so the generated script runs from anywhere.
   */
  flowDir?: string;
}

/**
 * Convert a flow into a standalone raw-CDP script.
 *
 * @param flow - Validated FlowModel.
 * @param options - Emission options.
 * @returns Script source that connects to `CDP_WS_URL`.
 */
export function exportRawCdp(flow: FlowModel, options: RawCdpOptions = {}): string {
  return new RawCdpEmitter(flow, options).render();
}

const RUNTIME = `// --- minimal CDP runtime -----------------------------------------------------
/**
 * Resolve a flow-authored URL exactly like the engine does (see
 * core/flow/url.ts): absolute URLs pass through, relative paths resolve against
 * ROBO_FLOW_DIR and become file:// URLs.
 */
function resolveFlowUrl(url) {
  const raw = String(url);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
  const path = require('node:path');
  const base = process.env.ROBO_FLOW_DIR || __ROBO_FLOW_DIR__ || process.cwd();
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(base, raw);
  return require('node:url').pathToFileURL(absolute).href;
}

/**
 * Thin CDP client over a single page target. Intentionally small: it covers
 * exactly the domains the generated script needs (Page, Runtime, DOM, Input).
 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      for (const handler of this.listeners.get(message.method) ?? []) {
        handler(message.params, message.sessionId);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }
}

async function openCdp(url) {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new Cdp(ws);
}

/** Poll a browser-side predicate until it returns truthy. */
async function waitFor(cdp, expression, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result && result.value) return result.value;
    if (Date.now() > deadline) throw new Error('Timeout waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Click the centre of an element located by a CSS selector. */
async function clickSelector(cdp, selector, clickCount = 1) {
  const box = await elementBox(cdp, selector);
  for (let i = 1; i <= clickCount; i += 1) {
    const common = { x: box.x, y: box.y, button: 'left', clickCount: i };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  }
}

async function elementBox(cdp, selector) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: \`(function(){var el=document.querySelector(\${JSON.stringify(selector)});if(!el)return null;var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height};})()\`,
    returnByValue: true,
  });
  if (!result || !result.value) throw new Error('Selector not found: ' + selector);
  return result.value;
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || 'evaluate failed');
  return result ? result.value : undefined;
}

/** Move the mouse over the centre of an element (CSS hover). */
async function hoverSelector(cdp, selector) {
  const box = await elementBox(cdp, selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
}

async function typeInto(cdp, selector, text, clear = true) {
  const box = await elementBox(cdp, selector);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  if (clear) {
    await cdp.send('Runtime.evaluate', { expression: \`(function(){var el=document.querySelector(\${JSON.stringify(selector)});if(el){el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));}})()\` });
  }
  await cdp.send('Input.insertText', { text });
}
// -----------------------------------------------------------------------------`;

class RawCdpEmitter {
  private readonly lines: string[] = [];
  private readonly indentUnit: string;

  public constructor(
    private readonly flow: FlowModel,
    private readonly options: RawCdpOptions,
  ) {
    this.indentUnit = ' '.repeat(options.indent ?? 2);
  }

  public render(): string {
    this.push('// AUTO-GENERATED by RoboBrowser from a FlowModel. Do not edit by hand.');
    this.push(`// Flow: ${this.flow.name} (${this.flow.id})`);
    this.push("const path = require('node:path');");
    this.push("const fs = require('node:fs/promises');");
    this.push('');
    this.push(RUNTIME);
    this.push('');
    this.variables();
    this.main();
    // Bake the flow's directory into the resolver so the script runs from any cwd.
    const baked = JSON.stringify(this.options.flowDir ?? null);
    return `${this.lines.join('\n').replaceAll('__ROBO_FLOW_DIR__', baked)}\n`;
  }

  private push(line = ''): void {
    this.lines.push(line);
  }

  private pad(depth: number): string {
    return this.indentUnit.repeat(depth);
  }

  private variables(): void {
    const defs = Object.entries(this.flow.variables ?? {});
    this.push('const vars = {');
    for (const [name, def] of defs) {
      this.push(`${this.indentUnit}${quoteKey(name)}: ${renderVariable(name, def)},`);
    }
    this.push('};');
    this.push('');
  }

  private main(): void {
    this.push('(async () => {');
    this.push(`${this.pad(1)}const wsUrl = process.env.CDP_WS_URL;`);
    this.push(
      `${this.pad(1)}if (!wsUrl) throw new Error('CDP_WS_URL is required (e.g. from http://127.0.0.1:9222/json/version)');`,
    );
    this.push(`${this.pad(1)}const cdp = await openCdp(wsUrl);`);
    this.push(`${this.pad(1)}await cdp.send('Page.enable');`);
    this.push(`${this.pad(1)}await cdp.send('Runtime.enable');`);
    this.push(`${this.pad(1)}await cdp.send('DOM.enable');`);
    this.push(`${this.pad(1)}const outDir = process.env.ROBO_OUT || process.cwd();`);
    this.push(`${this.pad(1)}const artifacts = [];`);
    this.push('');
    this.emitSteps(this.flow.steps, 1);
    this.push('');
    this.push(
      `${this.pad(1)}console.log(JSON.stringify({ status: 'ok', variables: vars, artifacts }, null, 2));`,
    );
    this.push('})().catch((error) => {');
    this.push(`${this.pad(1)}console.error(error);`);
    this.push(`${this.pad(1)}process.exit(1);`);
    this.push('});');
  }

  private emitSteps(steps: readonly Step[], depth: number): void {
    for (const step of steps) this.emitStep(step, depth);
  }

  private emitStep(step: Step, depth: number): void {
    const pad = this.pad(depth);
    this.push(`${pad}// ${step.id}: ${step.type}`);
    switch (step.type) {
      case 'goto':
        this.push(
          `${pad}await cdp.send('Page.navigate', { url: resolveFlowUrl(${tpl(step.url)}) });`,
        );
        this.push(
          `${pad}await waitFor(cdp, 'document.readyState === "complete"', { label: 'load' });`,
        );
        break;

      case 'click':
        this.push(
          `${pad}await clickSelector(cdp, ${querySelectorExpr(step.selector)}, ${step.clickCount ?? 1});`,
        );
        break;

      case 'type':
        this.push(
          `${pad}await typeInto(cdp, ${querySelectorExpr(step.selector)}, ${tpl(step.value)}, ${step.clear !== false});`,
        );
        if (step.submit) {
          this.push(
            `${pad}await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });`,
          );
          this.push(
            `${pad}await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });`,
          );
        }
        break;

      case 'select':
        this.push(
          `${pad}await cdp.send('Runtime.evaluate', { expression: ${selectOptionExpr(step.selector, step.value)} });`,
        );
        break;

      case 'hover':
        this.push(`${pad}await hoverSelector(cdp, ${querySelectorExpr(step.selector)});`);
        break;

      case 'scroll':
        if (step.selector) {
          this.push(
            `${pad}await cdp.send('Runtime.evaluate', { expression: "document.querySelector(" + JSON.stringify(${querySelectorExpr(step.selector)}) + ").scrollIntoView({block:'center'})" });`,
          );
        } else {
          this.push(
            `${pad}await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(${step.x ?? 0}, ${step.y ?? 0})' });`,
          );
        }
        break;

      case 'waitForPage':
        this.push(
          `${pad}await waitFor(cdp, 'document.readyState === "complete"', { label: 'page ${step.target}' });`,
        );
        break;

      case 'waitForSelector': {
        const timeout = step.timeout ?? 15000;
        if (step.state === 'hidden') {
          this.push(
            `${pad}await waitFor(cdp, "!document.querySelector(" + JSON.stringify(${querySelectorExpr(step.selector)}) + ")", { timeout: ${timeout}, label: 'selector hidden' });`,
          );
        } else {
          this.push(
            `${pad}await waitFor(cdp, "!!document.querySelector(" + JSON.stringify(${querySelectorExpr(step.selector)}) + ")", { timeout: ${timeout}, label: 'selector' });`,
          );
        }
        break;
      }

      case 'waitForUrl': {
        const timeout = step.timeout ?? 30000;
        this.push(
          `${pad}await waitFor(cdp, ${urlPredicateExpr(step.pattern)}, { timeout: ${timeout}, label: 'url' });`,
        );
        break;
      }

      case 'waitForNetworkIdle':
        this.push(`${pad}// NOTE: raw CDP idle detection requires Network domain bookkeeping.`);
        this.push(
          `${pad}await new Promise((resolve) => setTimeout(resolve, ${step.idleMs ?? 500}));`,
        );
        break;

      case 'waitForDownload':
        this.push(`${pad}// NOTE: raw CDP downloads need Browser.setDownloadBehavior; see README.`);
        break;

      case 'extract': {
        const target = `vars[${JSON.stringify(step.into)}]`;
        const reader = step.attr
          ? `el.getAttribute(${JSON.stringify(step.attr)})`
          : `(el.innerText || el.textContent || '')`;
        if (step.all) {
          this.push(
            `${pad}${target} = await evaluate(cdp, "Array.from(document.querySelectorAll(" + JSON.stringify(${querySelectorExpr(step.selector)}) + ")).map(function(el){return ${reader};})");`,
          );
        } else {
          this.push(
            `${pad}${target} = await evaluate(cdp, "(function(){var el=document.querySelector(" + JSON.stringify(${querySelectorExpr(step.selector)}) + ");return el?${reader}:null;})()");`,
          );
        }
        break;
      }

      case 'screenshot':
        this.push(`${pad}{`);
        this.push(
          `${pad}${this.indentUnit}const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: ${step.fullPage ? 'true' : 'false'} });`,
        );
        this.push(
          `${pad}${this.indentUnit}const target = path.join(outDir, ${JSON.stringify(step.saveTo ?? `${step.id}.png`)});`,
        );
        this.push(
          `${pad}${this.indentUnit}await fs.writeFile(target, Buffer.from(shot.data, 'base64'));`,
        );
        this.push(`${pad}${this.indentUnit}artifacts.push(target);`);
        this.push(`${pad}}`);
        break;

      case 'branch':
        this.push(`${pad}if (${renderCondition(step.condition)}) {`);
        this.emitSteps(step.then, depth + 1);
        if (step.else && step.else.length > 0) {
          this.push(`${pad}} else {`);
          this.emitSteps(step.else, depth + 1);
        }
        this.push(`${pad}}`);
        break;

      case 'loop':
        this.push(`${pad}{`);
        this.push(`${pad}${this.indentUnit}const items = ${renderLoopItems(step)};`);
        this.push(`${pad}${this.indentUnit}for (let i = 0; i < items.length; i += 1) {`);
        this.push(
          `${pad}${this.indentUnit}${this.indentUnit}vars[${JSON.stringify(step.as)}] = items[i];`,
        );
        this.emitSteps(step.steps, depth + 2);
        this.push(`${pad}${this.indentUnit}}`);
        this.push(`${pad}}`);
        break;

      case 'setVar':
        this.push(`${pad}vars[${JSON.stringify(step.name)}] = ${renderValue(step.value)};`);
        break;

      case 'httpCall':
        this.push(`${pad}{`);
        this.push(`${pad}${this.indentUnit}const res = await fetch(${tpl(step.url)}, {`);
        this.push(
          `${pad}${this.indentUnit}${this.indentUnit}method: ${JSON.stringify(step.method.toUpperCase())},`,
        );
        if (step.headers) {
          this.push(
            `${pad}${this.indentUnit}${this.indentUnit}headers: ${renderValue(step.headers)},`,
          );
        }
        if (step.body !== undefined) {
          this.push(
            `${pad}${this.indentUnit}${this.indentUnit}body: JSON.stringify(${renderValue(step.body)}),`,
          );
        }
        this.push(`${pad}${this.indentUnit}});`);
        if (step.into) {
          this.push(
            `${pad}${this.indentUnit}vars[${JSON.stringify(step.into)}] = await res.json().catch(() => res.text());`,
          );
        }
        this.push(`${pad}}`);
        break;

      case 'manual':
        this.push(`${pad}if (process.env.ROBO_MANUAL_AUTOCONTINUE !== '1') {`);
        this.push(
          `${pad}${this.indentUnit}throw new Error(${JSON.stringify(`Manual step (${step.reason}): ${step.message}`)});`,
        );
        this.push(`${pad}}`);
        break;

      default: {
        const exhaustive: never = step;
        throw new ExportError(`Unsupported step for raw CDP export: ${JSON.stringify(exhaustive)}`);
      }
    }
    this.push('');
  }
}

/* ---------------------------------------------------------------- rendering */

/** CSS selector for the first candidate, as a JS string expression. */
function querySelectorExpr(selector: SelectorSpec): string {
  return JSON.stringify(selectorToCss(selector));
}

function selectorToCss(selector: SelectorSpec): string {
  if (typeof selector === 'string') return selector;
  if ('candidates' in selector) return selectorToCss(selector.candidates[0]!);
  if ('testId' in selector) return `[data-testid="${selector.testId}"]`;
  if ('css' in selector) return selector.css;
  if ('xpath' in selector) return `xpath:${selector.xpath}`;
  if ('role' in selector) {
    return selector.name
      ? `[role="${selector.role}" i][aria-label="${selector.name}" i]`
      : `[role="${selector.role}" i]`;
  }
  if ('text' in selector) {
    return `xpath://*[contains(normalize-space(text()), "${selector.text}")]`;
  }
  const exhaustive: never = selector;
  return String(exhaustive);
}

function selectOptionExpr(selector: SelectorSpec, value: string): string {
  const css = JSON.stringify(selectorToCss(selector));
  const val = JSON.stringify(value);
  return `(function(){var el=document.querySelector(${css});if(!el)throw new Error('select not found');el.value=${val};el.dispatchEvent(new Event('change',{bubbles:true}));return el.value;})()`;
}

function urlPredicateExpr(pattern: string): string {
  return `(${JSON.stringify(pattern)}.startsWith('/') ? new RegExp(${JSON.stringify(
    pattern.startsWith('/') ? pattern.slice(1, pattern.lastIndexOf('/')) : pattern,
  )}).test(location.href) : location.href.includes(${JSON.stringify(pattern)}))`;
}

function tpl(value: string): string {
  if (!value.includes('{{')) return JSON.stringify(value);
  const inner = value
    .split(/(\{\{\s*[A-Za-z0-9_.\-[\]$]+\s*\}\})/)
    .map((part) => {
      const match = /^\{\{\s*([A-Za-z0-9_.\-[\]$]+)\s*\}\}$/.exec(part);
      if (match) return `\${vars[${JSON.stringify(match[1])}]}`;
      return part.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    })
    .join('');
  return `\`${inner}\``;
}

function renderCondition(condition: import('../flow/schema.js').Condition): string {
  if ('pageIs' in condition) return `true /* pageIs: ${condition.pageIs} */`;
  if ('selectorExists' in condition) {
    return `(await evaluate(cdp, "!!document.querySelector(" + JSON.stringify(${querySelectorExpr(condition.selectorExists)}) + ")"))`;
  }
  if ('varEquals' in condition) {
    return `JSON.stringify(vars[${JSON.stringify(condition.varEquals.name)}]) === ${JSON.stringify(
      JSON.stringify(condition.varEquals.value),
    )}`;
  }
  if ('not' in condition) return `!(${renderCondition(condition.not)})`;
  if ('all' in condition) {
    const parts = condition.all.map((c) => `(${renderCondition(c)})`);
    return parts.length > 0 ? parts.join(' && ') : 'true';
  }
  if ('any' in condition) {
    const parts = condition.any.map((c) => `(${renderCondition(c)})`);
    return parts.length > 0 ? parts.join(' || ') : 'false';
  }
  const exhaustive: never = condition;
  return String(exhaustive);
}

function renderLoopItems(step: Extract<Step, { type: 'loop' }>): string {
  if (Array.isArray(step.items)) return renderValue(step.items);
  if (step.items.includes('{{')) return tpl(step.items);
  return `vars[${JSON.stringify(step.items)}] ?? []`;
}

function renderValue(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}

function renderVariable(name: string, def: VariableDef): string {
  switch (def.type) {
    case 'const':
      return JSON.stringify(def.value) ?? 'undefined';
    case 'env':
    case 'secret':
      return def.default !== undefined
        ? `process.env[${JSON.stringify(def.key)}] ?? ${JSON.stringify(def.default)}`
        : `process.env[${JSON.stringify(def.key)}]`;
    case 'input': {
      const envKey = `ROBO_${name.toUpperCase().replace(/\W+/g, '_')}`;
      return def.default !== undefined
        ? `process.env[${JSON.stringify(envKey)}] ?? ${JSON.stringify(def.default)}`
        : `process.env[${JSON.stringify(envKey)}] ?? ''`;
    }
    default: {
      const exhaustive: never = def;
      return String(exhaustive);
    }
  }
}

function quoteKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}
