/**
 * Metrics + screencast tests (spec 11: browser package, mock CDPSession).
 */
import { describe, expect, it } from 'vitest';
import type { CDPSession, CdpEventHandler } from './cdp-session.js';
import { clientToPage, getLayoutMetrics, type LayoutMetrics } from './metrics.js';
import { captureJpegFrame, startScreencast, stopScreencast } from './screencast.js';

/** Scripted in-memory CDP session. */
function fakeSession(respond: (method: string, params?: object) => unknown): {
  session: CDPSession;
  calls: Array<{ method: string; params?: object }>;
  fire(event: string, params: unknown): void;
} {
  const listeners = new Map<string, Set<CdpEventHandler>>();
  const calls: Array<{ method: string; params?: object }> = [];
  return {
    calls,
    fire(event, params) {
      for (const handler of listeners.get(event) ?? []) handler(params);
    },
    session: {
      async send<T>(method: string, params?: object): Promise<T> {
        calls.push({ method, ...(params ? { params } : {}) });
        return respond(method, params) as T;
      },
      on(event, handler) {
        let set = listeners.get(event);
        if (!set) {
          set = new Set();
          listeners.set(event, set);
        }
        set.add(handler);
      },
      off(event, handler) {
        listeners.get(event)?.delete(handler);
      },
      async detach() {},
    },
  };
}

describe('getLayoutMetrics', () => {
  it('normalises css* responses and reads devicePixelRatio', async () => {
    const { session } = fakeSession((method) => {
      if (method === 'Page.getLayoutMetrics') {
        return {
          cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
          cssVisualViewport: { pageX: 10, pageY: 20, clientWidth: 1280, clientHeight: 720 },
          cssContentSize: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 2000 },
        };
      }
      if (method === 'Runtime.evaluate') return { result: { value: 2 } };
      return {};
    });

    const metrics = await getLayoutMetrics(session);
    expect(metrics.cssVisualViewport).toMatchObject({
      pageX: 10,
      pageY: 20,
      clientWidth: 1280,
      clientHeight: 720,
    });
    expect(metrics.contentSize.clientHeight).toBe(2000);
    expect(metrics.deviceScaleFactor).toBe(2);
  });

  it('falls back to legacy layoutViewport keys and DPR 1', async () => {
    const { session } = fakeSession((method) => {
      if (method === 'Page.getLayoutMetrics') {
        return { layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      }
      return {};
    });
    const metrics = await getLayoutMetrics(session);
    expect(metrics.cssLayoutViewport.clientWidth).toBe(800);
    expect(metrics.deviceScaleFactor).toBe(1);
  });
});

describe('clientToPage', () => {
  const metrics: LayoutMetrics = {
    cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 },
    cssVisualViewport: { pageX: 100, pageY: 50, clientWidth: 640, clientHeight: 360 },
    contentSize: { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 3000 },
    deviceScaleFactor: 2,
  };

  it('scales canvas pixels into page CSS pixels and adds the scroll offset', async () => {
    const { session } = fakeSession(() => ({}));
    const point = await clientToPage(
      session,
      { x: 320, y: 180 },
      { width: 640, height: 360 },
      metrics,
    );
    expect(point).toEqual({ x: 420, y: 230 });
  });

  it('does not issue a CDP round trip when metrics are supplied', async () => {
    const { session, calls } = fakeSession(() => ({}));
    await clientToPage(session, { x: 10, y: 10 }, { width: 640, height: 360 }, metrics);
    expect(calls).toHaveLength(0);
  });

  it('rejects a zero-sized canvas', async () => {
    const { session } = fakeSession(() => ({}));
    await expect(
      clientToPage(session, { x: 1, y: 1 }, { width: 0, height: 0 }, metrics),
    ).rejects.toThrow(/zero size/i);
  });

  it('clamps negative coordinates to the page origin', async () => {
    const { session } = fakeSession(() => ({}));
    const point = await clientToPage(
      session,
      { x: -50, y: -50 },
      { width: 640, height: 360 },
      {
        ...metrics,
        cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 640, clientHeight: 360 },
      },
    );
    expect(point).toEqual({ x: 0, y: 0 });
  });
});

describe('startScreencast', () => {
  it('sends start options, acks every frame and stops idempotently', async () => {
    const { session, calls, fire } = fakeSession((method) => {
      if (method === 'Page.captureScreenshot') return { data: 'JPEG' };
      return {};
    });

    const frames: string[] = [];
    const handle = await startScreencast(
      session,
      (frame) => {
        frames.push(frame.data);
      },
      { quality: 55, maxWidth: 800, everyNthFrame: 2 },
    );

    const startCall = calls.find((call) => call.method === 'Page.startScreencast');
    expect(startCall?.params).toMatchObject({ quality: 55, maxWidth: 800, everyNthFrame: 2 });

    fire('Page.screencastFrame', { data: 'AAA', sessionId: 1, metadata: {} });
    fire('Page.screencastFrame', { data: 'BBB', sessionId: 2, metadata: {} });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(frames).toEqual(['AAA', 'BBB']);
    expect(handle.frameCount()).toBe(2);
    expect(calls.filter((call) => call.method === 'Page.screencastFrameAck')).toHaveLength(2);
    expect(handle.ackCount()).toBe(2);

    await handle.stop();
    await handle.stop();
    expect(calls.filter((call) => call.method === 'Page.stopScreencast')).toHaveLength(1);

    // Frames after stop are ignored.
    fire('Page.screencastFrame', { data: 'CCC', sessionId: 3, metadata: {} });
    expect(handle.frameCount()).toBe(2);
  });

  it('ignores a malformed frame without a numeric sessionId', async () => {
    const { session, fire } = fakeSession(() => ({}));
    const handle = await startScreencast(session, () => undefined);
    fire('Page.screencastFrame', { data: 'x', sessionId: 'nope' });
    expect(handle.frameCount()).toBe(0);
    await handle.stop();
  });

  it('captures a standalone JPEG frame', async () => {
    const { session } = fakeSession(() => ({ data: 'ONE' }));
    await expect(captureJpegFrame(session, { quality: 40 })).resolves.toBe('ONE');
  });

  it('stopScreencast swallows protocol errors', async () => {
    const { session } = fakeSession(() => {
      throw new Error('not attached');
    });
    await expect(stopScreencast(session)).resolves.toBeUndefined();
  });
});
