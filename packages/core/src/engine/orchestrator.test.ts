/**
 * Orchestrator tests (spec 11: core — mock page/handler).
 *
 * These never touch a real browser: a `FakePage` implements the small
 * {@link PagePort} surface, and the built-in registry is used with a couple of
 * handlers overridden where the test needs determinism.
 */
import { describe, expect, it, vi } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import { EventBus, type RunEvent } from '../events/bus.js';
import { VariableStore } from '../vars/store.js';
import { createDefaultRegistry } from '../steps/index.js';
import { AutoResolveManualHandler, UnsupportedManualHandler } from '../handlers/manual.js';
import { readCheckpoint } from './checkpoint.js';
import { StepTimeoutError, SelectorNotFoundError } from '../errors.js';
import type { FlowModel, Step } from '../flow/schema.js';
import type { ElementHandleInfo, LoggerPort, PagePort, ScreenshotOptions } from './ports.js';

/** Minimal in-memory page implementing the {@link PagePort} contract. */
class FakePage implements PagePort {
  public urlValue = 'about:blank';
  public titleValue = 'Fake';
  public visible = new Set<string>();
  public textValues = new Map<string, string>();
  public screenshotCalls = 0;
  public waitForSelectorImpl:
    ((sel: unknown, opts?: { state?: string; timeout?: number }) => Promise<void>) | undefined;

  public cdp(): never {
    throw new Error('not implemented in FakePage.cdp');
  }
  public async goto(url: string): Promise<void> {
    this.urlValue = url;
  }
  public async evaluate<T>(): Promise<T> {
    return undefined as T;
  }
  public async evaluateIsolated<T>(): Promise<T> {
    return undefined as T;
  }
  public async click(): Promise<void> {
    return undefined;
  }
  public async type(): Promise<void> {
    return undefined;
  }
  public async selectOption(): Promise<void> {
    return undefined;
  }
  public async hover(): Promise<void> {
    return undefined;
  }
  public async scroll(): Promise<void> {
    return undefined;
  }
  public async screenshot(_opts?: ScreenshotOptions): Promise<Buffer> {
    this.screenshotCalls += 1;
    return Buffer.from('png');
  }
  public async content(): Promise<string> {
    return '<html></html>';
  }
  public async url(): Promise<string> {
    return this.urlValue;
  }
  public async title(): Promise<string> {
    return this.titleValue;
  }
  public async query(sel: unknown): Promise<ElementHandleInfo | null> {
    const key = typeof sel === 'string' ? sel : JSON.stringify(sel);
    if (this.visible.has(key)) {
      return { box: { x: 0, y: 0, width: 10, height: 10 }, text: 'hit' };
    }
    return null;
  }
  public async queryAll(): Promise<ElementHandleInfo[]> {
    return [];
  }
  public async readAll(): Promise<Array<string | null>> {
    return [];
  }
  public async attr(sel: unknown): Promise<string | null> {
    const key = typeof sel === 'string' ? sel : JSON.stringify(sel);
    return this.textValues.get(key) ?? null;
  }
  public async text(sel: unknown): Promise<string | null> {
    const key = typeof sel === 'string' ? sel : JSON.stringify(sel);
    return this.textValues.get(key) ?? null;
  }
  public async key(): Promise<void> {}
  public async insertText(): Promise<void> {}
  public async waitForSelector(
    sel: unknown,
    opts?: { state?: string; timeout?: number },
  ): Promise<void> {
    if (this.waitForSelectorImpl) return this.waitForSelectorImpl(sel, opts);
    return undefined;
  }
  public async waitForUrl(): Promise<void> {}
  public async waitForNetworkIdle(): Promise<void> {}
  public async waitForDownload(): Promise<never> {
    throw new Error('not implemented');
  }
  public async fingerprint(): Promise<{ url: string; title: string }> {
    return { url: this.urlValue, title: this.titleValue };
  }
  public on(): void {}
  public off(): void {}
}

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** A temp run dir unique per test. */
function runDir(tag: string): string {
  return `${process.env.TEMP ?? '/tmp'}/robrowser-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function flowOf(steps: Step[], onError?: FlowModel['onError']): FlowModel {
  return {
    version: '1.0',
    id: 'test-flow',
    name: 'Test flow',
    steps,
    ...(onError ? { onError } : {}),
  };
}

describe('Orchestrator', () => {
  it('runs a linear flow and emits the typed lifecycle events', async () => {
    const page = new FakePage();
    const bus = new EventBus();
    const events: RunEvent[] = [];
    bus.onAny((event) => events.push(event));

    const variables = new VariableStore();
    await variables.declare({ who: { type: 'const', value: 'alice' } });

    const flow = flowOf([
      { id: 'go', type: 'goto', url: 'file:///login.html' },
      { id: 'set', type: 'setVar', name: 'greeting', value: 'hi {{who}}' },
    ]);

    const orchestrator = new Orchestrator({
      page,
      bus,
      variableStore: variables,
      runDir: runDir('linear'),
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    });

    const result = await orchestrator.run(flow);
    expect(result.status).toBe('success');
    expect(result.stepCount).toBe(2);
    expect(result.variables.greeting).toBe('hi alice');
    expect(page.urlValue).toBe('file:///login.html');

    const names = events.map((event) => event.type);
    expect(names).toContain('run:start');
    expect(names.filter((name) => name === 'step:ok')).toHaveLength(2);
    expect(names).toContain('run:end');
  });

  it('takes the branch matching the condition and runs nested steps', async () => {
    const page = new FakePage();
    page.visible.add(JSON.stringify({ css: '#welcome' }));
    const variables = new VariableStore();
    variables.set('orders', 3);

    const flow = flowOf([
      {
        id: 'branch',
        type: 'branch',
        condition: {
          all: [
            { selectorExists: { css: '#welcome' } },
            { varEquals: { name: 'orders', value: 3 } },
          ],
        },
        then: [{ id: 'then', type: 'setVar', name: 'took', value: 'then' }],
        else: [{ id: 'else', type: 'setVar', name: 'took', value: 'else' }],
      },
    ]);

    const result = await new Orchestrator({
      page,
      variableStore: variables,
      runDir: runDir('branch'),
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(flow);

    expect(result.status).toBe('success');
    expect(variables.get('took')).toBe('then');
  });

  it('iterates a literal array with a loop and binds the item variable', async () => {
    const variables = new VariableStore();
    const flow = flowOf([
      {
        id: 'loop',
        type: 'loop',
        items: ['a', 'b', 'c'],
        as: 'item',
        steps: [{ id: 'record', type: 'setVar', name: 'last', value: '{{item}}' }],
      },
    ]);

    const result = await new Orchestrator({
      page: new FakePage(),
      variableStore: variables,
      runDir: runDir('loop'),
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(flow);

    expect(result.status).toBe('success');
    expect(variables.get('last')).toBe('c');
    // loop + 3 nested = 4 executed steps.
    expect(result.stepCount).toBe(4);
  });

  it('retries a failing step per flow.onError and succeeds on the next attempt', async () => {
    const page = new FakePage();
    const registry = createDefaultRegistry();
    let attempts = 0;
    registry.override({
      type: 'click',
      validate: () => [],
      execute: async () => {
        attempts += 1;
        if (attempts < 2) throw new SelectorNotFoundError({ css: '#late' });
        return { status: 'ok' };
      },
    });

    const flow = flowOf([{ id: 'click', type: 'click', selector: { css: '#late' } }], {
      retry: 1,
      backoff: 'none',
    });

    const result = await new Orchestrator({
      page,
      registry,
      runDir: runDir('retry'),
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(flow);

    expect(result.status).toBe('success');
    expect(attempts).toBe(2);
  });

  it('reports the original error code (STEP_TIMEOUT) instead of INTERNAL_ERROR', async () => {
    const registry = createDefaultRegistry();
    registry.override({
      type: 'click',
      validate: () => [],
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { status: 'ok' };
      },
    });

    const step = {
      id: 'slow',
      type: 'click',
      selector: { css: '#x' },
      timeout: 20,
    } as unknown as Step;
    const result = await new Orchestrator({
      page: new FakePage(),
      registry,
      runDir: runDir('timeout'),
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(flowOf([step]));

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe(new StepTimeoutError('slow', 20).code);
  });

  it('aborts a run through AbortSignal and reports aborted', async () => {
    const controller = new AbortController();
    const registry = createDefaultRegistry();
    registry.override({
      type: 'click',
      validate: () => [],
      execute: async () => {
        // Abort mid-step: the orchestrator observes the signal at the top of
        // the next iteration and reports the run as aborted.
        controller.abort();
        return { status: 'ok' };
      },
    });

    const flow = flowOf([
      { id: 'click', type: 'click', selector: { css: 'a' } },
      { id: 'never', type: 'setVar', name: 'x', value: 1 },
    ]);

    const result = await new Orchestrator({
      page: new FakePage(),
      registry,
      signal: controller.signal,
      runDir: runDir('abort'),
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(flow);

    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('aborted');
    expect(result.error?.code).toBe('RUN_ABORTED');
  });

  it('writes a checkpoint after each successful step and keeps it when the run fails', async () => {
    const dir = runDir('checkpoint');
    const registry = createDefaultRegistry();
    registry.override({
      type: 'click',
      validate: () => [],
      execute: async () => ({
        status: 'fail',
        message: 'boom',
        output: new StepTimeoutError('fail', 1),
      }),
    });

    const result = await new Orchestrator({
      page: new FakePage(),
      registry,
      runDir: dir,
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(
      flowOf([
        { id: 'one', type: 'setVar', name: 'a', value: 1 },
        { id: 'fail', type: 'click', selector: { css: '#x' } },
      ]),
    );

    expect(result.status).toBe('failed');
    const checkpoint = await readCheckpoint(dir);
    expect(checkpoint?.stepId).toBe('one');
  });

  it('resumes after the checkpointed step', async () => {
    const dir = runDir('resume');
    const registry = createDefaultRegistry();
    let shouldFail = true;
    registry.override({
      type: 'click',
      validate: () => [],
      execute: async () => {
        if (shouldFail) return { status: 'fail', message: 'boom' };
        return { status: 'ok' };
      },
    });

    const flow = flowOf([
      { id: 'one', type: 'setVar', name: 'a', value: 1 },
      { id: 'two', type: 'click', selector: { css: '#go' } },
    ]);

    const first = await new Orchestrator({
      page: new FakePage(),
      registry,
      runDir: dir,
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(flow);
    expect(first.status).toBe('failed');

    const checkpoint = await readCheckpoint(dir);
    expect(checkpoint).toBeTruthy();

    shouldFail = false;
    const second = await new Orchestrator({
      page: new FakePage(),
      registry,
      runDir: dir,
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(flow, { resumeFrom: checkpoint ?? undefined });

    // Only the last step runs on resume.
    expect(second.status).toBe('success');
    expect(second.stepCount).toBe(1);
  });

  it('stops with a manual handler and resumes on resolve', async () => {
    let resolveManual: ((value: { status: 'resolved'; by: string }) => void) | undefined;
    const manual = {
      request: vi.fn(
        () =>
          new Promise<{ status: 'resolved'; by: string }>((resolve) => {
            resolveManual = resolve;
          }),
      ),
    };

    const flow = flowOf([
      { id: 'pause', type: 'manual', reason: 'captcha', message: 'solve it', timeoutMs: 5_000 },
      { id: 'after', type: 'setVar', name: 'done', value: true },
    ]);

    const variables = new VariableStore();
    const pending = new Orchestrator({
      page: new FakePage(),
      variableStore: variables,
      runDir: runDir('manual'),
      logger: silentLogger,
      manual,
    }).run(flow);

    // Let the run reach the manual step.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(manual.request).toHaveBeenCalledOnce();
    resolveManual?.({ status: 'resolved', by: 'test' });

    const result = await pending;
    expect(result.status).toBe('success');
    expect(variables.get('done')).toBe(true);
  });

  it('fails with MANUAL_TIMEOUT when nobody answers in time', async () => {
    const flow = flowOf([
      { id: 'pause', type: 'manual', reason: 'otp', message: 'code?', timeoutMs: 30_000 },
    ]);

    // The built-in manual handler owns the timeout; emulate it directly.
    const manual = {
      request: async () => ({ status: 'timeout' as const }),
    };

    const result = await new Orchestrator({
      page: new FakePage(),
      runDir: runDir('manual-timeout'),
      logger: silentLogger,
      manual,
    }).run(flow);

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('MANUAL_TIMEOUT');
  });

  it('fails fast with a clear message when no manual handler is configured', async () => {
    const result = await new Orchestrator({
      page: new FakePage(),
      runDir: runDir('manual-unsupported'),
      logger: silentLogger,
      manual: new UnsupportedManualHandler(),
    }).run(
      flowOf([
        { id: 'pause', type: 'manual', reason: 'other', message: 'nobody home', timeoutMs: 1_000 },
      ]),
    );

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('none was configured');
  });

  it('captures a failure screenshot when onError.screenshot is enabled', async () => {
    const page = new FakePage();
    const registry = createDefaultRegistry();
    registry.override({
      type: 'click',
      validate: () => [],
      execute: async () => {
        throw new SelectorNotFoundError({ css: '#nope' });
      },
    });

    const result = await new Orchestrator({
      page,
      registry,
      runDir: runDir('failshot'),
      logger: silentLogger,
      manual: new AutoResolveManualHandler(),
    }).run(
      flowOf([{ id: 'click', type: 'click', selector: { css: '#nope' } }], { screenshot: true }),
    );

    expect(result.status).toBe('failed');
    expect(page.screenshotCalls).toBe(1);
    expect(result.artifacts.some((path) => path.includes('failure.png'))).toBe(true);
  });
});
