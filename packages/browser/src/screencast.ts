/**
 * `Page.startScreencast` wrapper with mandatory frame acknowledgement
 * (spec 6 / 8.2).
 *
 * CDP only keeps sending frames while every frame is ACKed. This module pairs
 * the ack with a *bounded* callback so a slow consumer cannot deadlock the
 * stream: the ack is always sent, and the callback is invoked without awaiting
 * it back into the protocol loop.
 */
import type { CDPSession } from './cdp-session.js';

/** A single screencast frame. */
export interface ScreencastFrame {
  /** Base64-encoded image data. */
  data: string;
  /** Frame metadata (dimensions, timestamps, offset). */
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
  /** Monotonic session id, echoed back in the ack. */
  sessionId: number;
}

/** Options for {@link startScreencast}. */
export interface ScreencastOptions {
  /** `jpeg` (default, smaller) or `png`. */
  format?: 'jpeg' | 'png';
  /** JPEG quality 0-100. */
  quality?: number;
  /** Downscale frames to at most this width. */
  maxWidth?: number;
  /** Downscale frames to at most this height. */
  maxHeight?: number;
  /** Emit only every Nth frame (reduces bandwidth). */
  everyNthFrame?: number;
}

/** Handle returned by {@link startScreencast}. */
export interface ScreencastHandle {
  /** Detach listeners and stop the screencast. */
  stop(): Promise<void>;
  /** Number of frames delivered so far. */
  frameCount(): number;
  /** Number of frames acknowledged so far. */
  ackCount(): number;
}

/**
 * Start streaming frames from a page.
 *
 * @param session - Page CDP session.
 * @param onFrame - Called for every frame; must not throw (errors are swallowed
 *   but logged through the optional `onError` handler).
 * @param options - Frame format / throttling.
 * @param onError - Optional error sink for callback failures.
 * @returns A handle used to stop the stream.
 */
export async function startScreencast(
  session: CDPSession,
  onFrame: (frame: ScreencastFrame) => void | Promise<void>,
  options: ScreencastOptions = {},
  onError?: (error: unknown) => void,
): Promise<ScreencastHandle> {
  let frames = 0;
  let acks = 0;
  let stopped = false;

  const handler = (params: unknown): void => {
    const frame = params as ScreencastFrame;
    if (!frame || typeof frame.sessionId !== 'number') return;
    frames += 1;

    // Always ack — a missing ack permanently stalls the screencast.
    void session
      .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
      .then(() => {
        acks += 1;
      })
      .catch((error: unknown) => onError?.(error));

    try {
      const result = onFrame(frame);
      if (result instanceof Promise) {
        result.catch((error: unknown) => onError?.(error));
      }
    } catch (error) {
      onError?.(error);
    }
  };

  session.on('Page.screencastFrame', handler);
  await session.send('Page.startScreencast', {
    format: options.format ?? 'jpeg',
    quality: options.quality ?? 70,
    maxWidth: options.maxWidth ?? 1280,
    maxHeight: options.maxHeight ?? 720,
    everyNthFrame: options.everyNthFrame ?? 1,
  });

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      session.off('Page.screencastFrame', handler);
      try {
        await session.send('Page.stopScreencast');
      } catch {
        // Stopping an already-stopped screencast is not an error.
      }
    },
    frameCount: () => frames,
    ackCount: () => acks,
  };
}

/**
 * Stop a screencast started elsewhere (idempotent).
 */
export async function stopScreencast(session: CDPSession): Promise<void> {
  try {
    await session.send('Page.stopScreencast');
  } catch {
    // ignore
  }
}

/**
 * Capture one JPEG frame without starting a continuous screencast.
 *
 * Used for the takeover page's initial paint, where a live stream is not needed
 * until the operator focuses the canvas.
 */
export async function captureJpegFrame(
  session: CDPSession,
  options: { quality?: number } = {},
): Promise<string> {
  const result = await session.send<{ data: string }>('Page.captureScreenshot', {
    format: 'jpeg',
    quality: options.quality ?? 70,
    fromSurface: true,
  });
  return result.data;
}
