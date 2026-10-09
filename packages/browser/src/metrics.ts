/**
 * Layout metrics + coordinate conversion (spec 6 / 8.5).
 *
 * The remote takeover page reports mouse coordinates in *canvas display* space.
 * To dispatch them to CDP we must convert back to page CSS pixels, accounting
 * for the visual viewport offset (scrolling), the layout viewport size, and any
 * device pixel ratio / zoom the browser applied.
 */
import type { CDPSession } from './cdp-session.js';
import { CdpError } from './errors.js';

/** Subset of `Page.getLayoutMetrics` used by the engine. */
export interface LayoutMetrics {
  /** Page geometry in CSS pixels. */
  cssLayoutViewport: ViewportRect;
  /** Page geometry in device pixels (before zoom). */
  cssVisualViewport: ViewportRect;
  /** Content size in CSS pixels. */
  contentSize: ViewportRect;
  /** Zoom factor applied by the browser (devicePixelRatio independent). */
  deviceScaleFactor: number;
}

/** A rectangle with page-space origin and size. */
export interface ViewportRect {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
  /** Present on `cssLayoutViewport` in newer protocol versions. */
  clientX?: number;
  clientY?: number;
}

/** Raw protocol response shape for `Page.getLayoutMetrics`. */
interface RawLayoutMetrics {
  layoutViewport?: Record<string, number>;
  visualViewport?: Record<string, number>;
  contentSize?: Record<string, number>;
  cssLayoutViewport?: Record<string, number>;
  cssVisualViewport?: Record<string, number>;
  cssContentSize?: Record<string, number>;
}

/**
 * Read layout metrics, normalising the protocol's newer (`css*`) and legacy
 * (`layoutViewport`) response shapes.
 */
export async function getLayoutMetrics(session: CDPSession): Promise<LayoutMetrics> {
  const raw = await session.send<RawLayoutMetrics>('Page.getLayoutMetrics');
  const layout = raw.cssLayoutViewport ?? raw.layoutViewport ?? {};
  const visual = raw.cssVisualViewport ?? raw.visualViewport ?? {};
  const content = raw.cssContentSize ?? raw.contentSize ?? {};
  return {
    cssLayoutViewport: toRect(layout),
    cssVisualViewport: toRect(visual),
    contentSize: toRect(content),
    deviceScaleFactor: await getDeviceScaleFactor(session),
  };
}

function toRect(source: Record<string, number>): ViewportRect {
  return {
    pageX: Number(source.pageX ?? 0),
    pageY: Number(source.pageY ?? 0),
    clientWidth: Number(source.clientWidth ?? source.width ?? 0),
    clientHeight: Number(source.clientHeight ?? source.height ?? 0),
    ...(source.clientX !== undefined ? { clientX: Number(source.clientX) } : {}),
    ...(source.clientY !== undefined ? { clientY: Number(source.clientY) } : {}),
  };
}

/** `devicePixelRatio` as reported by the page (1 when evaluation fails). */
export async function getDeviceScaleFactor(session: CDPSession): Promise<number> {
  try {
    const result = await session.send<{ result?: { value?: number } }>('Runtime.evaluate', {
      expression: 'window.devicePixelRatio || 1',
      returnByValue: true,
    });
    const value = result?.result?.value;
    return typeof value === 'number' && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

/**
 * Convert a point from the takeover canvas' display space into page CSS pixels.
 *
 * @param session - Page CDP session.
 * @param display - Mouse position inside the rendered canvas, in canvas pixels.
 * @param canvas - The canvas' CSS size as rendered in the operator's browser.
 * @param clientViewport - Optional explicit viewport metrics (avoids a round trip).
 * @returns Absolute page coordinates suitable for `Input.dispatchMouseEvent`.
 */
export async function clientToPage(
  session: CDPSession,
  display: { x: number; y: number },
  canvas: { width: number; height: number },
  clientViewport?: LayoutMetrics,
): Promise<{ x: number; y: number }> {
  const metrics = clientViewport ?? (await getLayoutMetrics(session));

  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new CdpError('Canvas has zero size; cannot convert coordinates', { canvas });
  }

  // The screencast frame corresponds to the visual viewport. Scale the operator's
  // canvas pixels back to CSS pixels of that viewport.
  const scaleX = metrics.cssVisualViewport.clientWidth / canvas.width;
  const scaleY = metrics.cssVisualViewport.clientHeight / canvas.height;

  // `visualViewport.pageX/pageY` already include scroll offset.
  const x = metrics.cssVisualViewport.pageX + display.x * scaleX;
  const y = metrics.cssVisualViewport.pageY + display.y * scaleY;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
}

/**
 * Compute the geometry of an element in page coordinates.
 *
 * @param session - Page CDP session.
 * @param selector - CSS selector (already resolved from a SelectorSpec).
 * @returns Border-box centre and size in page CSS pixels; `null` when absent.
 */
export async function elementPageBox(
  session: CDPSession,
  selector: string,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const expression = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;var r=el.getBoundingClientRect();var sx=window.scrollX||0,sy=window.scrollY||0;return {x:r.left+sx+r.width/2,y:r.top+sy+r.height/2,left:r.left+sx,top:r.top+sy,width:r.width,height:r.height};})()`;
  const result = await session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  const value = result?.result?.value as {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  return value ?? null;
}
