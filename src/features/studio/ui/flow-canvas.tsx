"use client";

import { useCallback, useMemo, useRef, useState, type DragEvent } from "react";
import {
  Background, BaseEdge, ConnectionMode, Controls, EdgeLabelRenderer, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  useReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import { STEP_SIZE, type Direction } from "@/features/drafts/contracts/draft-layout";
import { MAX_MOVE_NODES } from "@/features/drafts/contracts/positions";
import type { NodeKind } from "@/features/drafts/contracts/scope-document";
import { bufferKey, editFields, refuse, send, type Saved } from "./buffers";
import { KIND_LABELS, reconnectCommand } from "./fields";
import ShapePanel from "./shape-panel";
import { useStudio } from "./studio-context";
import { dropTarget, moveTargets, parseShapePayload, selectEdge, selectNodes, SHAPE_DRAG_MIME, type SelectChange, type StudioUi } from "./studio-ui";

type StepData = { label: string; kind: NodeKind; actor: string; direction: Direction };
type StepNode = Node<StepData, "step">;
type FlowEdge = Edge<{ condition: string }, "flow">;
type Point = { x: number; y: number };

// Every step keeps all four sides connectable (UI02); which one is first of its type per direction decides the
// default, unsaved routing a plain (handle-less) connection draws, matching the earlier single-handle behaviour.
const HANDLE_ORDER: Record<Direction, { position: Position; type: "source" | "target" }[]> = {
  TB: [
    { position: Position.Top, type: "target" }, { position: Position.Bottom, type: "source" },
    { position: Position.Left, type: "target" }, { position: Position.Right, type: "source" },
  ],
  LR: [
    { position: Position.Left, type: "target" }, { position: Position.Right, type: "source" },
    { position: Position.Top, type: "target" }, { position: Position.Bottom, type: "source" },
  ],
};

/** The DECISION diamond and DATA_STORE cylinder: an SVG that stretches to the node's exact box (UI02). Shared by the
 * canvas node, the shape panel's icons and its drag ghost, so a shape is drawn in exactly one place. */
export function KindShape({ kind }: { kind: NodeKind }) {
  if (kind === "DECISION") return <svg className="step-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <polygon className="step-shape-fill" points="50,4 96,50 50,96 4,50" />
  </svg>;
  if (kind === "DATA_STORE") return <svg className="step-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <path className="step-shape-fill" d="M6,18 A44,14 0 0 1 94,18 L94,82 A44,14 0 0 1 6,82 Z" />
    <path className="step-shape-lid" d="M6,18 A44,14 0 0 0 94,18" />
  </svg>;
  return null;
}

/** Fixed application-owned shapes (UI02); names are plain text, clamped here and complete in the inspector. */
function StepCard({ data, isConnectable }: NodeProps<StepNode>) {
  return <div className="step-node" data-kind={data.kind}>
    <KindShape kind={data.kind} />
    {HANDLE_ORDER[data.direction].map(({ position, type }) => (
      <Handle key={position} id={position} type={type} position={position} isConnectable={isConnectable} />
    ))}
    <div className="step-body">
      <span className="step-kind">{KIND_LABELS[data.kind]}</span>
      <span className="step-label">{data.label}</span>
      {data.actor && <span className="step-actor">{data.actor}</span>}
    </div>
  </div>;
}

function FlowEdgeLine({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 28 });
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={20} />
    {data?.condition && <EdgeLabelRenderer>
      <div className="edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{data.condition}</div>
    </EdgeLabelRenderer>}
  </>;
}

const nodeTypes = { step: StepCard };
const edgeTypes = { flow: FlowEdgeLine };
const defaultEdgeOptions = { type: "flow" as const };

/**
 * Controlled React Flow view of one flow's saved document and layout. Selection, pan, zoom and measurement stay local
 * and never become edits; connecting and reconnecting call the same commands as the Connect form and the inspector.
 * A drag shows locally and saves once, on drop, as one MOVE_NODES for every moved step. Keyboard arrow moves are
 * ignored: the inspector's position form is the keyboard path. `preview` renders proposed positions read-only.
 * A `ReactFlowProvider` wraps this so the shape panel's click path and the canvas wrapper's drop handler can both
 * convert a screen point to a flow position (`screenToFlowPosition` needs an ancestor provider).
 */
export default function FlowCanvas(props: { flowId: string; preview?: { positions: Record<string, Point>; direction: Direction } }) {
  return <ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider>;
}

function CanvasInner({ flowId, preview }: { flowId: string; preview?: { positions: Record<string, Point>; direction: Direction } }) {
  const { draft, editable, busy, ui, update, run, place, inspect, attempt, moveSteps } = useStudio();
  const { document, layout } = draft;
  const { screenToFlowPosition } = useReactFlow();
  const [dragging, setDragging] = useState<Record<string, Point>>({});
  const [note, setNote] = useState("");
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const wrapperRef = useRef<HTMLDivElement>(null);
  const interactive = !preview;
  const connectable = interactive && editable && !busy && !ui.pending;
  // The person's own placement stays on screen while it saves, awaits a retry, or waits for their conflict choice.
  const shown = interactive && attempt?.flowId === flowId ? attempt : null;
  // One unresolved placement at a time: no step can be dragged again until it is saved, retried, reapplied or dropped.
  const draggable = interactive && editable && !busy && !attempt;
  // The shape panel shares this same "one unresolved placement at a time" gate: adding a step will move it once.
  const shapesEnabled = interactive && editable && !busy && !attempt;
  // A brand-new node is always saved at position version 1 (placeNew, domain/graph.ts): the move never has to read
  // any draft state to know its expected version, so it can run in the same sequential chain as the create, entirely
  // in terms of the flow id captured when the drop or click happened — never a `flowId` re-read after a later flow
  // switch (Task 7 fix round 1). `place` (not `moveSteps`) sends it directly and records no undoable "last move".
  const createShapeAt = useCallback(async (kind: NodeKind, point: Point) => {
    const capturedFlowId = flowId;
    const size = STEP_SIZE[kind];
    const target = dropTarget(point, size);
    const outcome = await run({
      commandSchemaVersion: 1, command: "ADD_NODE", expectedDocumentRevision: draft.documentRevision,
      payload: { flowId: capturedFlowId, kind, label: KIND_LABELS[kind], actorLabel: "", description: "" },
    });
    if (!outcome.ok) return;
    const nodeId = outcome.result.createdIds[0];
    if (!nodeId) return;
    // The node belongs to capturedFlowId regardless of which flow is now visible; downstream selection consumers
    // (Connect, Delete) already ignore a selected id from another flow.
    update(() => ({ selection: { kind: "NODES", ids: [nodeId] } }));
    await place({ mode: "MOVE_NODES", flowId: capturedFlowId, items: [{ nodeId, expectedPositionVersion: 1, ...target }] });
  }, [flowId, run, draft, update, place]);
  const activateShape = useCallback((kind: NodeKind) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const centre = rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    void createShapeAt(kind, screenToFlowPosition(centre));
  }, [createShapeAt, screenToFlowPosition]);
  const onShapeDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!shapesEnabled || !Array.from(event.dataTransfer.types).includes(SHAPE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onShapeDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!shapesEnabled) return;
    const payload = parseShapePayload(event.dataTransfer.getData(SHAPE_DRAG_MIME));
    if (!payload) return;
    event.preventDefault();
    void createShapeAt(payload.kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };

  const nodes = useMemo<StepNode[]>(() => {
    const selected = interactive && ui.selection?.kind === "NODES" ? ui.selection.ids : [];
    const attempted: Record<string, Point> = Object.fromEntries((shown?.command.items ?? []).map(({ nodeId, x, y }) => [nodeId, { x, y }]));
    const direction = preview?.direction ?? layout.directions[flowId] ?? "TB";
    return Object.values(document.nodes).filter((node) => node.flowId === flowId).map((node) => {
      const size = STEP_SIZE[node.kind];
      return {
        id: node.id, type: "step", width: size.width, height: size.height,
        position: preview?.positions[node.id] ?? dragging[node.id] ?? attempted[node.id] ?? { x: layout.positions[node.id]!.x, y: layout.positions[node.id]!.y },
        data: { label: node.label, kind: node.kind, actor: node.actorLabel, direction }, selected: selected.includes(node.id), measured: measured[node.id],
      };
    });
  }, [document, layout, flowId, ui.selection, preview, dragging, shown, interactive, measured]);

  const edges = useMemo<FlowEdge[]>(() => Object.values(document.edges).filter((edge) => edge.flowId === flowId).map((edge) => ({
    id: edge.id, type: "flow", source: edge.fromId, target: edge.toId, data: { condition: edge.condition },
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--foreground-subtle)" }, selected: interactive && ui.selection?.kind === "EDGE" && ui.selection.id === edge.id,
  })), [document, flowId, ui.selection, interactive]);

  const picks = (changes: (NodeChange<StepNode> | EdgeChange<FlowEdge>)[]): SelectChange[] =>
    changes.flatMap((change) => (change.type === "select" ? [{ id: change.id, selected: change.selected }] : []));
  const measure = (changes: NodeChange<StepNode>[]) => setMeasured((current) => {
    let next = current;
    for (const change of changes) {
      if (change.type !== "dimensions" || !change.dimensions) continue;
      const previous = current[change.id];
      if (previous?.width === change.dimensions.width && previous.height === change.dimensions.height) continue;
      if (next === current) next = { ...current };
      next[change.id] = change.dimensions;
    }
    return next;
  });
  const onNodesChange = (changes: NodeChange<StepNode>[]) => {
    measure(changes);
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
    if (!source || !target || !connectable) return;
    void run({ commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, fromId: source, toId: target, condition: "" } });
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

  return <div className="canvas" ref={wrapperRef} onDragOver={onShapeDragOver} onDrop={onShapeDrop}>
    <ReactFlow<StepNode, FlowEdge> key={preview ? `preview-${preview.direction}` : flowId} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      defaultEdgeOptions={defaultEdgeOptions} connectionMode={ConnectionMode.Loose}
      onNodesChange={interactive ? onNodesChange : measure} onEdgesChange={interactive ? onEdgesChange : undefined}
      onNodeDoubleClick={interactive ? inspect : undefined} onNodeDragStop={interactive ? drop : undefined}
      onConnect={connect} onReconnect={reconnect} elementsSelectable={interactive}
      nodesDraggable={draggable} nodesConnectable={connectable} edgesReconnectable={connectable} deleteKeyCode={null}
      fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.1} maxZoom={4}
      aria-label={preview ? "Arrangement preview" : `${editable ? "Editable" : "Read-only"} flow canvas: ${document.flows[flowId]?.title ?? ""}`}>
      <Background gap={24} size={1} />
      {interactive && <Controls showInteractive={false} />}
    </ReactFlow>
    {interactive && editable && <ShapePanel disabled={!shapesEnabled} onActivate={activateShape} />}
    {!nodes.length && <div className="canvas-empty"><p>This flow has no steps yet.</p></div>}
    {note && <p className="canvas-note" role="alert">{note}</p>}
  </div>;
}
