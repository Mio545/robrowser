/**
 * `Input.*` helpers (spec 6).
 *
 * These wrap the raw protocol commands with the correct modifier bitmasks and
 * key event sequencing. Modifier bits follow the CDP convention:
 * Alt=1, Ctrl=2, Meta/Command=4, Shift=8.
 */
import type { CDPSession } from './cdp-session.js';
import { CdpError } from './errors.js';

/** Modifier names accepted by the helpers. */
export type ModifierName = 'alt' | 'ctrl' | 'meta' | 'shift';

/** CDP modifier bit values. */
export const MODIFIER_BITS: Record<ModifierName, number> = {
  alt: 1,
  ctrl: 2,
  meta: 4,
  shift: 8,
};

/** Mouse button names. */
export type MouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';

/** Options accepted by {@link dispatchMouse}. */
export interface MouseOptions {
  button?: MouseButton;
  clickCount?: number;
  modifiers?: ModifierName[];
}

/**
 * Combine modifier names into the CDP bitmask.
 *
 * @param modifiers - Modifier names.
 * @returns The OR-ed bitmask (0 when none).
 */
export function modifierMask(modifiers: readonly ModifierName[] = []): number {
  return modifiers.reduce((mask, name) => mask | (MODIFIER_BITS[name] ?? 0), 0);
}

/**
 * Dispatch a full mouse click at a point (press + release).
 *
 * @param session - Page CDP session.
 * @param x - Page X in CSS pixels.
 * @param y - Page Y in CSS pixels.
 * @param options - Button / click count / modifiers.
 */
export async function dispatchMouse(
  session: CDPSession,
  x: number,
  y: number,
  options: MouseOptions = {},
): Promise<void> {
  const button = options.button ?? 'left';
  const clickCount = options.clickCount ?? 1;
  const modifiers = modifierMask(options.modifiers);

  // A preceding mouseMoved makes hover-driven UI settle, matching real input.
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    modifiers,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button,
    clickCount,
    modifiers,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button,
    clickCount,
    modifiers,
  });
}

/**
 * Move the mouse without pressing (used by takeover input).
 */
export async function dispatchMouseMove(
  session: CDPSession,
  x: number,
  y: number,
  modifiers: readonly ModifierName[] = [],
): Promise<void> {
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    modifiers: modifierMask(modifiers),
  });
}

/**
 * Dispatch a mouse press or release (used for drag / long press).
 */
export async function dispatchMouseButton(
  session: CDPSession,
  type: 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
  options: MouseOptions = {},
): Promise<void> {
  await session.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: options.button ?? 'left',
    clickCount: options.clickCount ?? 1,
    modifiers: modifierMask(options.modifiers),
  });
}

/**
 * Dispatch a wheel (scroll) event.
 *
 * @param deltaX - Horizontal delta in CSS pixels.
 * @param deltaY - Vertical delta in CSS pixels.
 */
export async function dispatchWheel(
  session: CDPSession,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x,
    y,
    deltaX,
    deltaY,
  });
}

/** Options accepted by {@link dispatchKey}. */
export interface KeyOptions {
  /** Modifier names held while the key is pressed. */
  modifiers?: ModifierName[];
  /** `key` value, e.g. `Enter`, `a`, `Escape`. */
  key?: string;
  /** `code` value, e.g. `KeyA`, `Enter`. */
  code?: string;
  /** Windows virtual key code (required by many sites). */
  windowsVirtualKeyCode?: number;
  /** Native virtual key code (optional). */
  nativeVirtualKeyCode?: number;
  /** Text produced by the key (for `char` events). */
  text?: string;
}

/**
 * Dispatch a key press: `keyDown` -> optional `char` -> `keyUp`.
 *
 * Using `rawKeyDown` for non-text keys avoids phantom `char` events.
 */
export async function dispatchKey(
  session: CDPSession,
  key: string,
  options: KeyOptions = {},
): Promise<void> {
  const modifiers = modifierMask(options.modifiers);
  const code = options.code ?? keyToCode(key);
  const vk = options.windowsVirtualKeyCode ?? keyCode(key);
  // Shortcut chords (Ctrl/Meta/Alt + key) must not emit text: otherwise
  // Ctrl+A would both select-all *and* type a literal "a".
  const isChord =
    modifiers !== 0 &&
    (modifiers & (MODIFIER_BITS.ctrl | MODIFIER_BITS.meta | MODIFIER_BITS.alt)) !== 0;
  const text = options.text ?? (key.length === 1 && !isChord ? key : undefined);

  await session.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: options.nativeVirtualKeyCode ?? vk,
    modifiers,
    ...(text ? { text } : {}),
  });
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: options.nativeVirtualKeyCode ?? vk,
    modifiers,
  });
}

/**
 * Insert text directly without key events (IME / clipboard friendly). This is
 * the correct path for takeover "paste text" and for CJK input.
 */
export async function insertText(session: CDPSession, text: string): Promise<void> {
  if (text.length === 0) return;
  await session.send('Input.insertText', { text });
}

/** Send a `char` event (used when the domain requires explicit text input). */
export async function dispatchChar(session: CDPSession, text: string): Promise<void> {
  if (text.length === 0) throw new CdpError('dispatchChar requires non-empty text');
  await session.send('Input.dispatchKeyEvent', { type: 'char', text });
}

/** Best-effort `code` for a `key` value. */
export function keyToCode(key: string): string {
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/[A-Z]/.test(upper)) return `Key${upper}`;
    if (/[0-9]/.test(key)) return `Digit${key}`;
    return '';
  }
  const map: Record<string, string> = {
    Enter: 'Enter',
    Tab: 'Tab',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ' ': 'Space',
  };
  return map[key] ?? key;
}

/** Best-effort Windows virtual key code for common keys. */
export function keyCode(key: string): number {
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/[A-Z]/.test(upper)) return upper.charCodeAt(0);
    if (/[0-9]/.test(key)) return key.charCodeAt(0);
    return key.charCodeAt(0);
  }
  const map: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Meta: 91,
  };
  return map[key] ?? 0;
}
