/**
 * Coordinate conversion for takeover input (spec 8.5).
 *
 * The browser sends pointer positions in *canvas display* pixels plus the canvas
 * dimensions it rendered at. We scale those back to page CSS pixels using
 * `Page.getLayoutMetrics`, which accounts for scrolling, page zoom and the
 * visual viewport offset.
 */
import type { CDPSession } from '@robrowser/browser';
import { getLayoutMetrics, type LayoutMetrics } from '@robrowser/browser';
import { TakeoverError } from '@robrowser/core';

/** Canvas geometry reported by the client. */
export interface CanvasGeometry {
  width: number;
  height: number;
}

/**
 * Convert canvas-relative coordinates into absolute page coordinates.
 *
 * @param session - Page CDP session.
 * @param point - Pointer position inside the canvas (canvas pixels).
 * @param canvas - Canvas display size in CSS pixels.
 * @param metrics - Optional pre-fetched layout metrics (avoids a round trip).
 * @returns Absolute page coordinates for `Input.dispatchMouseEvent`.
 */
export async function takeoverToPage(
  session: CDPSession,
  point: { x: number; y: number },
  canvas: CanvasGeometry,
  metrics?: LayoutMetrics,
): Promise<{ x: number; y: number }> {
  if (canvas.width <= 0 || canvas.height <= 0) {
    throw new TakeoverError('TAKEOVER_ERROR', 'Client reported a zero-sized canvas', { canvas });
  }
  const layout = metrics ?? (await getLayoutMetrics(session));
  const view = layout.cssVisualViewport;

  // The screencast frame covers the visual viewport. Clamp the incoming point to
  // the canvas so a stray coordinate cannot address content outside the page.
  const clampedX = Math.min(Math.max(point.x, 0), canvas.width);
  const clampedY = Math.min(Math.max(point.y, 0), canvas.height);

  const scaleX = view.clientWidth / canvas.width;
  const scaleY = view.clientHeight / canvas.height;

  return {
    x: Math.round(view.pageX + clampedX * scaleX),
    y: Math.round(view.pageY + clampedY * scaleY),
  };
}
