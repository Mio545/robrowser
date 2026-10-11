/**
 * Raw-CDP script -> FlowModel importer (the inverse of `exporters/raw-cdp.ts`).
 *
 * The exporter inlines a small CDP runtime (`cdp.send`, `waitFor`,
 * `clickSelector`, `hoverSelector`, `typeInto`, `evaluate`) and the importer
 * recognises the call sites it emits. As with the Playwright importer, the
 * source is only scanned and parsed — never evaluated.
 *
 * Recognised statements
 *   await cdp.send('Page.navigate', { url: resolveFlowUrl(…) })
 *   await clickSelector(cdp, sel, n) / hoverSelector(cdp, sel)
 *   await typeInto(cdp, sel, value, clear) [+ Enter key events]
 *   await cdp.send('Runtime.evaluate', { expression: … })   select / scroll
 *   await waitFor(cdp, expr, { label: 'load' | 'page X' | 'selector' | … })
 *   await new Promise((resolve) => setTimeout(resolve, ms))  -> waitForNetworkIdle
 *   vars["x"] = await evaluate(cdp, expr)                    -> extract
 *   { const shot = await cdp.send('Page.captureScreenshot', …) } -> screenshot
 *   if (…) { … } / { const items …; for (…) { … } } / setVar / fetch / manual
 */
import type {
  ClickStep,
  Condition,
  ExtractStep,
  FlowModel,
  ManualStep,
  ScreenshotStep,
  SelectStep,
  SelectorSpec,
  Step,
  TypeStep,
  VariableDef,
  WaitForPageStep,
  WaitForSelectorStep,
  WaitForUrlStep,
} from '../flow/schema.js';
import { assertValidFlow } from '../flow/validate.js';
import { ImportError } from '../errors.js';
import * as S from './source.js';
import {
  ImportContext,
  isBoilerplate,
  parseAnchor,
  parseBranchStatement,
  parseConditionExpression,
  parseHeader,
  parseHttpCallBlock,
  parseLoopBlock,
  parseManualBlock,
  parseSetVarAssignment,
  parseVariablesBlock,
  type BlockParser,
  type StepAnchor,
  type StepHooks,
} from './reader.js';
import type { ImportOptions, ImportResult } from './types.js';

/**
 * Import a raw-CDP script.
 *
 * @param source - Script text.
 * @param options - Optional id / name overrides.
 * @returns The recovered flow plus warnings.
 * @throws {ImportError} When the entry point is missing or nothing was mapped.
 */
export function importRawCdp(source: string, options: ImportOptions = {}): ImportResult {
  return new RawCdpReader(source, options).read();
}

class RawCdpReader implements StepHooks {
  private readonly ctx = new ImportContext();
  private readonly hooks: StepHooks = this;
  private readonly parseBlock: BlockParser = (items) => this.parseSteps(items);
  private statements = 0;

  public constructor(
    private readonly source: string,
    private readonly options: ImportOptions,
  ) {}

  /* ------------------------------------------------------------------ entry */

  public read(): ImportResult {
    const header = parseHeader(this.source);
    const items = S.tokenize(this.source);
    this.statements = items.filter((item) => item.kind === 'stmt').length;

    let variables: Record<string, VariableDef> = {};
    let body: S.ScanItem[] | null = null;
    let declaredBody: S.ScanItem[] | null = null;

    for (const item of items) {
      if (item.kind !== 'stmt') continue;
      if (/^const vars\s*=/.test(item.text)) {
        const block = S.firstBlockBody(item.text);
        if (block !== null) variables = parseVariablesBlock(block, this.ctx, item.line);
        continue;
      }
      // The exporter emits `(async () => { … })()`; `async function main()` is
      // the shape hand-written scripts use.
      if (body === null && /^\(\s*async\b/.test(item.text)) {
        const block = S.firstBlockBody(item.text);
        if (block !== null) body = S.tokenize(block);
        continue;
      }
      if (declaredBody === null && /^async\s+function\b/.test(item.text)) {
        const block = S.firstBlockBody(item.text);
        if (block !== null) declaredBody = S.tokenize(block);
      }
    }
    body ??= declaredBody;

    if (body === null) {
      throw new ImportError(
        '无法定位主流程：未找到 `(async () => { … })` 形式的入口，这可能不是 raw-CDP 脚本',
      );
    }

    const steps = this.parseSteps(body);
    if (steps.length === 0) {
      throw new ImportError('未从脚本中识别出任何可映射的步骤');
    }

    const flow: FlowModel = {
      version: '1.0',
      id: this.options.id ?? header.id ?? 'imported-raw-cdp',
      name: this.options.name ?? header.name ?? 'Imported raw-CDP script',
      steps,
    };
    if (Object.keys(variables).length > 0) flow.variables = variables;

    const validated = assertValidFlow(flow);
    return {
      flow: validated,
      warnings: this.ctx.warnings,
      generated: header.generated,
      stats: this.countStats(validated, this.statements),
    };
  }

  private countStats(flow: FlowModel, statements: number): ImportResult['stats'] {
    let steps = 0;
    const visit = (list: readonly Step[]): void => {
      for (const step of list) {
        steps += 1;
        if (step.type === 'branch') {
          visit(step.then);
          if (step.else) visit(step.else);
        } else if (step.type === 'loop') {
          visit(step.steps);
        }
      }
    };
    visit(flow.steps);
    return { statements, steps, warnings: this.ctx.warnings.length };
  }

  /* ------------------------------------------------------------------ steps */

  private parseSteps(items: readonly S.ScanItem[]): Step[] {
    const steps: Step[] = [];
    let anchor: StepAnchor | null = null;

    const push = (step: Step): void => {
      steps.push(step);
    };

    for (const item of items) {
      if (item.kind === 'comment') {
        const parsed = parseAnchor(item);
        if (parsed !== null) {
          anchor = parsed;
          continue;
        }
        // Downloads have no statement of their own in the raw-CDP output.
        if (item.text.includes('raw CDP downloads need Browser.setDownloadBehavior')) {
          push({ id: this.ctx.uniqueId(anchor?.id, 'waitForDownload'), type: 'waitForDownload' });
          anchor = null;
        }
        continue;
      }

      const text = item.text;
      const line = item.line;
      if (isBoilerplate(text)) {
        anchor = null;
        continue;
      }

      /* ---- manual gate (a bare `if`, not a real branch) --------------- */
      if (/^if\b/.test(text) && text.includes('Manual step (')) {
        const manual = parseManualBlock(text);
        if (manual !== null) {
          push({
            id: this.ctx.uniqueId(anchor?.id, 'manual'),
            type: 'manual',
            reason: manual.reason,
            message: manual.message,
          });
        } else {
          this.ctx.warn(line, 'manual 步骤无法还原，已跳过', text);
        }
        anchor = null;
        continue;
      }

      /* ---- branch ---------------------------------------------------- */
      if (/^if\b/.test(text)) {
        const step = parseBranchStatement(
          text,
          this.ctx,
          this.hooks,
          this.parseBlock,
          anchor,
          line,
        );
        if (step !== null) push(step);
        anchor = null;
        continue;
      }

      /* ---- blocks ----------------------------------------------------- */
      if (text.startsWith('{')) {
        const step = this.parseBlockStatement(text, line, anchor);
        if (step !== null) push(step);
        else this.ctx.warn(line, '无法映射的代码块，已跳过', text);
        anchor = null;
        continue;
      }

      /* ---- assignments: extract / setVar ------------------------------ */
      const assign = S.splitAssignment(text);
      if (assign !== null) {
        const recovered = this.parseAssignment(assign, text, line, anchor);
        if (recovered !== 'unmapped') {
          if (recovered !== null) push(recovered);
          anchor = null;
          continue;
        }
      }

      /* ---- statements ------------------------------------------------- */
      if (this.parseStatement(text, line, anchor, steps)) {
        anchor = null;
        continue;
      }

      this.ctx.warn(line, '无法映射的语句，已跳过', text);
      anchor = null;
    }

    return steps;
  }

  /** Recover a block-shaped step (`{ … }`). */
  private parseBlockStatement(text: string, line: number, anchor: StepAnchor | null): Step | null {
    const body = S.firstBlockBody(text);
    if (body === null) return null;

    const first = S.tokenize(body)[0];
    if (first !== undefined && first.kind === 'stmt') {
      const declaration = S.splitConstDeclaration(first.text);
      if (declaration?.target === 'items') {
        return parseLoopBlock(text, this.ctx, this.parseBlock, anchor, line);
      }
    }
    if (text.includes('Page.captureScreenshot')) return this.parseScreenshotBlock(body, anchor);
    if (text.includes('fetch(')) return parseHttpCallBlock(text, this.ctx, anchor, line);
    if (/Manual step \(/.test(text)) {
      const manual = parseManualBlock(text);
      if (manual === null) return null;
      const step: ManualStep = {
        id: this.ctx.uniqueId(anchor?.id, 'manual'),
        type: 'manual',
        reason: manual.reason,
        message: manual.message,
      };
      return step;
    }
    return null;
  }

  /** Recover a `screenshot` step from its exported block. */
  private parseScreenshotBlock(body: string, anchor: StepAnchor | null): ScreenshotStep | null {
    let saveTo: string | undefined;
    let fullPage = false;
    let found = false;

    for (const item of S.tokenize(body)) {
      if (item.kind !== 'stmt') continue;

      const declaration = S.splitConstDeclaration(item.text);
      if (declaration !== null && declaration.target === 'target') {
        const call = S.splitCall(declaration.value);
        if (call !== null && call.receiver === 'path' && call.method === 'join') {
          const args = S.splitTopLevel(call.args, ',');
          const name = args[1] === undefined ? null : S.parseStringExpr(args[1]);
          if (name !== null) saveTo = name;
        }
        continue;
      }

      // `const shot = await cdp.send('Page.captureScreenshot', { … })`.
      const call = S.splitCall(declaration === null ? item.text : declaration.value);
      if (
        call !== null &&
        call.receiver === 'cdp' &&
        call.method === 'send' &&
        S.parseStringExpr(S.splitTopLevel(call.args, ',')[0] ?? '') === 'Page.captureScreenshot'
      ) {
        found = true;
        const options = readEntry(S.splitTopLevel(call.args, ',')[1], 'captureBeyondViewport');
        if (options?.trim() === 'true') fullPage = true;
      }
    }

    if (!found) return null;
    const step: ScreenshotStep = {
      id: this.ctx.uniqueId(anchor?.id, 'screenshot'),
      type: 'screenshot',
    };
    if (saveTo !== undefined) step.saveTo = saveTo;
    if (fullPage) step.fullPage = true;
    return step;
  }

  /**
   * Recover a step from a `vars[…] = …` assignment.
   *
   * @returns `'unmapped'` when the target is not a flow variable, `null` when it
   *   is but could not be recovered (warned), or the recovered step.
   */
  private parseAssignment(
    assign: S.AssignmentSplit,
    text: string,
    line: number,
    anchor: StepAnchor | null,
  ): Step | null | 'unmapped' {
    const into = S.parseVarsLookup(assign.target)?.name;
    if (into === undefined) return 'unmapped';

    if (!assign.value.trim().startsWith('await')) {
      return parseSetVarAssignment(assign.target, assign.value, this.ctx, anchor, line);
    }

    const call = S.splitCall(S.stripAwait(assign.value));
    if (call === null || call.method !== 'evaluate') {
      this.ctx.warn(line, '赋值右侧不是 evaluate(...)，无法还原，已跳过', text);
      return null;
    }

    const args = S.splitTopLevel(call.args, ',');
    const raw = args[1];
    if (raw === undefined) return null;

    const runtime = this.runtimeExpression(raw);
    const selector = specFromRuntime(runtime);
    if (selector === null) {
      this.ctx.warn(line, 'evaluate 表达式中的选择器无法还原，已跳过', text);
      return null;
    }

    const step: ExtractStep = {
      id: this.ctx.uniqueId(anchor?.id, 'extract'),
      type: 'extract',
      selector,
      into,
    };
    if (runtime.includes('querySelectorAll(')) step.all = true;
    const attr = readStringArgument(runtime, /getAttribute\(\s*/, /\s*\)/);
    if (attr !== null) step.attr = attr;
    return step;
  }

  /**
   * Recover a step from a plain statement.
   *
   * @param steps - Steps collected so far; the statement is appended to it.
   * @returns True when the statement was consumed.
   */
  private parseStatement(
    text: string,
    line: number,
    anchor: StepAnchor | null,
    steps: Step[],
  ): boolean {
    const push = (step: Step): void => {
      steps.push(step);
    };

    // `await new Promise((resolve) => setTimeout(resolve, ms))` stands in for
    // waitForNetworkIdle; it is not a `receiver.method(...)` call, so it has to
    // be recognised before the generic call split.
    const idle = /^await\s+new\s+Promise\(\s*\(resolve\)\s*=>\s*setTimeout\(\s*resolve\s*,\s*([0-9]+)\s*\)\s*\)\s*;?$/.exec(
      text.trim(),
    );
    if (idle !== null) {
      const step: Step = {
        id: this.ctx.uniqueId(anchor?.id, 'waitForNetworkIdle'),
        type: 'waitForNetworkIdle',
        idleMs: Number(idle[1]),
      };
      push(step);
      return true;
    }

    const call = S.splitCall(text);
    if (call === null) return false;
    // The statement right before this one; used to fold `Enter` into a type.
    const previous = steps[steps.length - 1];

    /* ---- cdp.send(…) ------------------------------------------------- */
    if (call.receiver === 'cdp' && call.method === 'send') {
      const args = S.splitTopLevel(call.args, ',');
      const method = S.parseStringExpr(args[0] ?? '');
      const options = args[1];
      if (method === null) return false;

      if (method === 'Page.navigate') {
        const rawUrl = readEntry(options, 'url');
        const url = rawUrl === null ? null : S.parseStringExpr(unwrapResolveFlowUrl(rawUrl));
        if (url === null) {
          this.ctx.warn(line, 'Page.navigate 的 URL 无法还原，已跳过', text);
          return true;
        }
        push({ id: this.ctx.uniqueId(anchor?.id, 'goto'), type: 'goto', url });
        return true;
      }

      if (method === 'Runtime.evaluate') {
        return this.parseRuntimeEvaluate(options, text, line, anchor, push);
      }

      if (method === 'Input.dispatchKeyEvent') {
        const key = readEntry(options, 'key');
        if (key !== null && S.parseStringExpr(key) === 'Enter' && previous?.type === 'type') {
          previous.submit = true;
        }
        return true;
      }

      return false;
    }

    /* ---- waitFor(cdp, expr, options) --------------------------------- */
    if (call.method === 'waitFor') {
      const args = S.splitTopLevel(call.args, ',');
      const expr = args[1];
      const options = args[2];
      const label = options === undefined ? null : readEntry(options, 'label');
      const labelText = label === null ? null : S.parseStringExpr(label);
      const timeout = options === undefined ? undefined : readNumberEntry(options, 'timeout');

      if (labelText === 'load') return true; // companion of Page.navigate
      if (labelText === 'url') {
        const pattern = expr === undefined ? null : this.urlPattern(expr);
        if (pattern === null) {
          this.ctx.warn(line, 'waitFor url 的匹配串无法还原，已跳过', text);
          return true;
        }
        const step: WaitForUrlStep = {
          id: this.ctx.uniqueId(anchor?.id, 'waitForUrl'),
          type: 'waitForUrl',
          pattern,
        };
        if (timeout !== undefined) step.timeout = timeout;
        push(step);
        return true;
      }

      if (labelText !== null && labelText.startsWith('page ')) {
        const step: WaitForPageStep = {
          id: this.ctx.uniqueId(anchor?.id, 'waitForPage'),
          type: 'waitForPage',
          target: labelText.slice('page '.length),
        };
        if (timeout !== undefined) step.timeout = timeout;
        push(step);
        return true;
      }

      if (labelText === 'selector' || labelText === 'selector hidden') {
        const selector = expr === undefined ? null : specFromRuntime(this.runtimeExpression(expr));
        if (selector === null) {
          this.ctx.warn(line, 'waitFor selector 无法还原，已跳过', text);
          return true;
        }
        const step: WaitForSelectorStep = {
          id: this.ctx.uniqueId(anchor?.id, 'waitForSelector'),
          type: 'waitForSelector',
          selector,
        };
        if (labelText === 'selector hidden') step.state = 'hidden';
        if (timeout !== undefined) step.timeout = timeout;
        push(step);
        return true;
      }
      return false;
    }

    /* ---- clickSelector / hoverSelector / typeInto -------------------- */
    if (call.method === 'clickSelector') {
      const args = S.splitTopLevel(call.args, ',');
      const selector = args[1] === undefined ? null : specFromRuntime(this.runtimeExpression(args[1]));
      if (selector === null) return false;
      const step: ClickStep = {
        id: this.ctx.uniqueId(anchor?.id, 'click'),
        type: 'click',
        selector,
      };
      const count = args[2] === undefined ? null : readNumber(args[2]);
      if (count !== null && count !== 1) step.clickCount = count;
      push(step);
      return true;
    }

    if (call.method === 'hoverSelector') {
      const args = S.splitTopLevel(call.args, ',');
      const selector = args[1] === undefined ? null : specFromRuntime(this.runtimeExpression(args[1]));
      if (selector === null) return false;
      push({ id: this.ctx.uniqueId(anchor?.id, 'hover'), type: 'hover', selector });
      return true;
    }

    if (call.method === 'typeInto') {
      const args = S.splitTopLevel(call.args, ',');
      const selector = args[1] === undefined ? null : specFromRuntime(this.runtimeExpression(args[1]));
      const value = args[2] === undefined ? null : S.parseStringExpr(args[2]);
      if (selector === null || value === null) return false;
      const step: TypeStep = {
        id: this.ctx.uniqueId(anchor?.id, 'type'),
        type: 'type',
        selector,
        value,
        clear: args[3] === undefined ? true : args[3].trim() !== 'false',
      };
      push(step);
      return true;
    }

    return false;
  }

  /** Recover select / scroll steps from `cdp.send('Runtime.evaluate', …)`. */
  private parseRuntimeEvaluate(
    options: string | undefined,
    text: string,
    line: number,
    anchor: StepAnchor | null,
    push: (step: Step) => void,
  ): boolean {
    const raw = readEntry(options, 'expression');
    if (raw === null) return false;

    // `expression` is either a page-side code string (select / scroll) or, for
    // the concatenated forms, a JS expression that builds one.
    const runtime = this.runtimeExpression(raw);

    const scrollBy = /window\.scrollBy\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)/.exec(runtime);
    if (scrollBy !== null) {
      push({
        id: this.ctx.uniqueId(anchor?.id, 'scroll'),
        type: 'scroll',
        x: Number(scrollBy[1]),
        y: Number(scrollBy[2]),
      });
      return true;
    }

    if (runtime.includes('scrollIntoView')) {
      const selector = specFromRuntime(runtime);
      if (selector === null) return false;
      push({ id: this.ctx.uniqueId(anchor?.id, 'scroll'), type: 'scroll', selector });
      return true;
    }

    if (runtime.includes('el.value') && runtime.includes('dispatchEvent')) {
      const selector = specFromRuntime(runtime);
      const selected = readStringArgument(runtime, /el\.value\s*=\s*/, /\s*;/);
      if (selector === null || selected === null) {
        this.ctx.warn(line, 'select 语句无法还原，已跳过', text);
        return true;
      }
      const step: SelectStep = {
        id: this.ctx.uniqueId(anchor?.id, 'select'),
        type: 'select',
        selector,
        value: selected,
      };
      push(step);
      return true;
    }

    return false;
  }

  /* -------------------------------------------------------------- selectors */

  /** {@inheritDoc StepHooks.resolveSelector} */
  public resolveSelector(expr: string): SelectorSpec | null {
    return specFromRuntime(this.runtimeExpression(expr));
  }

  /**
   * Fold the emitted argument into the page-side code it evaluates to.
   *
   * `"document.querySelector(" + JSON.stringify(sel) + ")"` becomes
   * `document.querySelector("sel")`; a plain string literal or an already
   * complete expression (a select IIFE) is returned unchanged.
   */
  private runtimeExpression(raw: string): string {
    const text = raw.trim();
    const literal = S.parseStringExpr(text);
    if (literal !== null) return literal;

    const parts = S.splitTopLevel(text, '+');
    if (parts.length > 1) {
      let out = '';
      let folded = true;
      for (const part of parts) {
        const piece = S.stripOuterParens(part.trim());
        // `splitCall` splits on the last dot, so this is `JSON` + `stringify`.
        const call = S.splitCall(piece);
        if (call !== null && call.receiver === 'JSON' && call.method === 'stringify') {
          const inner = S.parseJsLiteral(call.args);
          if (!inner.ok) {
            folded = false;
            break;
          }
          out += JSON.stringify(inner.value) ?? '';
          continue;
        }
        const pieceLiteral = S.parseStringExpr(piece);
        if (pieceLiteral === null) {
          folded = false;
          break;
        }
        out += pieceLiteral;
      }
      if (folded) return out;
    }
    return text;
  }

  /** Recover a `waitForUrl` pattern from the predicate the exporter builds. */
  private urlPattern(expr: string): string | null {
    const direct = S.parseStringExpr(expr);
    if (direct !== null) return direct;
    const runtime = this.runtimeExpression(expr);
    const runtimeLiteral = S.parseStringExpr(runtime);
    if (runtimeLiteral !== null) return runtimeLiteral;
    const head = /\(\s*([\s\S]*?)\.startsWith\(\s*'\/'\s*\)/.exec(runtime);
    if (head !== null) {
      const pattern = S.parseStringExpr(head[1] ?? '');
      if (pattern !== null) return pattern;
    }
    return S.collectStringLiterals(runtime)[0] ?? null;
  }

  /* ------------------------------------------------------------- conditions */

  /** {@inheritDoc StepHooks.parseCondition} */
  public parseCondition(text: string): Condition | null {
    return parseConditionExpression(text, {
      atomic: (leaf) => this.parseAtomicCondition(leaf),
      // `selectorExists` is emitted already parenthesised, so it must be
      // recognised before the wrapper is read as a one-element `all`.
      unwrap: (inner) => this.parseEvaluateCondition(inner),
    });
  }

  /** Recover a leaf condition. */
  private parseAtomicCondition(t: string): Condition | null {
    if (t === 'true') return { all: [] };
    if (t === 'false') return { any: [] };

    // `pageIs` is exported as `true /* pageIs: … */`; see the Playwright reader
    // for why this probe belongs in the atomic position only.
    const pageIs = /\/\*\s*pageIs:\s*([^*]*?)\s*\*\//.exec(t);
    if (pageIs !== null) return { pageIs: (pageIs[1] ?? '').trim() };

    if (t.startsWith('!(') && S.findMatching(t, 1) === t.length - 1) {
      const inner = this.parseCondition(S.innerOf(t, 1));
      return inner === null ? null : { not: inner };
    }

    const varEquals = /^JSON\.stringify\(\s*vars\[\s*(["'][^"']*["'])\s*\]\s*\)\s*===\s*([\s\S]+)$/.exec(
      t,
    );
    if (varEquals !== null) {
      const name = S.parseObjectKey(varEquals[1] ?? '');
      const rhs = S.parseStringExpr(varEquals[2] ?? '');
      if (name !== null && rhs !== null) {
        let value: unknown = rhs;
        try {
          value = JSON.parse(rhs);
        } catch {
          value = rhs;
        }
        return { varEquals: { name, value } };
      }
    }

    return this.parseEvaluateCondition(t);
  }

  /** Recover `{ selectorExists }` from `await evaluate(cdp, "!!document.querySelector(…)")`. */
  private parseEvaluateCondition(text: string): Condition | null {
    const match = /^await\s+evaluate\(\s*cdp\s*,\s*([\s\S]+)\)$/.exec(text.trim());
    if (match === null) return null;
    const runtime = this.runtimeExpression(match[1] ?? '');
    if (!runtime.includes('document.querySelector')) return null;
    const selector = specFromRuntime(runtime);
    return selector === null ? null : { selectorExists: selector };
  }
}

/* ------------------------------------------------------------------ helpers */

/** Read a raw `key: <expr>` entry out of an options object literal. */
const readEntry = S.readObjectEntry;

/** Read a numeric literal entry out of an options object literal. */
function readNumberEntry(options: string, key: string): number | undefined {
  const raw = readEntry(options, key);
  if (raw === null) return undefined;
  return readNumber(raw) ?? undefined;
}

/** Parse a numeric literal, or `null`. */
function readNumber(expr: string): number | null {
  const parsed = S.parseJsLiteral(expr);
  return parsed.ok && typeof parsed.value === 'number' ? parsed.value : null;
}

/**
 * Recover a selector from either page-side code (`document.querySelector("#x")`)
 * or a bare CSS string — the two shapes the exporter emits depending on the
 * call site.
 */
function specFromRuntime(runtime: string): SelectorSpec | null {
  if (!runtime.includes('querySelector')) {
    return runtime === '' ? null : cssToSelectorSpec(runtime);
  }
  const css = readStringArgument(runtime, /document\.querySelector(?:All)?\(\s*/, /\s*\)/);
  return css === null ? null : cssToSelectorSpec(css);
}

/**
 * Read the string literal that immediately follows `prefix` and precedes
 * `suffix` in `runtime`.
 */
function readStringArgument(runtime: string, prefix: RegExp, suffix: RegExp): string | null {
  const head = prefix.exec(runtime);
  if (head === null) return null;
  const start = head.index + head[0].length;
  const rest = runtime.slice(start);
  const tail = suffix.exec(rest);
  if (tail === null) return null;
  const candidate = rest.slice(0, tail.index).trim();
  const literal = /^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/.exec(candidate);
  if (literal === null) return null;
  return S.parseStringExpr(literal[1] ?? '');
}

/** Unwrap `resolveFlowUrl(<x>)` so the flow keeps the authored URL. */
function unwrapResolveFlowUrl(expr: string): string {
  const text = expr.trim();
  if (!text.startsWith('resolveFlowUrl(')) return text;
  return S.innerOf(text, 'resolveFlowUrl'.length);
}

/**
 * Reverse of the raw-CDP exporter's `selectorToCss`.
 *
 * Engine-prefixed pseudo selectors (`role=`, `text=`, `xpath=`) are recovered
 * from their CSS form so a re-export is byte-identical.
 */
function cssToSelectorSpec(css: string): SelectorSpec {
  const testId = /^\[data-testid="((?:\\.|[^"\\])*)"\]$/.exec(css);
  if (testId !== null) return { testId: testId[1] ?? '' };

  const role = /^\[role="((?:\\.|[^"\\])*)"\s+i\](?:\[aria-label="((?:\\.|[^"\\])*)"\s+i\])?$/.exec(css);
  if (role !== null) {
    const name = role[2];
    return name === undefined ? { role: role[1] ?? '' } : { role: role[1] ?? '', name };
  }

  const text = /^xpath:\/\/\*\[contains\(normalize-space\(text\(\)\),\s*"([\s\S]*)"\)\]$/.exec(css);
  if (text !== null) return { text: text[1] ?? '' };

  if (css.startsWith('xpath:')) return { xpath: css.slice('xpath:'.length) };

  return { css };
}
