/**
 * Dependency-free JavaScript source scanner shared by the script importers.
 *
 * Importing a generated script means reading JavaScript as *data*, without ever
 * evaluating it: an exported script is untrusted input and must never be run
 * through `eval`/`new Function`/`vm`. The helpers here therefore do three
 * narrowly scoped jobs:
 *
 * 1. {@link tokenize} splits a script into statements and comments, skipping
 *    over string, template, regex and comment literals so that a `;` inside a
 *    string cannot end a statement.
 * 2. {@link findMatching} / {@link splitTopLevel} navigate balanced brackets,
 *    again literal-aware.
 * 3. {@link parseJsLiteral} recovers plain data (strings, numbers, booleans,
 *    arrays, objects) from a JavaScript expression, translating template
 *    literals with `${vars["x"]}` holes back into `{{x}}` interpolation.
 *
 * Anything outside that surface fails explicitly with a reason instead of
 * guessing, so callers can report it to the user.
 */

/** A comment found between statements. */
export interface ScanComment {
  kind: 'comment';
  /** True for slash-star block comments, false for `//` line comments. */
  block: boolean;
  /** Raw comment text including the delimiters. */
  text: string;
  /** 1-based line number the comment starts on. */
  line: number;
}

/** A complete statement (one `;`-terminated statement or one `{ … }` block). */
export interface ScanStatement {
  kind: 'stmt';
  /** Trimmed statement source. */
  text: string;
  /** 1-based line number the statement starts on. */
  line: number;
}

/** One item produced by {@link tokenize}. */
export type ScanItem = ScanComment | ScanStatement;

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Keywords after which a `/` starts a regex literal rather than a division.
 * Only needed to disambiguate `/` during scanning; the generated scripts use
 * `new RegExp(...)` everywhere, so this only helps hand-written inputs.
 */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'instanceof',
  'new',
  'do',
  'else',
  'yield',
  'await',
  'throw',
]);

/** Characters after which a `/` starts a regex literal. */
const REGEX_PRECEDERS = '(,=:[!&|?{};+-*%~^<>';

/* ------------------------------------------------------------------ scanning */

/**
 * If a literal (comment, string, template or regex) starts at `i`, return the
 * index just past it; otherwise return `i` unchanged.
 *
 * @param code - Source text.
 * @param i - Index to inspect.
 * @param prev - Last significant code character before `i` (regex disambiguation).
 * @param tail - Trailing identifier in the code buffer before `i`.
 */
export function skipAtomic(code: string, i: number, prev: string, tail: string): number {
  const ch = code.charAt(i);
  if (ch === '') return i;
  if (ch === '/' && (code.charAt(i + 1) === '/' || code.charAt(i + 1) === '*')) {
    return skipComment(code, i);
  }
  if (ch === '"' || ch === "'") return skipQuoted(code, i, ch);
  if (ch === '`') return skipTemplate(code, i);
  if (ch === '/' && regexAllowed(prev, tail)) return skipRegex(code, i);
  return i;
}

/** Skip a line or block comment. */
function skipComment(code: string, i: number): number {
  if (code.startsWith('//', i)) {
    const end = code.indexOf('\n', i);
    return end === -1 ? code.length : end;
  }
  const end = code.indexOf('*/', i + 2);
  return end === -1 ? code.length : end + 2;
}

/** Skip a single- or double-quoted string literal. */
function skipQuoted(code: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < code.length) {
    const c = code.charAt(j);
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    // An unterminated string would otherwise swallow the rest of the file.
    if (c === '\n') return code.length;
    j += 1;
  }
  return code.length;
}

/** Skip a template literal, including nested `${ … }` substitutions. */
function skipTemplate(code: string, i: number): number {
  let j = i + 1;
  while (j < code.length) {
    const c = code.charAt(j);
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') return j + 1;
    if (c === '$' && code.charAt(j + 1) === '{') {
      j = skipInterpolation(code, j + 1);
      continue;
    }
    j += 1;
  }
  return code.length;
}

/** Skip a `${ … }` substitution that starts at the `{` index `openIndex`. */
function skipInterpolation(code: string, openIndex: number): number {
  let depth = 0;
  let j = openIndex;
  while (j < code.length) {
    const c = code.charAt(j);
    if (c === '{') {
      depth += 1;
      j += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      j += 1;
      if (depth === 0) return j;
      continue;
    }
    const skipped = skipAtomic(code, j, code.charAt(j - 1), '');
    if (skipped > j) {
      j = skipped;
      continue;
    }
    j += 1;
  }
  return code.length;
}

/** Skip a regex literal plus its flags. Returns `i` when it is a division. */
function skipRegex(code: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  let closed = false;
  while (j < code.length) {
    const c = code.charAt(j);
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j += 1;
      closed = true;
      break;
    } else if (c === '\n') {
      return i;
    }
    j += 1;
  }
  if (!closed) return i;
  while (j < code.length && IDENT_CHAR.test(code.charAt(j))) j += 1;
  return j;
}

/** True when a `/` at this position opens a regex literal. */
function regexAllowed(prev: string, tail: string): boolean {
  if (prev === '') return true;
  if (REGEX_PRECEDERS.includes(prev)) return true;
  if (IDENT_CHAR.test(prev)) return REGEX_KEYWORDS.has(tail);
  return false;
}

/** Trailing identifier of a buffer, used for the regex-keyword heuristic. */
function tailWord(buffer: string): string {
  let end = buffer.length;
  while (end > 0 && !IDENT_CHAR.test(buffer.charAt(end - 1))) end -= 1;
  let start = end;
  while (start > 0 && IDENT_CHAR.test(buffer.charAt(start - 1))) start -= 1;
  return buffer.slice(start, end);
}

/* ---------------------------------------------------------------- statements */

/**
 * Split source into top-level statements and standalone comments.
 *
 * A statement ends at a `;` outside any bracket, or at the `}` that closes a
 * block, unless the block is continued (`else`, `catch`, `finally`, or an IIFE
 * invocation such as `})().catch(...)`). Round and square brackets are tracked
 * alongside braces so that the `;` separators inside a `for (…)` header do not
 * end the statement.
 *
 * @param code - Source text (a whole file or a single function body).
 */
export function tokenize(code: string): ScanItem[] {
  const items: ScanItem[] = [];
  let buffer = '';
  let bufferLine = 1;
  let line = 1;
  let braces = 0;
  let parens = 0;
  let lastChar = '';
  let i = 0;

  const flush = (): void => {
    const text = buffer.trim();
    if (text !== '') items.push({ kind: 'stmt', text, line: bufferLine });
    buffer = '';
  };

  const start = (): void => {
    if (buffer === '') bufferLine = line;
  };

  while (i < code.length) {
    const ch = code.charAt(i);

    /* comments: standalone when no statement is in progress */
    if (ch === '/' && (code.charAt(i + 1) === '/' || code.charAt(i + 1) === '*')) {
      const stop = skipComment(code, i);
      const text = code.slice(i, stop);
      if (buffer.trim() === '') {
        items.push({ kind: 'comment', block: ch === '/' && code.charAt(i + 1) === '*', text, line });
      } else {
        buffer += ` ${text}`;
      }
      line += countNewlines(text);
      i = stop;
      continue;
    }

    /* string / template / regex literals are copied verbatim */
    const skipped = skipAtomic(code, i, lastChar, tailWord(buffer));
    if (skipped > i) {
      start();
      const text = code.slice(i, skipped);
      buffer += text;
      line += countNewlines(text);
      // A literal is a value, so a following `/` is a division.
      lastChar = 'v';
      i = skipped;
      continue;
    }

    if (ch === ';' && braces === 0 && parens === 0) {
      start();
      buffer += ch;
      flush();
      lastChar = ';';
      i += 1;
      continue;
    }

    if (ch === '{') braces += 1;
    if (ch === '}' && braces > 0) {
      braces -= 1;
      start();
      buffer += ch;
      lastChar = '}';
      i += 1;
      if (braces === 0 && parens === 0 && !continuesStatement(code, i)) flush();
      continue;
    }

    if (ch === '(' || ch === '[') parens += 1;
    if ((ch === ')' || ch === ']') && parens > 0) parens -= 1;

    if (ch === '\n') line += 1;
    start();
    buffer += ch;
    if (!/\s/.test(ch)) lastChar = ch;
    i += 1;
  }

  flush();
  return items;
}

/**
 * True when the token after a closing `}` keeps the statement open.
 *
 * A block close only ends a statement when what follows starts a *new* one. The
 * punctuation below all continue the current expression — most importantly `=`
 * (`const { chromium } = require(…)`) and `)` (`})().catch(…)`).
 */
function continuesStatement(code: string, index: number): boolean {
  const peek = peekToken(code, index);
  if (peek === '') return false;
  if (peek === 'else' || peek === 'catch' || peek === 'finally' || peek === 'while') return true;
  // An identifier, literal or opening bracket starts a fresh statement.
  if (IDENT_CHAR.test(peek)) return false;
  if (peek === '(' || peek === '[' || peek === '{') return false;
  return ')]},;:?=.<>+-*/%&|^!~'.includes(peek);
}

/** First non-space, non-comment token at/after `index` (a word or one char). */
function peekToken(code: string, index: number): string {
  let j = index;
  while (j < code.length) {
    const c = code.charAt(j);
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      j += 1;
      continue;
    }
    if (c === '/' && (code.charAt(j + 1) === '/' || code.charAt(j + 1) === '*')) {
      j = skipComment(code, j);
      continue;
    }
    break;
  }
  if (j >= code.length) return '';
  if (IDENT_CHAR.test(code.charAt(j))) {
    let end = j;
    while (end < code.length && IDENT_CHAR.test(code.charAt(end))) end += 1;
    return code.slice(j, end);
  }
  return code.charAt(j);
}

/* ------------------------------------------------------------------ brackets */

/** Matching bracket for each opening bracket. */
const BRACKET_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

/**
 * Index of the bracket matching the opener at `openIndex`, or `-1`.
 *
 * @param code - Source text.
 * @param openIndex - Index of an opening `(`, `[` or `{`.
 */
export function findMatching(code: string, openIndex: number): number {
  const open = code.charAt(openIndex);
  const close = BRACKET_PAIRS[open];
  if (close === undefined) return -1;

  let depth = 0;
  let i = openIndex;
  while (i < code.length) {
    const skipped = skipAtomic(code, i, code.charAt(i - 1), '');
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = code.charAt(i);
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Inner text of the bracket pair starting at `openIndex` (delimiters removed). */
export function innerOf(code: string, openIndex: number): string {
  const close = findMatching(code, openIndex);
  if (close === -1) return code.slice(openIndex + 1);
  return code.slice(openIndex + 1, close);
}

/**
 * Split `code` on `separator` occurrences that sit outside any bracket.
 *
 * @param code - Source text.
 * @param separator - Literal separator, e.g. `,`, `&&`, `:`.
 * @returns Trimmed, non-empty parts.
 */
export function splitTopLevel(code: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < code.length) {
    const skipped = skipAtomic(code, i, code.charAt(i - 1), tailWord(code.slice(start, i)));
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = code.charAt(i);
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && code.startsWith(separator, i)) {
      parts.push(code.slice(start, i).trim());
      i += separator.length;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(code.slice(start).trim());
  return parts.filter((part) => part !== '');
}

/** Strip redundant outer parentheses: `((x))` -> `x`. */
export function stripOuterParens(input: string): string {
  let text = input.trim();
  for (;;) {
    if (!text.startsWith('(')) return text;
    if (findMatching(text, 0) !== text.length - 1) return text;
    text = text.slice(1, -1).trim();
  }
}

/** Inner text of the first top-level `{ … }` block of `code`, or `null`. */
export function firstBlockBody(code: string): string | null {
  let i = 0;
  while (i < code.length) {
    const skipped = skipAtomic(code, i, code.charAt(i - 1), tailWord(code.slice(0, i)));
    if (skipped > i) {
      i = skipped;
      continue;
    }
    if (code.charAt(i) === '{') return innerOf(code, i);
    i += 1;
  }
  return null;
}

/* ---------------------------------------------------------- small utilities */

/** Number of `\n` characters in `text`. */
export function countNewlines(text: string): number {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charAt(i) === '\n') total += 1;
  return total;
}

/** Unescape a JavaScript string body (quotes already removed). */
export function unescapeString(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body.charAt(i);
    if (c !== '\\') {
      out += c;
      i += 1;
      continue;
    }
    const next = body.charAt(i + 1);
    switch (next) {
      case 'n':
        out += '\n';
        i += 2;
        break;
      case 'r':
        out += '\r';
        i += 2;
        break;
      case 't':
        out += '\t';
        i += 2;
        break;
      case 'b':
        out += '\b';
        i += 2;
        break;
      case 'f':
        out += '\f';
        i += 2;
        break;
      case 'v':
        out += '\v';
        i += 2;
        break;
      case '0':
        out += '\0';
        i += 2;
        break;
      case 'u': {
        const hex = body.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
        } else {
          out += 'u';
          i += 2;
        }
        break;
      }
      case 'x': {
        const hex = body.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else {
          out += 'x';
          i += 2;
        }
        break;
      }
      case '': // trailing backslash
        out += '\\';
        i += 1;
        break;
      default:
        out += next;
        i += 2;
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------ literal parsing */

/** Result of {@link parseJsLiteral}: either plain data or an explanation. */
export type LiteralParse = { ok: true; value: unknown } | { ok: false; reason: string };

/** True when `expr` is a quoted string or template literal. */
export function isStringish(expr: string): boolean {
  const first = expr.trim().charAt(0);
  return first === '"' || first === "'" || first === '`';
}

/**
 * Recover plain data from a JavaScript literal expression.
 *
 * Supported: strings, template literals (with `vars["x"]` holes -> `{{x}}`),
 * numbers, booleans, `null`, arrays, object literals, and `JSON.stringify(x)`
 * wrappers. Everything else fails with a reason.
 */
export function parseJsLiteral(input: string): LiteralParse {
  const expr = stripOuterParens(input);
  if (expr === '') return { ok: false, reason: 'empty expression' };

  if (expr.startsWith('JSON.stringify(') ) {
    const open = expr.indexOf('(', 0);
    const close = findMatching(expr, open);
    if (close !== expr.length - 1) {
      return { ok: false, reason: `unsupported JSON.stringify call: ${expr}` };
    }
    const arg = innerOf(expr, open);
    const nested = splitTopLevel(arg, ',');
    if (nested.length !== 1) {
      return { ok: false, reason: `JSON.stringify with a replacer/space argument: ${expr}` };
    }
    return parseJsLiteral(nested[0]!);
  }

  const first = expr.charAt(0);

  if (first === '"' || first === "'") {
    const end = skipQuoted(expr, 0, first);
    if (end !== expr.length) {
      return { ok: false, reason: `trailing text after string literal: ${expr.slice(end)}` };
    }
    return { ok: true, value: unescapeString(expr.slice(1, -1)) };
  }

  if (first === '`') {
    if (skipTemplate(expr, 0) !== expr.length) {
      return { ok: false, reason: `unterminated template literal: ${expr}` };
    }
    return parseTemplate(expr);
  }

  if (expr === 'true') return { ok: true, value: true };
  if (expr === 'false') return { ok: true, value: false };
  if (expr === 'null') return { ok: true, value: null };
  if (expr === 'undefined') return { ok: false, reason: '`undefined` cannot be stored in a flow' };

  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(expr)) {
    return { ok: true, value: Number(expr) };
  }

  if (first === '[') {
    const close = findMatching(expr, 0);
    if (close !== expr.length - 1) return { ok: false, reason: `unbalanced array literal: ${expr}` };
    const value: unknown[] = [];
    for (const part of splitTopLevel(expr.slice(1, -1), ',')) {
      const parsed = parseJsLiteral(part);
      if (!parsed.ok) return parsed;
      value.push(parsed.value);
    }
    return { ok: true, value };
  }

  if (first === '{') {
    const close = findMatching(expr, 0);
    if (close !== expr.length - 1) return { ok: false, reason: `unbalanced object literal: ${expr}` };
    const value: Record<string, unknown> = {};
    for (const entry of splitTopLevel(expr.slice(1, -1), ',')) {
      const colon = splitObjectEntry(entry);
      if (!colon) return { ok: false, reason: `object entry without a key/value split: ${entry}` };
      const key = parseObjectKey(colon.key);
      if (key === null) return { ok: false, reason: `unsupported object key: ${colon.key}` };
      const parsed = parseJsLiteral(colon.value);
      if (!parsed.ok) return parsed;
      value[key] = parsed.value;
    }
    return { ok: true, value };
  }

  return { ok: false, reason: `unsupported expression: ${expr}` };
}

/** Locate the top-level `:` separating an object key from its value. */
export function splitObjectEntry(entry: string): { key: string; value: string } | null {
  let depth = 0;
  let i = 0;
  while (i < entry.length) {
    const skipped = skipAtomic(entry, i, entry.charAt(i - 1), tailWord(entry.slice(0, i)));
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = entry.charAt(i);
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ':' && depth === 0) {
      return { key: entry.slice(0, i).trim(), value: entry.slice(i + 1).trim() };
    }
    i += 1;
  }
  return null;
}

/** Object key: quoted string, or a bare identifier / numeric key. */
export function parseObjectKey(key: string): string | null {
  if (key === '') return null;
  const first = key.charAt(0);
  if (first === '"' || first === "'") {
    if (skipQuoted(key, 0, first) !== key.length) return null;
    return unescapeString(key.slice(1, -1));
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return key;
  if (/^[0-9]+$/.test(key)) return key;
  return null;
}

/**
 * Read the raw value expression of one entry of an object literal.
 *
 * Lenient by design: sibling entries whose values are *not* literals (for
 * example `{ path: target, fullPage: true }`) do not prevent the entry of
 * interest from being read.
 *
 * @param objectText - Object literal source (`options` may be `undefined`).
 * @param key - Entry name to look up.
 * @returns The value expression, or `null` when absent.
 */
export function readObjectEntry(objectText: string | undefined, key: string): string | null {
  if (objectText === undefined) return null;
  const text = objectText.trim();
  if (!text.startsWith('{') || findMatching(text, 0) === -1) return null;
  for (const entry of splitTopLevel(innerOf(text, 0), ',')) {
    const kv = splitObjectEntry(entry);
    if (kv !== null && parseObjectKey(kv.key) === key) return kv.value;
  }
  return null;
}

/**
 * Decode a template literal back into a flow string, mapping `${vars["x"]}`
 * holes onto `{{x}}` interpolation and rejecting anything more complex.
 */
export function parseTemplate(text: string): LiteralParse {
  const body = text.slice(1, -1);
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body.charAt(i);
    if (c === '\\') {
      const next = body.charAt(i + 1);
      out += next === '`' || next === '\\' || next === '$' ? next : `\\${next}`;
      i += 2;
      continue;
    }
    if (c === '$' && body.charAt(i + 1) === '{') {
      const close = skipInterpolation(body, i + 1);
      const expr = body.slice(i + 2, close - 1).trim();
      const lookup = parseVarsLookup(expr);
      if (!lookup) {
        return { ok: false, reason: `unsupported template hole \${${expr}}` };
      }
      out += `{{${lookup.name}}}`;
      i = close;
      continue;
    }
    out += c;
    i += 1;
  }
  return { ok: true, value: out };
}

/**
 * Recover a flow string from an expression: string literal, or template
 * literal with `vars[...]` holes.
 */
export function parseStringExpr(expr: string): string | null {
  const parsed = parseJsLiteral(expr);
  if (parsed.ok && typeof parsed.value === 'string') return parsed.value;
  return null;
}

/** A recovered `vars[name]` access, plus any `?? fallback` suffix. */
export interface VarsLookup {
  name: string;
  /** Text after the closing `]`, e.g. `?? []`. */
  suffix: string;
}

/** Recover `vars["name"]` / `vars['name']` / `vars.name` accesses. */
export function parseVarsLookup(expr: string): VarsLookup | null {
  const text = stripOuterParens(expr);
  if (!text.startsWith('vars')) return null;
  const after = text.slice(4);
  if (after.startsWith('[')) {
    const close = findMatching(text, 4);
    if (close === -1) return null;
    const key = parseObjectKey(text.slice(5, close).trim());
    if (key === null) return null;
    return { name: key, suffix: text.slice(close + 1).trim() };
  }
  const dot = /^\.([A-Za-z_$][A-Za-z0-9_$]*)([\s\S]*)$/.exec(after);
  if (dot) return { name: dot[1]!, suffix: dot[2]!.trim() };
  return null;
}

/** A recovered `process.env["KEY"]` access with an optional default. */
export interface EnvLookup {
  key: string;
  /** Default value expression, when the script used `?? <default>`. */
  fallback: string | null;
}

/** Recover `process.env["KEY"]` (optionally `?? default`) accesses. */
export function parseEnvLookup(expr: string): EnvLookup | null {
  const text = stripOuterParens(expr);
  if (!text.startsWith('process.env[')) return null;
  const close = findMatching(text, 'process.env'.length);
  if (close === -1) return null;
  const key = parseObjectKey(text.slice('process.env['.length, close).trim());
  if (key === null) return null;
  const rest = text.slice(close + 1).trim();
  if (rest === '') return { key, fallback: null };
  if (!rest.startsWith('??')) return null;
  return { key, fallback: rest.slice(2).trim() };
}

/* --------------------------------------------------------------- statements */

/** A parsed `receiver.method(args)` or bare `helper(args)` invocation. */
export interface CallSplit {
  /** Receiver expression; empty string for a bare helper call. */
  receiver: string;
  /** Property / function name. */
  method: string;
  args: string;
}

/** Drop a trailing `;` from a statement. */
export function stripSemicolon(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trim() : trimmed;
}

/** Drop a leading `await ` from an expression. */
export function stripAwait(text: string): string {
  return text.trim().replace(/^await\s+/, '').trim();
}

/** Index of the last `.` outside any bracket, or `-1`. */
export function lastDotIndex(head: string): number {
  let depth = 0;
  let found = -1;
  let i = 0;
  while (i < head.length) {
    const skipped = skipAtomic(head, i, head.charAt(i - 1), tailWord(head.slice(0, i)));
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = head.charAt(i);
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === '.' && depth === 0) found = i;
    i += 1;
  }
  return found;
}

/**
 * Split `[await ]receiver.method(args)` (or a bare `helper(args)`) into parts.
 *
 * The argument list is the *last* top-level `(` whose matching `)` ends the
 * statement, which keeps `(await firstMatch(page, […])).click()` working.
 */
export function splitCall(text: string): CallSplit | null {
  const t = stripAwait(stripSemicolon(text));
  let depth = 0;
  let i = 0;
  let found: { open: number; close: number } | null = null;
  while (i < t.length) {
    const skipped = skipAtomic(t, i, t.charAt(i - 1), tailWord(t.slice(0, i)));
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = t.charAt(i);
    if (c === '(') {
      if (depth === 0) {
        const close = findMatching(t, i);
        if (close === t.length - 1) found = { open: i, close };
      }
      depth += 1;
    } else if (c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    i += 1;
  }
  if (!found) return null;

  const head = t.slice(0, found.open).trim();
  const args = t.slice(found.open + 1, found.close);
  const dot = lastDotIndex(head);
  if (dot === -1) {
    // Bare helper call: `clickSelector(cdp, …)`.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(head)) return null;
    return { receiver: '', method: head, args };
  }
  const method = head.slice(dot + 1).trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(method)) return null;
  return { receiver: head.slice(0, dot).trim(), method, args };
}

/** A parsed top-level assignment. */
export interface AssignmentSplit {
  target: string;
  value: string;
}

/** Split `target = value` on the first top-level `=` (ignoring `==`, `=>`, …). */
export function splitAssignment(text: string): AssignmentSplit | null {
  const t = stripSemicolon(text);
  let depth = 0;
  let i = 0;
  while (i < t.length) {
    const skipped = skipAtomic(t, i, t.charAt(i - 1), tailWord(t.slice(0, i)));
    if (skipped > i) {
      i = skipped;
      continue;
    }
    const c = t.charAt(i);
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === '=' && depth === 0) {
      const prev = t.charAt(i - 1);
      const next = t.charAt(i + 1);
      if (next === '=' || next === '>' || '=!<>+-*/%&|^'.includes(prev)) {
        i += 1;
        continue;
      }
      return { target: t.slice(0, i).trim(), value: t.slice(i + 1).trim() };
    }
    i += 1;
  }
  return null;
}

/** Split a `const name = value;` declaration. */
export function splitConstDeclaration(text: string): AssignmentSplit | null {
  const t = stripSemicolon(text);
  if (!/^(?:const|let|var)\s/.test(t)) return null;
  const withoutKeyword = t.replace(/^(?:const|let|var)\s+/, '');
  return splitAssignment(withoutKeyword);
}

/** A parsed `if (…) { … } else { … }` statement. */
export interface IfElseSplit {
  condition: string;
  thenBody: string;
  /** Body text to tokenize; `null` when the statement has no `else`. */
  elseBody: string | null;
}

/** Split an `if (cond) { then } else { otherwise }` statement. */
export function splitIfElse(text: string): IfElseSplit | null {
  const t = stripSemicolon(text.trim());
  if (!/^if\b/.test(t)) return null;
  const openParen = t.indexOf('(', 2);
  if (openParen === -1) return null;
  const closeParen = findMatching(t, openParen);
  if (closeParen === -1) return null;

  const condition = t.slice(openParen + 1, closeParen);
  const braceStart = t.indexOf('{', closeParen);
  if (braceStart === -1) return null;
  const braceEnd = findMatching(t, braceStart);
  if (braceEnd === -1) return null;

  const thenBody = t.slice(braceStart + 1, braceEnd);
  const rest = t.slice(braceEnd + 1).trim();
  if (rest === '') return { condition, thenBody, elseBody: null };
  if (!/^else\b/.test(rest)) return null;

  const otherwise = rest.replace(/^else\b/, '').trim();
  if (otherwise.startsWith('{')) {
    const close = findMatching(otherwise, 0);
    return { condition, thenBody, elseBody: close === -1 ? otherwise : otherwise.slice(1, close) };
  }
  // `else if (…)` chains stay as source text and are parsed recursively.
  return { condition, thenBody, elseBody: otherwise };
}

/** A parsed `for (…) { … }` statement. */
export interface ForSplit {
  header: string;
  body: string;
}

/** Split a `for (…) { … }` statement into its header and body. */
export function splitFor(text: string): ForSplit | null {
  const t = stripSemicolon(text.trim());
  if (!/^for\b/.test(t)) return null;
  const braceStart = t.indexOf('{');
  if (braceStart === -1) return null;
  return { header: t.slice(0, braceStart).trim(), body: innerOf(t, braceStart) };
}

/** Every string literal in `text`, decoded (templates are decoded verbatim). */
export function collectStringLiterals(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(text, i, ch);
      out.push(unescapeString(text.slice(i + 1, Math.max(i + 1, end - 1))));
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = skipTemplate(text, i);
      out.push(text.slice(i + 1, Math.max(i + 1, end - 1)));
      i = end;
      continue;
    }
    const skipped = skipAtomic(text, i, text.charAt(i - 1), tailWord(text.slice(0, i)));
    i = skipped > i ? skipped : i + 1;
  }
  return out;
}
