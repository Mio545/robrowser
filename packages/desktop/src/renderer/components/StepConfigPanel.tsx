import React from 'react';
import type { FlowModel, SelectorSpec, Step } from '@robrowser/core';
import { stepLabel } from '../model';

/** Props for {@link StepConfigPanel}. */
export interface StepConfigPanelProps {
  flow: FlowModel;
  step: Step | null;
  onChange(flow: FlowModel): void;
}

/** Render a SelectorSpec compactly (and parse the compact form back). */
function selectorToText(selector: SelectorSpec): string {
  if (typeof selector === 'string') return selector;
  if ('candidates' in selector) return selector.candidates.map(selectorToText).join(' | ');
  if ('testId' in selector) return `testid=${selector.testId}`;
  if ('role' in selector)
    return selector.name ? `role=${selector.role}[name=${selector.name}]` : `role=${selector.role}`;
  if ('text' in selector) return `text=${selector.text}`;
  if ('css' in selector) return `css=${selector.css}`;
  if ('xpath' in selector) return `xpath=${selector.xpath}`;
  return '';
}

/** Parse the compact selector text back into a SelectorSpec. */
function textToSelector(value: string): SelectorSpec {
  const trimmed = value.trim();
  if (trimmed.includes('|')) {
    return { candidates: trimmed.split('|').map((part) => textToSelector(part)) };
  }
  if (trimmed.startsWith('testid=')) return { testId: trimmed.slice('testid='.length) };
  if (trimmed.startsWith('css=')) return { css: trimmed.slice(4) };
  if (trimmed.startsWith('xpath=')) return { xpath: trimmed.slice(6) };
  if (trimmed.startsWith('text=')) return { text: trimmed.slice(5) };
  if (trimmed.startsWith('role=')) {
    const body = trimmed.slice(5);
    const match = /^([^\[]+)(?:\[name=(.*)\])?$/.exec(body);
    if (match && match[2]) return { role: match[1]!.trim(), name: match[2] };
    return { role: body.trim() };
  }
  return { css: trimmed };
}

/**
 * Type-driven configuration form (spec 9).
 *
 * Hand-written rather than generated from the zod schema: the schema knows about
 * validity, but a good editor also needs labels, ordering and widgets. Keeping
 * this explicit also means the panel renders the exact Step union members, so a
 * new step type is a compile error here until it is handled.
 */
export function StepConfigPanel({
  flow,
  step,
  onChange,
}: StepConfigPanelProps): React.ReactElement {
  if (!step) {
    return (
      <aside className="rb-panel">
        <h2>步骤配置</h2>
        <p className="rb-muted">在左侧画布上选择一个步骤，或点击“添加步骤”。</p>
      </aside>
    );
  }

  const patch = (partial: Partial<Step>): void => {
    const next = flow.steps.map((candidate) =>
      candidate.id === step.id ? ({ ...candidate, ...partial } as Step) : candidate,
    );
    onChange({ ...flow, steps: next });
  };

  const field = (label: string, node: React.ReactNode): React.ReactElement => (
    <label className="rb-field">
      <span>{label}</span>
      {node}
    </label>
  );

  const textInput = (
    label: string,
    value: string,
    onValue: (value: string) => void,
  ): React.ReactElement =>
    field(
      label,
      <input value={value} onChange={(event) => onValue(event.target.value)} spellCheck={false} />,
    );

  const numberInput = (
    label: string,
    value: number | undefined,
    onValue: (value: number | undefined) => void,
  ): React.ReactElement =>
    field(
      label,
      <input
        type="number"
        value={value ?? ''}
        onChange={(event) =>
          onValue(event.target.value === '' ? undefined : Number(event.target.value))
        }
      />,
    );

  const selectorField = (
    label: string,
    selector: SelectorSpec,
    onValue: (selector: SelectorSpec) => void,
  ): React.ReactElement =>
    textInput(label, selectorToText(selector), (value) => onValue(textToSelector(value)));

  let body: React.ReactNode = null;
  switch (step.type) {
    case 'goto':
      body = (
        <>
          {textInput('URL', step.url, (url) => patch({ url }))}
          {field(
            '等待条件',
            <select
              value={step.waitUntil ?? 'load'}
              onChange={(event) => patch({ waitUntil: event.target.value as 'load' })}
            >
              <option value="load">load</option>
              <option value="domcontentloaded">domcontentloaded</option>
              <option value="networkidle">networkidle</option>
            </select>,
          )}
        </>
      );
      break;
    case 'click':
      body = (
        <>
          {selectorField('选择器', step.selector, (selector) => patch({ selector }))}
          {field(
            '鼠标键',
            <select
              value={step.button ?? 'left'}
              onChange={(event) => patch({ button: event.target.value as 'left' })}
            >
              <option value="left">左键</option>
              <option value="right">右键</option>
              <option value="middle">中键</option>
            </select>,
          )}
          {numberInput('连击次数', step.clickCount, (clickCount) =>
            patch({ clickCount: clickCount ?? 1 }),
          )}
        </>
      );
      break;
    case 'type':
      body = (
        <>
          {selectorField('选择器', step.selector, (selector) => patch({ selector }))}
          {textInput('文本（支持 {{变量}}）', step.value, (value) => patch({ value }))}
          {numberInput('逐字延迟 (ms)', step.delayMs, (delayMs) => patch({ delayMs }))}
        </>
      );
      break;
    case 'select':
      body = (
        <>
          {selectorField('选择器', step.selector, (selector) => patch({ selector }))}
          {textInput('值', step.value, (value) => patch({ value }))}
        </>
      );
      break;
    case 'hover':
      body = selectorField('选择器', step.selector, (selector) => patch({ selector }));
      break;
    case 'scroll':
      body = (
        <>
          {numberInput('X', step.x, (x) => patch({ x }))}
          {numberInput('Y', step.y, (y) => patch({ y }))}
          {step.selector
            ? selectorField('元素选择器', step.selector, (selector) => patch({ selector }))
            : null}
        </>
      );
      break;
    case 'waitForPage':
      body = (
        <>
          {textInput('页面名称', step.target, (target) => patch({ target }))}
          {numberInput('超时 (ms)', step.timeout, (timeout) => patch({ timeout }))}
        </>
      );
      break;
    case 'waitForSelector':
      body = (
        <>
          {selectorField('选择器', step.selector, (selector) => patch({ selector }))}
          {field(
            '状态',
            <select
              value={step.state ?? 'visible'}
              onChange={(event) => patch({ state: event.target.value as 'visible' })}
            >
              <option value="attached">attached</option>
              <option value="visible">visible</option>
              <option value="hidden">hidden</option>
            </select>,
          )}
          {numberInput('超时 (ms)', step.timeout, (timeout) => patch({ timeout }))}
        </>
      );
      break;
    case 'waitForUrl':
      body = (
        <>
          {textInput('URL 匹配模式', step.pattern, (pattern) => patch({ pattern }))}
          {numberInput('超时 (ms)', step.timeout, (timeout) => patch({ timeout }))}
        </>
      );
      break;
    case 'waitForNetworkIdle':
      body = (
        <>
          {numberInput('空闲时长 (ms)', step.idleMs, (idleMs) => patch({ idleMs }))}
          {numberInput('超时 (ms)', step.timeout, (timeout) => patch({ timeout }))}
        </>
      );
      break;
    case 'waitForDownload':
      body = (
        <>
          {numberInput('超时 (ms)', step.timeout, (timeout) => patch({ timeout }))}
          {textInput('保存到', step.saveTo ?? '', (saveTo) => patch({ saveTo }))}
        </>
      );
      break;
    case 'extract':
      body = (
        <>
          {selectorField('选择器', step.selector, (selector) => patch({ selector }))}
          {textInput('属性（留空取文本）', step.attr ?? '', (attr) => patch({ attr }))}
          {textInput('写入变量', step.into, (into) => patch({ into }))}
          {field(
            '全部匹配',
            <input
              type="checkbox"
              checked={step.all ?? false}
              onChange={(event) => patch({ all: event.target.checked })}
            />,
          )}
        </>
      );
      break;
    case 'screenshot':
      body = (
        <>
          {textInput('保存为', step.saveTo ?? '', (saveTo) => patch({ saveTo }))}
          {field(
            '整页截图',
            <input
              type="checkbox"
              checked={step.fullPage ?? false}
              onChange={(event) => patch({ fullPage: event.target.checked })}
            />,
          )}
        </>
      );
      break;
    case 'branch':
      body = (
        <>
          <p className="rb-muted">
            分支的 then / else 步骤在 JSON 中嵌套；`条件` 支持 pageIs / varEquals / selectorExists /
            not / all / any。
          </p>
          <textarea
            rows={6}
            value={JSON.stringify(step.condition, null, 2)}
            onChange={(event) => {
              try {
                patch({ condition: JSON.parse(event.target.value) as never });
              } catch {
                /* keep editing until valid */
              }
            }}
          />
        </>
      );
      break;
    case 'loop':
      body = (
        <>
          {textInput('迭代变量名', step.as, (as) => patch({ as }))}
          <p className="rb-muted">
            集合：{typeof step.items === 'string' ? step.items : `${step.items.length} 项`}；循环体{' '}
            {step.steps.length} 步
          </p>
          {numberInput('最大迭代次数', step.maxIterations, (maxIterations) =>
            patch({ maxIterations }),
          )}
        </>
      );
      break;
    case 'setVar':
      body = (
        <>
          {textInput('变量名', step.name, (name) => patch({ name }))}
          <textarea
            rows={3}
            value={
              typeof step.value === 'string' ? step.value : JSON.stringify(step.value, null, 2)
            }
            onChange={(event) => {
              const raw = event.target.value;
              try {
                patch({ value: JSON.parse(raw) as never });
              } catch {
                patch({ value: raw });
              }
            }}
          />
        </>
      );
      break;
    case 'httpCall':
      body = (
        <>
          {textInput('方法', step.method, (method) => patch({ method }))}
          {textInput('URL', step.url, (url) => patch({ url }))}
          {textInput('写入变量', step.into ?? '', (into) => patch({ into }))}
        </>
      );
      break;
    case 'manual':
      body = (
        <>
          {field(
            '原因',
            <select
              value={step.reason}
              onChange={(event) => patch({ reason: event.target.value as 'captcha' })}
            >
              <option value="captcha">验证码</option>
              <option value="sms">短信</option>
              <option value="otp">一次性密码</option>
              <option value="confirm">人工确认</option>
              <option value="other">其他</option>
            </select>,
          )}
          {textInput('提示信息', step.message, (message) => patch({ message }))}
          {numberInput('超时 (ms)', step.timeoutMs, (timeoutMs) => patch({ timeoutMs }))}
        </>
      );
      break;
    default: {
      const exhaustive: never = step;
      body = <p className="rb-muted">未支持的步骤类型：{JSON.stringify(exhaustive)}</p>;
    }
  }

  return (
    <aside className="rb-panel">
      <h2>步骤配置</h2>
      <p className="rb-muted">
        {stepLabel(step.type)} · <code>{step.id}</code>
      </p>
      {textInput('步骤 ID', step.id, (id) =>
        onChange({
          ...flow,
          steps: flow.steps.map((candidate) =>
            candidate.id === step.id ? ({ ...candidate, id } as Step) : candidate,
          ),
        }),
      )}
      {body}
    </aside>
  );
}
