import React from 'react';
import type { FlowModel, VariableDef } from '@robrowser/core';

/** Props for {@link VariablePanel}. */
export interface VariablePanelProps {
  flow: FlowModel;
  onChange(flow: FlowModel): void;
}

const KINDS: VariableDef['type'][] = ['const', 'env', 'secret', 'input'];

/**
 * Variables editor (spec 9): const / env / secret / input declarations.
 *
 * `env` and `secret` expose the environment key; `input` exposes a label and an
 * optional default. The panel writes straight back into `flow.variables`, which
 * is exactly the map the engine's VariableStore consumes.
 */
export function VariablePanel({ flow, onChange }: VariablePanelProps): React.ReactElement {
  const variables = flow.variables ?? {};

  const update = (next: Record<string, VariableDef>): void => {
    onChange({ ...flow, variables: next });
  };

  const rename = (from: string, to: string): void => {
    if (from === to || to.length === 0) return;
    const next: Record<string, VariableDef> = {};
    for (const [name, def] of Object.entries(variables)) next[name === from ? to : name] = def;
    update(next);
  };

  const add = (): void => {
    let name = 'variable';
    let index = 1;
    while (variables[name]) {
      index += 1;
      name = `variable${index}`;
    }
    update({ ...variables, [name]: { type: 'const', value: '' } });
  };

  const setKind = (name: string, kind: VariableDef['type']): void => {
    const def: VariableDef =
      kind === 'const'
        ? { type: 'const', value: '' }
        : kind === 'env'
          ? { type: 'env', key: name.toUpperCase() }
          : kind === 'secret'
            ? { type: 'secret', key: name.toUpperCase() }
            : { type: 'input', label: name };
    update({ ...variables, [name]: def });
  };

  return (
    <aside className="rb-panel">
      <div className="rb-panel-head">
        <h2>变量</h2>
        <button onClick={add}>+ 添加</button>
      </div>
      {Object.entries(variables).length === 0 && (
        <p className="rb-muted">还没有变量。步骤中可用 {'{{名字}}'} 插值。</p>
      )}
      {Object.entries(variables).map(([name, def]) => (
        <div key={name} className="rb-var">
          <div className="rb-row">
            <input value={name} onChange={(event) => rename(name, event.target.value)} />
            <select
              value={def.type}
              onChange={(event) => setKind(name, event.target.value as VariableDef['type'])}
            >
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <button
              className="rb-danger"
              onClick={() => {
                const next = { ...variables };
                delete next[name];
                update(next);
              }}
            >
              ×
            </button>
          </div>

          {def.type === 'const' && (
            <input
              placeholder="值（JSON 或文本）"
              value={typeof def.value === 'string' ? def.value : JSON.stringify(def.value)}
              onChange={(event) => {
                const raw = event.target.value;
                let value: unknown = raw;
                try {
                  value = JSON.parse(raw);
                } catch {
                  value = raw;
                }
                update({ ...variables, [name]: { type: 'const', value } });
              }}
            />
          )}
          {def.type === 'env' && (
            <div className="rb-row">
              <input
                placeholder="环境变量名"
                value={def.key}
                onChange={(event) =>
                  update({ ...variables, [name]: { type: 'env', key: event.target.value } })
                }
              />
              <input
                placeholder="默认值"
                value={def.default ?? ''}
                onChange={(event) =>
                  update({
                    ...variables,
                    [name]: { type: 'env', key: def.key, default: event.target.value },
                  })
                }
              />
            </div>
          )}
          {def.type === 'secret' && (
            <div className="rb-row">
              <input
                placeholder="环境变量名（不回显值）"
                value={def.key}
                onChange={(event) =>
                  update({ ...variables, [name]: { type: 'secret', key: event.target.value } })
                }
              />
            </div>
          )}
          {def.type === 'input' && (
            <div className="rb-row">
              <input
                placeholder="显示标签"
                value={def.label}
                onChange={(event) =>
                  update({ ...variables, [name]: { type: 'input', label: event.target.value } })
                }
              />
              <input
                placeholder="默认值"
                value={def.default ?? ''}
                onChange={(event) =>
                  update({
                    ...variables,
                    [name]: { type: 'input', label: def.label, default: event.target.value },
                  })
                }
              />
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
