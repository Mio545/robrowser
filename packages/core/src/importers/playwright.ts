/**
 * Playwright script -> FlowModel importer.
 *
 * This is the inverse of `exporters/playwright.ts`. It recognises the statement
 * vocabulary the exporter emits (plus the common hand-written equivalents) and
 * rebuilds the step list. Nothing is evaluated: the source is scanned and parsed
 * as data by `./source.ts`.
 *
 * Recognised statements
 *   await page.goto(url, { waitUntil })
 *   await page.waitForURL(matcher) / page.waitForLoadState(state)
 *   await <locator>.click() / .fill() / .pressSequentially() / .selectOption()
 *   await <locator>.hover() / .scrollIntoViewIfNeeded() / .waitFor({ state })
 *   await page.mouse.wheel(x, y) / page.keyboard.press('Enter')
 *   { const download = await nextDownload(); … }        -> waitForDownload
 *   vars["x"] = await <locator>.innerText() | .getAttribute(a) | .evaluateAll()
 *   { const target = …; await page.screenshot({ … }) }   -> screenshot
 *   if (…) { … } else { … }                              -> branch
 *   { const items = …; for (…) { vars[as] = items[i]; … } } -> loop
 *   vars["x"] = <literal>                                -> setVar
 *   { const res = await fetch(…); … }                    -> httpCall
 *   { const message = …; throw new Error('Manual step …') }  -> manual
 *
 * Losses inherent to the exporter are documented in `./types.ts`; anything the
 * importer cannot map is reported as a warning rather than dropped silently.
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
  WaitForDownloadStep,
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
  parseConditionExpression,
  parseBranchStatement,
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
 * Import a Playwright script.
 *
 * @param source - Script text.
 * @param options - Optional id / name overrides.
 * @returns The recovered flow plus warnings.
 * @throws {ImportError} When the entry point is missing or nothing was mapped.
 */
export function importPlaywright(source: string, options: ImportOptions = {}): ImportResult {
  return new PlaywrightReader(source, options).read();
}

/** A deferred `<locator>.click()` that may belong to a `type` step. */
interface PendingClick {
  anchor: StepAnchor | null;
  selector: SelectorSpec;
  receiver: string;
}

/**
 * Page-level element methods whose *first* argument is the selector, e.g.
 * `page.fill('#user', 'alice')`. The exporter always emits the locator form
 * (`page.locator('#user').fill('alice')`), but hand-written scripts commonly
 * use this older shape.
 */
const PAGE_ELEMENT_METHODS = new Set([
  'click',
  'fill',
  'type',
  'selectOption',
  'hover',
  'waitForSelector',
]);

class PlaywrightReader implements StepHooks {
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
      // `(async () => { … })()` is what the exporter emits; `async function
      // main() { … }` is what hand-written scripts commonly use.
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
        '无法定位主流程：未找到 `(async () => { … })` 形式的入口，这可能不是 Playwright 脚本',
      );
    }

    const steps = this.parseSteps(body);
    if (steps.length === 0) {
      throw new ImportError('未从脚本中识别出任何可映射的步骤');
    }

    const flow: FlowModel = {
      version: '1.0',
      id: this.options.id ?? header.id ?? 'imported-playwright',
      name: this.options.name ?? header.name ?? 'Imported Playwright script',
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
    let pending: PendingClick | null = null;
    let cleared = false;
    let awaitingFingerprint: { anchor: StepAnchor | null; line: number } | null = null;

    const flushClick = (): void => {
      if (pending !== null) {
        const step: ClickStep = {
          id: this.ctx.uniqueId(pending.anchor?.id, 'click'),
          type: 'click',
          selector: pending.selector,
        };
        steps.push(step);
        pending = null;
      }
      cleared = false;
    };

    const push = (step: Step): void => {
      steps.push(step);
    };

    /** The step most recently appended to this block. */
    const tail = (): Step | undefined => steps[steps.length - 1];

    for (const item of items) {
      if (item.kind === 'comment') {
        const parsed = parseAnchor(item);
        if (parsed !== null) {
          anchor = parsed;
          continue;
        }
        const fingerprint = /TODO:\s*page fingerprint\s+"((?:\\.|[^"\\])*)"/.exec(item.text);
        if (fingerprint !== null && awaitingFingerprint !== null) {
          push({
            id: this.ctx.uniqueId(awaitingFingerprint.anchor?.id, 'waitForPage'),
            type: 'waitForPage',
            target: S.unescapeString(fingerprint[1] ?? ''),
          });
          awaitingFingerprint = null;
        }
        continue;
      }

      if (awaitingFingerprint !== null) {
        this.ctx.warn(
          awaitingFingerprint.line,
          "`await page.waitForLoadState('load')` 后没有页面指纹注释，已跳过该等待",
        );
        awaitingFingerprint = null;
      }

      const text = item.text;
      const line = item.line;

      if (isBoilerplate(text)) {
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
        flushClick();
        if (step !== null) push(step);
        anchor = null;
        continue;
      }

      /* ---- blocks: loop / download / screenshot / httpCall / manual --- */
      if (text.startsWith('{')) {
        flushClick();
        const step = this.parseBlockStatement(text, line, anchor);
        if (step !== null) push(step);
        else this.ctx.warn(line, '无法映射的代码块，已跳过', text);
        anchor = null;
        continue;
      }

      const call = S.splitCall(text);

      /* ---- type-step continuations (must precede the pending flush) --- */
      if (call !== null && call.method === 'fill' && this.isClearCall(call.args)) {
        if (pending !== null && pending.receiver === call.receiver) {
          cleared = true;
          anchor = null;
          continue;
        }
      }

      if (call !== null && call.method === 'pressSequentially') {
        const selector = this.resolveSelector(call.receiver);
        if (selector !== null) {
          const args = S.splitTopLevel(call.args, ',');
          const value = args[0] === undefined ? null : S.parseStringExpr(args[0]);
          if (value !== null) {
            const sameTarget = pending !== null && pending.receiver === call.receiver;
            const step: TypeStep = {
              id: this.ctx.uniqueId((sameTarget ? pending?.anchor : anchor)?.id, 'type'),
              type: 'type',
              selector,
              value,
              clear: sameTarget ? cleared : false,
            };
            const delay = this.readDelay(args[1]);
            if (delay !== undefined) step.delayMs = delay;
            pending = null;
            cleared = false;
            push(step);
            anchor = null;
            continue;
          }
        }
      }

      /* ---- a bare click may open a `type` step ----------------------- */
      if (call !== null && call.method === 'click' && S.stripOuterParens(call.args).trim() === '') {
        const selector = this.resolveSelector(call.receiver);
        if (selector !== null) {
          pending = { anchor, selector, receiver: call.receiver };
          anchor = null;
          continue;
        }
      }

      /* ---- everything else settles a deferred click ------------------- */
      flushClick();

      /* ---- goto ------------------------------------------------------- */
      if (call !== null && call.receiver === 'page' && call.method === 'goto') {
        const args = S.splitTopLevel(call.args, ',');
        const url = args[0] === undefined ? null : S.parseStringExpr(this.unwrapResolveFlowUrl(args[0]));
        if (url !== null) {
          const step: Step = { id: this.ctx.uniqueId(anchor?.id, 'goto'), type: 'goto', url };
          const waitUntil = this.readWaitUntil(args[1]);
          if (waitUntil !== null) (step as { waitUntil?: string }).waitUntil = waitUntil;
          push(step);
        } else {
          this.ctx.warn(line, 'goto 的 URL 无法还原，已跳过', text);
        }
        anchor = null;
        continue;
      }

      /* ---- load state / page wait ------------------------------------- */
      if (call !== null && call.receiver === 'page' && call.method === 'waitForLoadState') {
        const state = S.parseStringExpr(call.args);
        if (state === 'networkidle') {
          push({ id: this.ctx.uniqueId(anchor?.id, 'waitForNetworkIdle'), type: 'waitForNetworkIdle' });
        } else if (state === 'load' || state === 'domcontentloaded') {
          // Filled in by the `// TODO: page fingerprint "…"` comment that follows.
          awaitingFingerprint = { anchor, line };
        } else {
          this.ctx.warn(line, `无法映射的 waitForLoadState('${String(state)}')`, text);
        }
        anchor = null;
        continue;
      }

      /* ---- waitForURL -------------------------------------------------- */
      if (call !== null && call.receiver === 'page' && call.method === 'waitForURL') {
        const pattern = this.parseUrlMatcher(call.args);
        if (pattern !== null) {
          const step: WaitForUrlStep = {
            id: this.ctx.uniqueId(anchor?.id, 'waitForUrl'),
            type: 'waitForUrl',
            pattern,
          };
          push(step);
        } else {
          this.ctx.warn(line, 'waitForURL 的匹配器无法还原，已跳过', text);
        }
        anchor = null;
        continue;
      }

      /* ---- mouse wheel / keyboard ------------------------------------- */
      if (call !== null && call.receiver === 'page.mouse' && call.method === 'wheel') {
        const args = S.splitTopLevel(call.args, ',');
        const x = this.readNumber(args[0]);
        const y = this.readNumber(args[1]);
        if (x !== null && y !== null) {
          push({ id: this.ctx.uniqueId(anchor?.id, 'scroll'), type: 'scroll', x, y });
        } else {
          this.ctx.warn(line, 'page.mouse.wheel 的参数无法还原，已跳过', text);
        }
        anchor = null;
        continue;
      }

      /* ---- direct page.screenshot (hand-written scripts) --------------- */
      if (call !== null && call.receiver === 'page' && call.method === 'screenshot') {
        const step = this.parseScreenshotOptions(S.splitTopLevel(call.args, ',')[0], anchor);
        if (step !== null) push(step);
        else this.ctx.warn(line, 'page.screenshot 的参数无法还原，已跳过', text);
        anchor = null;
        continue;
      }

      if (
        call !== null &&
        call.receiver === 'page.keyboard' &&
        call.method === 'press' &&
        S.parseStringExpr(call.args) === 'Enter'
      ) {
        // Only meaningful as the tail of a `type` step.
        const previous = tail();
        if (previous !== undefined && previous.type === 'type') previous.submit = true;
        else this.ctx.warn(line, '孤立的 Enter 按键没有对应的 type 步骤，已跳过', text);
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

      /* ---- locator calls ---------------------------------------------- */
      if (call !== null) {
        const step = this.parseLocatorCall(call, anchor);
        if (step !== null) {
          push(step);
          anchor = null;
          continue;
        }
      }

      this.ctx.warn(line, '无法映射的语句，已跳过', text);
      anchor = null;
    }

    flushClick();
    if (awaitingFingerprint !== null) {
      this.ctx.warn(
        (awaitingFingerprint as { line: number }).line,
        "`await page.waitForLoadState('load')` 后没有页面指纹注释，已跳过该等待",
      );
    }
    return steps;
  }

  /* ------------------------------------------------------------- statements */

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
    if (text.includes('nextDownload(')) {
      const step: WaitForDownloadStep = {
        id: this.ctx.uniqueId(anchor?.id, 'waitForDownload'),
        type: 'waitForDownload',
      };
      return step;
    }
    if (text.includes('page.screenshot(')) return this.parseScreenshotBlock(body, anchor);
    if (text.includes('fetch(')) return parseHttpCallBlock(text, this.ctx, anchor, line);
    if (/Manual step \(|page\.pause\(\)|MANUAL \(/.test(text)) {
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
        // `const target = path.join(outDir, "<id>.png")` is the default naming;
        // an explicit `saveTo` is emitted as a plain string literal.
        const literal = S.parseStringExpr(declaration.value);
        if (literal !== null) saveTo = literal;
        continue;
      }
      const call = S.splitCall(item.text);
      if (call !== null && call.receiver === 'page' && call.method === 'screenshot') {
        found = true;
        const options = S.splitTopLevel(call.args, ',')[0];
        const path = this.readStringOption(options, 'path');
        if (path !== null) saveTo = path;
        if (this.readBooleanOption(options, 'fullPage')) fullPage = true;
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
   * Read `page.screenshot({ path, fullPage })` options.
   *
   * Entries are read individually because `path` is usually the `target`
   * variable rather than a literal, which would fail a whole-object parse.
   */
  private parseScreenshotOptions(
    options: string | undefined,
    anchor: StepAnchor | null,
  ): ScreenshotStep | null {
    const step: ScreenshotStep = {
      id: this.ctx.uniqueId(anchor?.id, 'screenshot'),
      type: 'screenshot',
    };
    const saveTo = this.readStringOption(options, 'path');
    if (saveTo !== null) step.saveTo = saveTo;
    if (S.readObjectEntry(options, 'fullPage')?.trim() === 'true') step.fullPage = true;
    return step;
  }

  /**
   * Recover a step from a `vars[…] = …` assignment.
   *
   * @returns `'unmapped'` when the target is not a flow variable (so the caller
   *   can try other shapes), `null` when it *is* one but could not be recovered
   *   (a warning has been recorded), or the recovered step.
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
    if (call === null) {
      this.ctx.warn(line, '赋值右侧无法还原，已跳过', text);
      return null;
    }
    const selector = this.resolveSelector(call.receiver);
    if (selector === null) return 'unmapped';

    const step: ExtractStep = {
      id: this.ctx.uniqueId(anchor?.id, 'extract'),
      type: 'extract',
      selector,
      into,
    };

    if (call.method === 'innerText' || call.method === 'textContent') return step;

    if (call.method === 'getAttribute') {
      const attr = S.parseStringExpr(call.args);
      if (attr === null) {
        this.ctx.warn(line, 'getAttribute 的属性名无法还原，已跳过', text);
        return null;
      }
      step.attr = attr;
      return step;
    }

    if (call.method === 'evaluateAll') {
      step.all = true;
      const attr = /getAttribute\(\s*(["'])((?:\\.|[^"'\\])*)\1\s*\)/.exec(call.args);
      if (attr !== null) step.attr = S.unescapeString(attr[2] ?? '');
      return step;
    }

    return 'unmapped';
  }

  /** Recover a `click` / `type` / `select` / `hover` / `scroll` / `waitForSelector`. */
  private parseLocatorCall(call: S.CallSplit, anchor: StepAnchor | null): Step | null {
    // Both `locator.fill(value)` and the page-level `page.fill(selector, value)`
    // forms reduce to the same step; only the argument layout differs.
    if (call.receiver === 'page' && PAGE_ELEMENT_METHODS.has(call.method)) {
      const parts = S.splitTopLevel(call.args, ',');
      const raw = parts[0] === undefined ? null : S.parseStringExpr(parts[0]);
      if (raw === null) return null;
      return this.buildElementStep(call.method, toSelectorSpec(raw), parts.slice(1), anchor);
    }

    const selector = this.resolveSelector(call.receiver);
    if (selector === null) return null;
    return this.buildElementStep(
      call.method,
      selector,
      S.splitTopLevel(call.args, ','),
      anchor,
    );
  }

  /** Build an element-action step from a normalised argument list. */
  private buildElementStep(
    method: string,
    selector: SelectorSpec,
    args: readonly string[],
    anchor: StepAnchor | null,
  ): Step | null {
    const options = args[0];

    switch (method) {
      case 'click': {
        const step: ClickStep = {
          id: this.ctx.uniqueId(anchor?.id, 'click'),
          type: 'click',
          selector,
        };
        const button = this.readStringOption(options, 'button');
        if (button === 'right' || button === 'middle') step.button = button;
        const clickCount = this.readNumberOption(options, 'clickCount');
        if (clickCount !== undefined && clickCount !== 1) step.clickCount = clickCount;
        return step;
      }

      case 'fill': {
        const value = options === undefined ? null : S.parseStringExpr(options);
        if (value === null) return null;
        return {
          id: this.ctx.uniqueId(anchor?.id, 'type'),
          type: 'type',
          selector,
          value,
          clear: true,
        } satisfies TypeStep;
      }

      case 'type': {
        // Playwright's `page.type` appends instead of replacing.
        const value = options === undefined ? null : S.parseStringExpr(options);
        if (value === null) return null;
        const step: TypeStep = {
          id: this.ctx.uniqueId(anchor?.id, 'type'),
          type: 'type',
          selector,
          value,
          clear: false,
        };
        const delay = this.readDelay(args[1]);
        if (delay !== undefined) step.delayMs = delay;
        return step;
      }

      case 'selectOption': {
        const value = options === undefined ? null : S.parseStringExpr(options);
        if (value === null) return null;
        return {
          id: this.ctx.uniqueId(anchor?.id, 'select'),
          type: 'select',
          selector,
          value,
        } satisfies SelectStep;
      }

      case 'hover':
        return { id: this.ctx.uniqueId(anchor?.id, 'hover'), type: 'hover', selector };

      case 'scrollIntoViewIfNeeded':
        return { id: this.ctx.uniqueId(anchor?.id, 'scroll'), type: 'scroll', selector };

      case 'waitForSelector':
      case 'waitFor': {
        const step: WaitForSelectorStep = {
          id: this.ctx.uniqueId(anchor?.id, 'waitForSelector'),
          type: 'waitForSelector',
          selector,
        };
        const state = this.readStringOption(options, 'state');
        if (state === 'attached' || state === 'visible' || state === 'hidden') step.state = state;
        const timeout = this.readNumberOption(options, 'timeout');
        if (timeout !== undefined) step.timeout = timeout;
        if (step.state === undefined) step.state = 'visible';
        return step;
      }

      default:
        return null;
    }
  }

  /* -------------------------------------------------------------- selectors */

  /** {@inheritDoc StepHooks.resolveSelector} */
  public resolveSelector(expr: string): SelectorSpec | null {
    const text = S.stripOuterParens(expr).trim();

    const helper = text.indexOf('firstMatch(');
    if (helper !== -1) {
      const open = text.indexOf('(', helper);
      const args = S.splitTopLevel(S.innerOf(text, open), ',');
      const list = args[1];
      if (list === undefined) return null;
      const parsed = S.parseJsLiteral(list);
      if (!parsed.ok || !Array.isArray(parsed.value)) return null;
      const candidates = parsed.value.map((entry) => toSelectorSpec(String(entry)));
      return candidates.length === 0 ? null : { candidates };
    }

    const call = S.splitCall(text);
    if (call !== null && call.receiver === 'page' && call.method === 'locator') {
      const raw = S.parseStringExpr(call.args);
      return raw === null ? null : toSelectorSpec(raw);
    }
    return null;
  }

  /* ------------------------------------------------------------- conditions */

  /** {@inheritDoc StepHooks.parseCondition} */
  public parseCondition(text: string): Condition | null {
    return parseConditionExpression(text, { atomic: (leaf) => this.parseAtomicCondition(leaf) });
  }

  /** Recover a leaf condition. */
  private parseAtomicCondition(t: string): Condition | null {
    if (t === 'true') return { all: [] };
    if (t === 'false') return { any: [] };

    // `pageIs` has no runtime representation, so the exporter emits the literal
    // `true` next to a comment. Only the atomic position is unambiguous — inside
    // an `any` / `all` the other operands must still be recovered.
    const pageIs = /\*\s*pageIs:\s*"((?:\\.|[^"\\])*)"/.exec(t);
    if (pageIs !== null) return { pageIs: S.unescapeString(pageIs[1] ?? '') };

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

    const selectorExists = /^\(await\s+([\s\S]*)\.count\(\)\)\s*>\s*0$/.exec(t);
    if (selectorExists !== null) {
      const selector = this.resolveSelector(selectorExists[1] ?? '');
      if (selector !== null) return { selectorExists: selector };
    }

    return null;
  }

  /* ---------------------------------------------------------------- helpers */

  /** True for `''`, `""` or `` `` `` — the marker of a `clear` before typing. */
  private isClearCall(args: string): boolean {
    const text = S.stripOuterParens(args.trim());
    if (text === '') return true;
    const literal = S.parseStringExpr(text);
    return literal === '';
  }

  /** Read a `{ delay: 30 }` option object. */
  private readDelay(expr: string | undefined): number | undefined {
    return this.readNumberOption(expr, 'delay');
  }

  /** Read a number-valued option out of an options object literal. */
  private readNumberOption(options: string | undefined, key: string): number | undefined {
    const raw = S.readObjectEntry(options, key);
    if (raw === null) return undefined;
    const parsed = S.parseJsLiteral(raw);
    return parsed.ok && typeof parsed.value === 'number' ? parsed.value : undefined;
  }

  /** Read a boolean-valued option out of an options object literal. */
  private readBooleanOption(options: string | undefined, key: string): boolean {
    return S.readObjectEntry(options, key)?.trim() === 'true';
  }

  /** Read a string-valued option out of an options object literal. */
  private readStringOption(options: string | undefined, key: string): string | null {
    const raw = S.readObjectEntry(options, key);
    return raw === null ? null : S.parseStringExpr(raw);
  }

  /** Read a `{ waitUntil: … }` option object. */
  private readWaitUntil(expr: string | undefined): 'load' | 'domcontentloaded' | null {
    const waitUntil = this.readStringOption(expr, 'waitUntil');
    if (waitUntil === 'domcontentloaded') return 'domcontentloaded';
    if (waitUntil === 'load' || waitUntil === 'networkidle') return 'load';
    return null;
  }

  /** Unwrap `resolveFlowUrl(<x>)` so the flow keeps the authored URL. */
  private unwrapResolveFlowUrl(expr: string): string {
    const text = expr.trim();
    if (!text.startsWith('resolveFlowUrl(')) return text;
    return S.innerOf(text, 'resolveFlowUrl'.length);
  }

  /** Read a numeric literal argument. */
  private readNumber(expr: string | undefined): number | null {
    if (expr === undefined) return null;
    const parsed = S.parseJsLiteral(expr);
    return parsed.ok && typeof parsed.value === 'number' ? parsed.value : null;
  }

  /** Recover a `waitForUrl` pattern from a string or `new RegExp(…)` matcher. */
  private parseUrlMatcher(expr: string): string | null {
    const text = S.stripOuterParens(expr.trim());
    const literal = S.parseStringExpr(text);
    if (literal !== null) return literal;
    if (!text.startsWith('new RegExp(')) return null;
    const args = S.splitTopLevel(S.innerOf(text, 'new RegExp'.length), ',');
    const source = args[0] === undefined ? null : S.parseStringExpr(args[0]);
    if (source === null) return null;
    const flags = args[1] === undefined ? '' : (S.parseStringExpr(args[1]) ?? '');
    if (flags === '') {
      // The exporter renders a glob as `new RegExp("^a.*b$")`; recovering the
      // glob keeps re-export idempotent.
      const glob = globFromRegexSource(source);
      if (glob !== null) return glob;
    }
    return `/${source}/${flags}`;
  }
}

/** Inverse of the exporter's glob -> regex escaping, or `null` when lossy. */
function globFromRegexSource(source: string): string | null {
  if (!source.startsWith('^') || !source.endsWith('$')) return null;
  const inner = source.slice(1, -1);
  let out = '';
  let i = 0;
  while (i < inner.length) {
    const ch = inner.charAt(i);
    if (ch === '\\') {
      out += inner.charAt(i + 1);
      i += 2;
      continue;
    }
    if (ch === '.' && inner.charAt(i + 1) === '*') {
      out += '*';
      i += 2;
      continue;
    }
    return null;
  }
  return out;
}

/** Map a Playwright selector string onto a {@link SelectorSpec}. */
function toSelectorSpec(raw: string): SelectorSpec {
  if (raw.startsWith('role=')) {
    const match = /^role=([^[\]]+?)(?:\[name="((?:\\.|[^"\\])*)"\])?$/.exec(raw);
    if (match !== null) {
      const role = match[1] ?? '';
      const name = match[2];
      return name === undefined ? { role } : { role, name: unescapeAttr(name) };
    }
    return { css: raw };
  }
  if (raw.startsWith('text=')) {
    const body = raw.slice(5);
    if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) {
      return { text: unescapeAttr(body.slice(1, -1)), exact: true };
    }
    return { text: body, exact: false };
  }
  if (raw.startsWith('xpath=')) return { xpath: raw.slice(6) };

  const testId = /^\[data-testid="((?:\\.|[^"\\])*)"\]$/.exec(raw);
  if (testId !== null) return { testId: unescapeAttr(testId[1] ?? '') };

  return { css: raw };
}

/** Reverse of the exporters' `escapeAttr`. */
function unescapeAttr(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value.charAt(i) === '\\' && i + 1 < value.length) {
      out += value.charAt(i + 1);
      i += 2;
      continue;
    }
    out += value.charAt(i);
    i += 1;
  }
  return out;
}
