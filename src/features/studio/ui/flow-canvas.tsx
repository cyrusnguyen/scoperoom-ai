"use client";

import { useMemo, useState } from "react";
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow,
  type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import type { Direction } from "@/features/drafts/contracts/draft-layout";
import { MAX_MOVE_NODES } from "@/features/drafts/contracts/positions";
import type { NodeKind } from "@/features/drafts/contracts/scope-document";
import { bufferKey, editFields, refuse, send, type Saved } from "./buffers";
import { KIND_LABELS, reconnectCommand } from "./fields";
import { useStudio } from "./studio-context";
import { moveTargets, selectEdge, selectNodes, type SelectChange, type StudioUi } from "./studio-ui";

type StepData = { label: string; kind: NodeKind; actor: string; direction: Direction; connectable: boolean };
type StepNode = Node<StepData, "step">;
type FlowEdge = Edge<{ condition: string }, "flow">;
type Point = { x: number; y: number };

/** Fixed application-owned shapes (UI02); names are plain text, clamped here and complete in the inspector. */
function StepCard({ data }: NodeProps<StepNode>) {
  const across = data.direction === "LR";
  return <div className="step-node" data-kind={data.kind}>
    <Handle type="target" position={across ? Position.Left : Position.Top} isConnectable={data.connectable} />
    <span className="step-kind">{KIND_LABELS[data.kind]}</span>
    <span className="step-label">{data.label}</span>
    {data.actor && <span className="step-actor">{data.actor}</span>}
    <Handle type="source" position={across ? Position.Right : Position.Bottom} isConnectable={data.connectable} />
  </div>;
}

function FlowEdgeLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 28 });
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} />
    {data?.condition && <EdgeLabelRenderer>
      <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{data.condition}</div>
    </EdgeLabelRenderer>}
  </>;
}

const nodeTypes = { step: StepCard };
const edgeTypes = { flow: FlowEdgeLine };

/**
 * Controlled React Flow view of one flow's saved document and layout. Selection, pan, zoom and measurement stay local
 * and never become edits; connecting and reconnecting call the same commands as the Connect form and the inspector.
 * A drag shows locally and saves once, on drop, as one MOVE_NODES for every moved step. Keyboard arrow moves are
 * ignored: the inspector's position form is the keyboard path. `preview` renders proposed positions read-only.
 */
export default function FlowCanvas({ flowId, preview }: { flowId: string; preview?: { positions: Record<string, Point>; direction: Direction } }) {
  const { draft, editable, busy, ui, update, run, inspect, attempt, moveSteps } = useStudio();
  const { document, layout } = draft;
  const [dragging, setDragging] = useState<Record<string, Point>>({});
  const [note, setNote] = useState("");
  const interactive = !preview;
  const connectable = interactive && editable && !busy && !ui.pending;
  // The person's own placement stays on screen while it saves, awaits a retry, or waits for their conflict choice.
  const shown = interactive && attempt?.flowId === flowId ? attempt : null;
  // One unresolved placement at a time: no step can be dragged again until it is saved, retried, reapplied or dropped.
  const draggable = interactive && editable && !busy && !attempt;

  const nodes = useMemo<StepNode[]>(() => {
    const selected = interactive && ui.selection?.kind === "NODES" ? ui.selection.ids : [];
    const attempted: Record<string, Point> = Object.fromEntries((shown?.command.items ?? []).map(({ nodeId, x, y }) => [nodeId, { x, y }]));
    const direction = preview?.direction ?? layout.directions[flowId] ?? "TB";
    return Object.values(document.nodes).filter((node) => node.flowId === flowId).map((node) => ({
      id: node.id, type: "step", position: preview?.positions[node.id] ?? dragging[node.id] ?? attempted[node.id] ?? { x: layout.positions[node.id]!.x, y: layout.positions[node.id]!.y },
      data: { label: node.label, kind: node.kind, actor: node.actorLabel, direction, connectable }, selected: selected.includes(node.id),
    }));
  }, [document, layout, flowId, ui.selection, connectable, preview, dragging, shown, interactive]);

  const edges = useMemo<FlowEdge[]>(() => Object.values(document.edges).filter((edge) => edge.flowId === flowId).map((edge) => ({
    id: edge.id, type: "flow", source: edge.fromId, target: edge.toId, data: { condition: edge.condition },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 }, selected: interactive && ui.selection?.kind === "EDGE" && ui.selection.id === edge.id,
  })), [document, flowId, ui.selection, interactive]);

  const picks = (changes: (NodeChange<StepNode> | EdgeChange<FlowEdge>)[]): SelectChange[] =>
    changes.flatMap((change) => (change.type === "select" ? [{ id: change.id, selected: change.selected }] : []));
  const onNodesChange = (changes: NodeChange<StepNode>[]) => {
    const selection = picks(changes);
    if (selection.length) update((current) => ({ selection: selectNodes(current.selection, selection) }));
    // Only pointer drags move steps on screen; keyboard nudges (dragging: false) never become saves.
    const moving = changes.flatMap((change) => (change.type === "position" && change.dragging && change.position ? [[change.id, change.position] as const] : []));
    if (moving.length) setDragging((current) => ({ ...current, ...Object.fromEntries(moving) }));
  };
  const drop = (_event: unknown, _node: unknown, moved: StepNode[]) => {
    const targets = moveTargets(moved, layout);
    setDragging({});
    if (targets.length > MAX_MOVE_NODES) { setNote(`Move up to ${MAX_MOVE_NODES} steps at a time.`); return; }
    setNote("");
    if (targets.length) void moveSteps(flowId, targets);
  };
  const onEdgesChange = (changes: EdgeChange<FlowEdge>[]) => {
    const selection = picks(changes);
    if (selection.length) update((current) => ({ selection: selectEdge(current.selection, selection) }));
  };
  const connect = ({ source, target }: Connection) => {
    if (source && target) void run({ commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, fromId: source, toId: target, condition: "" } });
  };
  const reconnect = async (edge: FlowEdge, { source, target }: Connection) => {
    if (!source || !target || !connectable) return;
    const savedEdge = document.edges[edge.id];
    if (!savedEdge) return;
    const key = bufferKey("EDGE", edge.id);
    const saved: Saved = { kind: "EDGE", id: edge.id, version: draft.documentRevision, fields: { fromId: savedEdge.fromId, toId: savedEdge.toId } };
    const choose = (current: StudioUi) => editFields(current.endpointBuffers, saved, { fromId: source, toId: target });
    const chosen = choose(ui)[key];
    if (!chosen) return;
    const requestKey = crypto.randomUUID();
    update((current) => ({ endpointBuffers: chosen.conflict ? choose(current) : send(choose(current), key, requestKey), selection: { kind: "EDGE", id: edge.id } }));
    // A second gesture can revise retained choices, but only the inspector can explicitly resolve a stale conflict.
    if (chosen.conflict) { inspect(); return; }
    const outcome = await run(reconnectCommand(edge.id, chosen.baseVersion, chosen.values), requestKey);
    if (!outcome.ok) {
      if (!outcome.uncertain) update((current) => ({ endpointBuffers: refuse(current.endpointBuffers, key, outcome.code === "STALE_DOCUMENT_REVISION") }));
      inspect();
    }
  };

  return <div className="canvas">
    <ReactFlow<StepNode, FlowEdge> key={preview ? `preview-${preview.direction}` : flowId} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={interactive ? onNodesChange : undefined} onEdgesChange={interactive ? onEdgesChange : undefined}
      onNodeDoubleClick={interactive ? inspect : undefined} onNodeDragStop={interactive ? drop : undefined}
      onConnect={connect} onReconnect={reconnect} elementsSelectable={interactive}
      nodesDraggable={draggable} nodesConnectable={connectable} edgesReconnectable={connectable} deleteKeyCode={null}
      fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.1} maxZoom={4}
      aria-label={preview ? "Arrangement preview" : `${editable ? "Editable" : "Read-only"} flow canvas: ${document.flows[flowId]?.title ?? ""}`}>
      <Background gap={24} size={1} />
      {interactive && <Controls showInteractive={false} />}
    </ReactFlow>
    {!nodes.length && <div className="canvas-empty"><p>This flow has no steps yet.</p></div>}
    {note && <p className="canvas-note" role="alert">{note}</p>}
  </div>;
}
