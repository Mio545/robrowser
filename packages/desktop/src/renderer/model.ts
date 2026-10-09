/**
 * Renderer-side helpers: FlowModel <-> React Flow node conversion plus the
 * per-step-type defaults used by the visual editor.
 *
 * The graph is intentionally *linear*: nodes are a sequence and edges are the
 * ordering. `branch` / `loop` are edited as nested step lists inside their own
 * config panel, which keeps the top-level canvas readable.
 */
import type { Edge, Node } from 'reactflow';
import type { FlowModel, Step, StepType } from '@robrowser/core';

/** Every step type the editor can create, in palette order. */
export const STEP_TYPES: StepType[] = [
  'goto',
  'click',
  'type',
  'select',
  'hover',
  'scroll',
  'waitForPage',
  'waitForSelector',
  'waitForUrl',
  'waitForNetworkIdle',
  'waitForDownload',
  'extract',
  'screenshot',
  'branch',
  'loop',
  'setVar',
  'httpCall',
  'manual',
];

const STEP_LABELS: Record<StepType, string> = {
  goto: '打开网址',
  click: '点击',
  type: '输入文本',
  select: '选择下拉',
  hover: '悬停',
  scroll: '滚动',
  waitForPage: '等待页面',
  waitForSelector: '等待元素',
  waitForUrl: '等待 URL',
  waitForNetworkIdle: '等待网络空闲',
  waitForDownload: '等待下载',
  extract: '提取数据',
  screenshot: '截图',
  branch: '条件分支',
  loop: '循环',
  setVar: '设置变量',
  httpCall: 'HTTP 请求',
  manual: '人工接管',
};

/** Human label for a step type (UI). */
export function stepLabel(type: StepType): string {
  return STEP_LABELS[type] ?? type;
}

let idCounter = 0;
/** Unique-enough step id (flows are small; a counter + timestamp is enough). */
export function nextStepId(type: StepType): string {
  idCounter += 1;
  return `${type}-${Date.now().toString(36).slice(-4)}-${idCounter}`;
}

/** Default configuration for a freshly added step. */
export function defaultStep(type: StepType): Step {
  const id = nextStepId(type);
  switch (type) {
    case 'goto':
      return { id, type: 'goto', url: 'about:blank', waitUntil: 'load' };
    case 'click':
      return { id, type: 'click', selector: { css: 'button' } };
    case 'type':
      return { id, type: 'type', selector: { css: 'input' }, value: '', clear: true };
    case 'select':
      return { id, type: 'select', selector: { css: 'select' }, value: '' };
    case 'hover':
      return { id, type: 'hover', selector: { css: 'a' } };
    case 'scroll':
      return { id, type: 'scroll', y: 400 };
    case 'waitForPage':
      return { id, type: 'waitForPage', target: 'login', timeout: 30000 };
    case 'waitForSelector':
      return {
        id,
        type: 'waitForSelector',
        selector: { css: 'body' },
        state: 'visible',
        timeout: 15000,
      };
    case 'waitForUrl':
      return { id, type: 'waitForUrl', pattern: '**/*', timeout: 15000 };
    case 'waitForNetworkIdle':
      return { id, type: 'waitForNetworkIdle', idleMs: 500, timeout: 30000 };
    case 'waitForDownload':
      return { id, type: 'waitForDownload', timeout: 60000 };
    case 'extract':
      return {
        id,
        type: 'extract',
        selector: { css: 'body' },
        attr: 'textContent',
        into: 'result',
      };
    case 'screenshot':
      return { id, type: 'screenshot', saveTo: `${id}.png`, fullPage: true };
    case 'branch':
      return {
        id,
        type: 'branch',
        condition: { selectorExists: { css: 'body' } },
        then: [],
        else: [],
      };
    case 'loop':
      return { id, type: 'loop', items: [], as: 'item', steps: [], maxIterations: 100 };
    case 'setVar':
      return { id, type: 'setVar', name: 'value', value: '' };
    case 'httpCall':
      return {
        id,
        type: 'httpCall',
        method: 'GET',
        url: 'http://127.0.0.1:8080/healthz',
        into: 'response',
      };
    case 'manual':
      return {
        id,
        type: 'manual',
        reason: 'captcha',
        message: '请完成验证后继续',
        timeoutMs: 600000,
      };
    default:
      return { id, type: 'click', selector: { css: 'body' } };
  }
}

/** Short one-line summary shown on a canvas node. */
export function stepSummary(step: Step): string {
  switch (step.type) {
    case 'goto':
      return step.url;
    case 'click':
    case 'hover':
      return JSON.stringify(step.selector);
    case 'type':
      return `${JSON.stringify(step.selector)} ← ${step.value.slice(0, 24)}`;
    case 'select':
      return `${JSON.stringify(step.selector)} = ${step.value}`;
    case 'scroll':
      return step.selector ? JSON.stringify(step.selector) : `(${step.x ?? 0}, ${step.y ?? 0})`;
    case 'waitForPage':
      return `page: ${step.target}`;
    case 'waitForSelector':
      return JSON.stringify(step.selector);
    case 'waitForUrl':
      return step.pattern;
    case 'waitForNetworkIdle':
      return `idle ${step.idleMs ?? 500}ms`;
    case 'waitForDownload':
      return `timeout ${step.timeout ?? 60000}ms`;
    case 'extract':
      return `${JSON.stringify(step.selector)} → ${step.into}`;
    case 'screenshot':
      return step.saveTo ?? step.id + '.png';
    case 'branch':
      return 'if … then / else';
    case 'loop':
      return `for ${step.as} in ${typeof step.items === 'string' ? step.items : `${step.items.length} 项`}`;
    case 'setVar':
      return `${step.name} = ${JSON.stringify(step.value).slice(0, 24)}`;
    case 'httpCall':
      return `${step.method.toUpperCase()} ${step.url}`;
    case 'manual':
      return `${step.reason}: ${step.message.slice(0, 32)}`;
    default:
      return '';
  }
}

/** A brand-new, runnable starter flow. */
export function blankFlow(): FlowModel {
  return {
    version: '1.0',
    id: `flow-${Date.now().toString(36)}`,
    name: '未命名流程',
    variables: {},
    steps: [defaultStep('goto')],
    onError: { retry: 0, backoff: 'none' },
  };
}

/** Convert the top-level step list into React Flow nodes/edges. */
export function toGraph(steps: readonly Step[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = steps.map((step, index) => ({
    id: step.id,
    type: 'default',
    position: { x: 60, y: 40 + index * 110 },
    data: { label: `${index + 1}. ${stepLabel(step.type)}\n${stepSummary(step)}` },
    className: `rb-node rb-node-${step.type}`,
  }));
  const edges: Edge[] = steps.slice(1).map((step, index) => ({
    id: `e-${steps[index]!.id}-${step.id}`,
    source: steps[index]!.id,
    target: step.id,
    type: 'smoothstep',
    animated: false,
  }));
  return { nodes, edges };
}

/** Convert React Flow nodes back into an ordered step list. */
export function fromGraph(nodes: readonly Node[], steps: readonly Step[]): Step[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ordered: Step[] = [];
  for (const node of nodes) {
    const step = byId.get(node.id);
    if (step) ordered.push(step);
  }
  // Steps missing from the graph (should not happen) keep their relative order.
  for (const step of steps) if (!ordered.includes(step)) ordered.push(step);
  return ordered;
}
