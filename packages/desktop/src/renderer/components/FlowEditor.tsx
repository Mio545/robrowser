import React, { useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  addEdge,
  type Connection,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import type { FlowModel, Step, StepType } from '@robrowser/core';
import { STEP_TYPES, defaultStep, fromGraph, stepLabel, toGraph } from '../model';

/** Props for {@link FlowEditor}. */
export interface FlowEditorProps {
  flow: FlowModel;
  onChange(flow: FlowModel): void;
  selectedStepId: string | null;
  onSelect(stepId: string | null): void;
}

/**
 * React Flow canvas: nodes are Steps, edges encode execution order.
 *
 * The graph is deliberately linear (spec 9: "连线为顺序"). Connecting two nodes
 * reorders the underlying `steps` array so the JSON and the canvas cannot drift.
 */
export function FlowEditor({
  flow,
  onChange,
  selectedStepId,
  onSelect,
}: FlowEditorProps): React.ReactElement {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { nodes, edges } = useMemo(() => toGraph(flow.steps), [flow.steps]);

  const commit = (steps: Step[]): void => onChange({ ...flow, steps });

  const onConnect = (connection: Connection): void => {
    void addEdge(connection, edges);
    if (!connection.source || !connection.target) return;
    const sourceIndex = flow.steps.findIndex((step) => step.id === connection.source);
    const targetIndex = flow.steps.findIndex((step) => step.id === connection.target);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const next = [...flow.steps];
    const [moved] = next.splice(targetIndex, 1);
    if (!moved) return;
    next.splice(sourceIndex, 0, moved);
    commit(next);
  };

  const onNodesChange = (
    changes: Parameters<NonNullable<React.ComponentProps<typeof ReactFlow>['onNodesChange']>>[0],
  ): void => {
    // Position-only changes keep the JSON untouched; selection syncs the panel.
    for (const change of changes) {
      if (change.type === 'select') onSelect(change.selected ? change.id : null);
    }
  };

  const addStep = (type: StepType): void => {
    const step = defaultStep(type);
    commit([...flow.steps, step]);
    onSelect(step.id);
    setPaletteOpen(false);
  };

  const removeSelected = (): void => {
    if (!selectedStepId) return;
    commit(flow.steps.filter((step) => step.id !== selectedStepId));
    onSelect(null);
  };

  const moveSelected = (delta: number): void => {
    const index = flow.steps.findIndex((step) => step.id === selectedStepId);
    if (index < 0) return;
    const target = index + delta;
    if (target < 0 || target >= flow.steps.length) return;
    const next = [...flow.steps];
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    commit(next);
  };

  return (
    <div className="rb-editor">
      <div className="rb-editor-toolbar">
        <strong>{flow.name}</strong>
        <span className="rb-muted">{flow.steps.length} 个步骤</span>
        <span className="rb-grow" />
        <button onClick={() => moveSelected(-1)} disabled={!selectedStepId} title="上移">
          ↑
        </button>
        <button onClick={() => moveSelected(1)} disabled={!selectedStepId} title="下移">
          ↓
        </button>
        <button
          onClick={removeSelected}
          disabled={!selectedStepId}
          className="rb-danger"
          title="删除"
        >
          删除
        </button>
        <button className="rb-primary" onClick={() => setPaletteOpen((open) => !open)}>
          + 添加步骤
        </button>
      </div>

      {paletteOpen && (
        <div className="rb-palette">
          {STEP_TYPES.map((type) => (
            <button key={type} onClick={() => addStep(type)}>
              {stepLabel(type)}
            </button>
          ))}
        </div>
      )}

      <div className="rb-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onConnect={onConnect}
          onNodesChange={onNodesChange}
          onNodeClick={(_event, node) => onSelect(node.id)}
          onPaneClick={() => onSelect(null)}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#1e293b" gap={18} />
          <MiniMap pannable zoomable nodeColor="#2563eb" maskColor="rgb(11 18 32 / 70%)" />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}

/** Keep the `Edge`/`Node` types referenced for downstream consumers. */
export type { Edge, Node };
