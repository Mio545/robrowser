/**
 * Exporter snapshot tests (spec 5.5 / 11: stable generated scripts).
 *
 * Snapshots are inline so a reviewer sees the whole generated contract in the
 * test file; `exportPlaywright` / `exportRawCdp` must stay byte-stable.
 */
import { describe, expect, it } from 'vitest';
import { exportFlow, exportPlaywright, exportRawCdp } from './index.js';
import type { FlowModel } from '../flow/schema.js';

/** A representative flow exercising every exporter branch. */
export function exporterSampleFlow(): FlowModel {
  return {
    version: '1.0',
    id: 'export-sample',
    name: 'Export sample',
    variables: {
      base: { type: 'const', value: 'file:///fixtures/login.html' },
      user: { type: 'input', label: 'User', default: 'alice' },
      token: { type: 'secret', key: 'DEMO_TOKEN', default: 's3cret' },
    },
    steps: [
      { id: 'go', type: 'goto', url: '{{base}}', waitUntil: 'load' },
      {
        id: 'fill-user',
        type: 'type',
        selector: { css: '#username' },
        value: '{{user}}',
        clear: true,
      },
      { id: 'fill-pass', type: 'type', selector: { testId: 'password' }, value: '{{token}}' },
      {
        id: 'submit',
        type: 'click',
        selector: { candidates: [{ role: 'button', name: 'Sign in' }, { testId: 'submit' }] },
      },
      {
        id: 'branch',
        type: 'branch',
        condition: { selectorExists: { testId: 'welcome' } },
        then: [
          {
            id: 'orders',
            type: 'extract',
            selector: { css: '#orders' },
            attr: 'textContent',
            into: 'orders',
          },
        ],
        else: [{ id: 'err', type: 'setVar', name: 'loginError', value: 'failed' }],
      },
      { id: 'shot', type: 'screenshot', saveTo: 'final.png', fullPage: true },
      { id: 'wait', type: 'waitForNetworkIdle', idleMs: 500, timeout: 5_000 },
      { id: 'manual', type: 'manual', reason: 'captcha', message: 'solve', timeoutMs: 60_000 },
    ],
  };
}

describe('exportFlow dispatch', () => {
  it('dispatches to both targets', () => {
    const flow = exporterSampleFlow();
    expect(exportFlow(flow, 'playwright')).toBe(exportPlaywright(flow));
    expect(exportFlow(flow, 'raw-cdp')).toBe(exportRawCdp(flow));
  });
});

describe('exportPlaywright', () => {
  it('matches the committed snapshot', () => {
    expect(exportPlaywright(exporterSampleFlow())).toMatchSnapshot();
  });

  it('maps env / secret / input variables and interpolates them', () => {
    const script = exportPlaywright(exporterSampleFlow());
    expect(script).toContain('process.env["DEMO_TOKEN"]');
    expect(script).toContain('process.env["ROBO_USER"]');
    expect(script).toContain('file:///fixtures/login.html');
  });

  it('throws a descriptive error for manual steps by default', () => {
    const script = exportPlaywright(exporterSampleFlow());
    expect(script).toMatch(/manual|pause/);
  });

  it('is deterministic across invocations', () => {
    expect(exportPlaywright(exporterSampleFlow())).toBe(exportPlaywright(exporterSampleFlow()));
  });

  /**
   * Regression: relative `goto` URLs used to be emitted verbatim, so an exported
   * script failed with "Cannot navigate to invalid URL" for flows written as
   * `{{fixtures}}login.html`. The engine resolves those against the flow file's
   * directory, and the exported script must do the same.
   */
  it('resolves flow-relative URLs like the engine and bakes the flow directory', () => {
    const flow: FlowModel = {
      version: '1.0',
      id: 'relurl',
      name: 'Relative URL',
      variables: { fixtures: { type: 'const', value: '../fixtures/' } },
      steps: [{ id: 'go', type: 'goto', url: '{{fixtures}}login.html' }],
    };
    const script = exportPlaywright(flow, { flowDir: '/repo/flows' });

    expect(script).toContain('function resolveFlowUrl(url)');
    expect(script).toContain('page.goto(resolveFlowUrl(');
    // The flow directory is baked in; ROBO_FLOW_DIR can still override it.
    expect(script).toContain('"/repo/flows"');
    expect(script).toContain('process.env.ROBO_FLOW_DIR || "/repo/flows"');
  });

  /** Regression: exported scripts must honour CHROME_PATH like the runtime does. */
  it('launches the CHROME_PATH binary when set', () => {
    const script = exportPlaywright(exporterSampleFlow());
    expect(script).toContain('process.env.CHROME_PATH');
    expect(script).toContain('executablePath');
  });
});

describe('exportRawCdp', () => {
  it('matches the committed snapshot', () => {
    expect(exportRawCdp(exporterSampleFlow())).toMatchSnapshot();
  });

  it('is deterministic across invocations', () => {
    expect(exportRawCdp(exporterSampleFlow())).toBe(exportRawCdp(exporterSampleFlow()));
  });

  it('resolves flow-relative URLs with the baked flow directory', () => {
    const flow: FlowModel = {
      version: '1.0',
      id: 'relurl-raw',
      name: 'Relative URL raw',
      variables: { fixtures: { type: 'const', value: '../fixtures/' } },
      steps: [{ id: 'go', type: 'goto', url: '{{fixtures}}login.html' }],
    };
    const script = exportRawCdp(flow, { flowDir: '/repo/flows' });

    expect(script).toContain('function resolveFlowUrl(url)');
    expect(script).toContain('resolveFlowUrl(');
    expect(script).toContain('"/repo/flows"');
  });
});
