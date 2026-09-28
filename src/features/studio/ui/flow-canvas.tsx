"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  Background, BaseEdge, ConnectionMode, Controls, EdgeLabelRenderer, getSmoothStepPath, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider,
  useReactFlow, type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import { SIDES, STEP_SIZE, type Direction, type Side } from "@/features/drafts/contracts/draft-layout";
import type { NodeKind } from "@/features/drafts/contracts/scope-document";
import { bufferKey, discard, edit, editFields, refuse, type Saved } from "./buffers";
import { endpointGuard, inlinePlan, KIND_LABELS, reconnectCommand, savedOf, updateCommand } from "./fields";
import ShapePanel from "./shape-panel";
import { explain, useStudio } from "./studio-context";
import { dropTarget, moveTargets, parseShapePayload, selectEdge, selectNodes, SHAPE_DRAG_MIME, type SelectChange, type StudioUi } from "./studio-ui";

type StepData = { label: string; kind: NodeKind; actor: string; direction: Direction };
type StepNode = Node<StepData, "step">;
type FlowEdge = Edge<{ condition: string }, "flow">;
type Point = { x: number; y: number };
/** The one open inline label editor. `select` selects its whole text (a step just added from the shape panel). */
type Editing = { kind: "NODE" | "EDGE"; id: string; select?: boolean } | null;
type InlineEditing = { editing: Editing; enabled: boolean; close: (refocus: boolean) => void; setNote: (note: string) => void };
const InlineEditingContext = createContext<InlineEditing>({ editing: null, enabled: false, close: () => {}, setNote: () => {} });

const INLINE = {
  NODE: { field: "label", name: "Step name", placeholder: "Name this step" },
  EDGE: { field: "condition", name: "Connection label", placeholder: "Add label" },
} as const;

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
const otherType = (type: "source" | "target") => (type === "source" ? "target" : "source");
// Handle ids are the side names themselves (Position's string values), so a connection's handles are its sides directly.
const isSide = (value: string | null | undefined): value is Side => (SIDES as readonly string[]).includes(value ?? "");

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

/**
 * Fixed application-owned shapes (UI02); names are plain text, clamped here and complete in the inspector. The label
 * is always `nopan`: React Flow drops a node's own `nopan` while it cannot be dragged (a save in flight, a reader),
 * and d3's double-click zoom would then swallow the double-click that opens the inline editor.
 */
function StepCard({ id, data, isConnectable }: NodeProps<StepNode>) {
  const { editing } = useContext(InlineEditingContext);
  return <div className="step-node" data-kind={data.kind}>
    <KindShape kind={data.kind} />
    {/* React Flow's edge-drawing lookup only finds a saved *start* handle among `source`-typed handles (never
        `target`), so every side needs one of each type at the same id and position to draw as either end of a saved
        connection. The primary pass keeps HANDLE_ORDER's direction-based type first in DOM order, so a plain
        (handle-less) connection still defaults to bottom→top (TB) or right→left (LR) as before; the secondary pass
        adds the other type, stacked exactly on top, so it still reads as one dot per side. */}
    {HANDLE_ORDER[data.direction].map(({ position, type }) => (
      <Handle key={`${position}-${type}`} id={position} type={type} position={position} isConnectable={isConnectable} />
    ))}
    {HANDLE_ORDER[data.direction].map(({ position, type }) => (
      <Handle key={`${position}-${otherType(type)}`} id={position} type={otherType(type)} position={position} isConnectable={isConnectable} />
    ))}
    <div className="step-body">
      <span className="step-kind">{KIND_LABELS[data.kind]}</span>
      {editing?.kind === "NODE" && editing.id === id ? <InlineEditor kind="NODE" id={id} /> : <span className="step-label nopan">{data.label}</span>}
      {data.actor && <span className="step-actor">{data.actor}</span>}
    </div>
  </div>;
}

function FlowEdgeLine({ id, selected, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<FlowEdge>) {
  const { editing, enabled } = useContext(InlineEditingContext);
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14, offset: 28 });
  // The label, its inline editor and the "Add label" hint all sit at the path's own label point.
  const style = { transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` };
  const label = editing?.kind === "EDGE" && editing.id === id
    ? <div className="edge-label edge-label-editor nodrag nopan nowheel" style={style}><InlineEditor kind="EDGE" id={id} /></div>
    : data?.condition ? <div className="edge-label" style={style}>{data.condition}</div>
      : selected && enabled ? <div className="edge-label edge-label-hint" style={style}>Add label</div> : null;
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={20} />
    {label && <EdgeLabelRenderer>{label}</EdgeLabelRenderer>}
  </>;
}

/**
 * Inline step name / connection label editor (UI02 Task 8). Its text lives in the same per-project buffer as the
 * inspector's field, so both show one value and neither overwrites the other; closing it (blur, Enter or Escape)
 * applies it like the inspector does: the same command, queued locally until Save, and the same conflict review.
 * A hidden copy of the text sizes it, so the editor covers the label exactly and grows with what is typed.
 */
function InlineEditor({ kind, id }: { kind: "NODE" | "EDGE"; id: string }) {
  const { draft, ui, update, run, inspect } = useStudio();
  const { editing, close, setNote } = useContext(InlineEditingContext);
  const control = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const closed = useRef(false);
  /** The text shown when the editor opened: closing without changing it sends nothing. */
  const opened = useRef<string | null>(null);
  const selectAll = Boolean(editing?.select);
  useEffect(() => {
    const element = control.current;
    if (!element) return;
    element.focus();
    if (selectAll) element.select();
    else element.setSelectionRange(element.value.length, element.value.length);
  }, [selectAll]);
  const record = kind === "NODE" ? draft.document.nodes[id] : draft.document.edges[id];
  if (!record) return null;
  const { field, name, placeholder } = INLINE[kind];
  const saved = savedOf(kind, record);
  const key = bufferKey(kind, id);
  const buffer = ui.buffers[key];
  const value = buffer && buffer.values[field] !== buffer.original[field] ? buffer.values[field]! : saved.fields[field]!;
  opened.current ??= value;
  const review = () => { update(() => ({ selection: kind === "NODE" ? { kind: "NODES", ids: [id] } : { kind: "EDGE", id } })); inspect(); };

  const finish = async (refocus: boolean) => {
    if (closed.current) return;
    closed.current = true;
    close(refocus);
    const plan = inlinePlan(buffer, kind, field, opened.current ?? value);
    if (plan.kind === "unchanged") return;
    if (plan.kind === "review") { review(); return; }
    if (plan.kind === "refused") { setNote(`${plan.message} Your text is kept; fix it here or in the inspector.`); return; }
    setNote("");
    const outcome = await run(updateCommand(kind, id, buffer!.baseVersion, plan.fields));
    // Queued: the text now lives in the queued command, shown on the canvas until Save or autosave sends it.
    if (outcome.ok) { update((current) => ({ buffers: discard(current.buffers, key) })); return; }
    const stale = outcome.code === "STALE_ENTITY_VERSION";
    update((current) => ({ buffers: refuse(current.buffers, key, stale) }));
    if (stale) review();
    else setNote(explain(outcome));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.stopPropagation(); // React Flow would otherwise select or deselect the element
    if (event.nativeEvent.isComposing || (event.key === "Enter" && event.shiftKey)) return;
    event.preventDefault();
    void finish(true);
  };
  const props = {
    ref: control, value, placeholder, "aria-label": name, className: "nodrag nopan nowheel",
    onChange: (event: { target: { value: string } }) => { const next = event.target.value; update((current) => ({ buffers: edit(current.buffers, saved, field, next) })); },
    onKeyDown, onBlur: () => void finish(false),
  };
  return <span className={kind === "NODE" ? "inline-edit step-label" : "inline-edit"}>
    <span className={kind === "NODE" ? "step-label" : undefined} aria-hidden="true">{value || placeholder}</span>
    {kind === "NODE" ? <textarea {...props} rows={1} cols={1} /> : <input {...props} size={1} />}
  </span>;
}

const nodeTypes = { step: StepCard };
const edgeTypes = { flow: FlowEdgeLine };
const defaultEdgeOptions = { type: "flow" as const };

/**
 * Controlled React Flow view of one flow of the shown draft (saved content plus unsaved changes). Selection, pan, zoom
 * and measurement stay local and never become edits; connecting and reconnecting queue the same commands as the Connect
 * form and the inspector, and a drop queues the moved steps, all saved later by Save, autosave or a save-first action
 * (Task 14b). Keyboard arrow moves are ignored: the inspector's position form is the keyboard path. `preview` renders proposed positions read-only.
 * A `ReactFlowProvider` wraps this so the shape panel's click path and the canvas wrapper's drop handler can both
 * convert a screen point to a flow position (`screenToFlowPosition` needs an ancestor provider).
 */
export default function FlowCanvas(props: { flowId: string; preview?: { positions: Record<string, Point>; direction: Direction } }) {
  // Keyed by flow: switching flows closes an inline editor and never reopens one for a step created in another flow.
  return <ReactFlowProvider><CanvasInner key={props.flowId} {...props} /></ReactFlowProvider>;
}

function CanvasInner({ flowId, preview }: { flowId: string; preview?: { positions: Record<string, Point>; direction: Direction } }) {
  const { draft, editable, ui, update, run, inspect, moveSteps, dragActive } = useStudio();
  const { document, layout } = draft;
  const { screenToFlowPosition } = useReactFlow();
  const [dragging, setDragging] = useState<Record<string, Point>>({});
  const [note, setNote] = useState("");
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [editing, setEditing] = useState<Editing>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const interactive = !preview;
  // A canvas unmounted mid-drag (flow removed elsewhere) must not leave autosave paused.
  useEffect(() => () => dragActive(false), [dragActive]);
  // Inline editors exist only on an editable, live canvas (never read-only, archived or the arrangement preview).
  const inlineEnabled = interactive && editable;
  // Every edit is local (queued in the outbox), so a save in flight never locks the canvas: new edits queue behind it.
  const connectable = interactive && editable;
  const draggable = interactive && editable;
  const shapesEnabled = interactive && editable;
  // A new shape is one local ADD_NODE plus its drop point, joined for undo; both show at once, with no request, in
  // the flow captured when the drop or click happened.
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
    await moveSteps(capturedFlowId, [{ nodeId, ...target }], { joined: true });
    update(() => ({ selection: { kind: "NODES", ids: [nodeId] } }));
    // Name it next: its default label is selected, so typing replaces it (a flow switch unmounted this canvas).
    setEditing({ kind: "NODE", id: nodeId, select: true });
  }, [flowId, run, draft, update, moveSteps]);
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
    const direction = preview?.direction ?? layout.directions[flowId] ?? "TB";
    return Object.values(document.nodes).filter((node) => node.flowId === flowId).map((node) => {
      const size = STEP_SIZE[node.kind];
      return {
        id: node.id, type: "step", width: size.width, height: size.height,
        position: preview?.positions[node.id] ?? dragging[node.id] ?? { x: layout.positions[node.id]!.x, y: layout.positions[node.id]!.y },
        data: { label: node.label, kind: node.kind, actor: node.actorLabel, direction }, selected: selected.includes(node.id), measured: measured[node.id],
      };
    });
  }, [document, layout, flowId, ui.selection, preview, dragging, interactive, measured]);

  const edges = useMemo<FlowEdge[]>(() => Object.values(document.edges).filter((edge) => edge.flowId === flowId).map((edge) => {
    // A saved connection point (UI02 Task 13); absent, an edge renders with today's direction-based default.
    const sides = layout.edgeSides[edge.id];
    return {
      id: edge.id, type: "flow", source: edge.fromId, target: edge.toId, data: { condition: edge.condition },
      ...(sides ? { sourceHandle: sides.from, targetHandle: sides.to } : {}),
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--foreground-subtle)" }, selected: interactive && ui.selection?.kind === "EDGE" && ui.selection.id === edge.id,
    };
  }), [document, layout, flowId, ui.selection, interactive]);

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
  // A step drag and a drag of the selection box both end here: one local drop, however many steps it moved.
  const drop = (moved: StepNode[]) => {
    dragActive(false);
    const targets = moveTargets(moved, layout);
    setDragging({});
    if (targets.length) void moveSteps(flowId, targets);
  };
  const onEdgesChange = (changes: EdgeChange<FlowEdge>[]) => {
    const selection = picks(changes);
    if (selection.length) update((current) => ({ selection: selectEdge(current.selection, selection) }));
  };
  const closeEditor = useCallback((refocus: boolean) => {
    if (refocus && editing) wrapperRef.current?.querySelector<HTMLElement>(`.react-flow__${editing.kind === "NODE" ? "node" : "edge"}[data-id="${CSS.escape(editing.id)}"]`)?.focus();
    setEditing(null);
  }, [editing]);
  const inline = useMemo<InlineEditing>(() => ({ editing: inlineEnabled ? editing : null, enabled: inlineEnabled, close: closeEditor, setNote }), [inlineEnabled, editing, closeEditor]);
  // Double-clicking a step's label names it in place; anywhere else on the step still opens the inspector.
  const nodeDoubleClick = (event: MouseEvent, node: StepNode) => {
    const target = event.target as Element;
    if (target.closest(".inline-edit")) return;
    if (inlineEnabled && target.closest(".step-label")) setEditing({ kind: "NODE", id: node.id });
    else inspect();
  };
  const edgeDoubleClick = (event: MouseEvent, edge: FlowEdge) => {
    if (inlineEnabled && !(event.target as Element).closest(".inline-edit")) setEditing({ kind: "EDGE", id: edge.id });
  };
  // The keyboard path: F2 or Enter on a focused step opens its editor.
  const canvasKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!inlineEnabled || (event.key !== "F2" && event.key !== "Enter") || event.nativeEvent.isComposing || !target.classList.contains("react-flow__node") || !target.dataset.id) return;
    event.preventDefault();
    setEditing({ kind: "NODE", id: target.dataset.id });
  };
  const connect = async ({ source, target, sourceHandle, targetHandle }: Connection) => {
    if (!source || !target || !connectable) return;
    const sides = isSide(sourceHandle) && isSide(targetHandle) ? { fromSide: sourceHandle, toSide: targetHandle } : {};
    const outcome = await run({ commandSchemaVersion: 1, command: "ADD_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { flowId, fromId: source, toId: target, condition: "", ...sides } });
    setNote(outcome.ok ? "" : explain(outcome));
  };
  const reconnect = async (edge: FlowEdge, { source, target, sourceHandle, targetHandle }: Connection) => {
    if (!source || !target || !connectable) return;
    const savedEdge = document.edges[edge.id];
    if (!savedEdge) return;
    const sides = isSide(sourceHandle) && isSide(targetHandle) ? { fromSide: sourceHandle, toSide: targetHandle } : {};
    // Dragging an end to another point on the same two steps only changes which handles it uses: a plain layout-only
    // save (Task 13), never the endpoint-choice review the inspector's dropdown form needs.
    if (source === savedEdge.fromId && target === savedEdge.toId) {
      if (!sides.fromSide) return;
      const outcome = await run({ commandSchemaVersion: 1, command: "RECONNECT_EDGE", expectedDocumentRevision: draft.documentRevision, payload: { edgeId: edge.id, fromId: source, toId: target, ...sides } });
      if (!outcome.ok) setNote(explain(outcome));
      return;
    }
    const key = bufferKey("EDGE", edge.id);
    const saved: Saved = { kind: "EDGE", id: edge.id, version: draft.documentRevision, fields: { fromId: savedEdge.fromId, toId: savedEdge.toId } };
    const choose = (current: StudioUi) => editFields(current.endpointBuffers, saved, { fromId: source, toId: target });
    const chosen = choose(ui)[key];
    if (!chosen) return;
    update((current) => ({ endpointBuffers: choose(current), selection: { kind: "EDGE", id: edge.id } }));
    // A second gesture can revise retained choices, but only the inspector can explicitly resolve a stale conflict.
    const guard = endpointGuard(chosen, savedEdge, draft.documentRevision);
    if (chosen.conflict || guard === null) {
      update((current) => ({ endpointBuffers: refuse(current.endpointBuffers, key, true) }));
      inspect();
      return;
    }
    const outcome = await run(reconnectCommand(edge.id, guard, chosen.values, sides));
    if (outcome.ok) { update((current) => ({ endpointBuffers: discard(current.endpointBuffers, key) })); return; }
    update((current) => ({ endpointBuffers: refuse(current.endpointBuffers, key, outcome.code === "STALE_DOCUMENT_REVISION") }));
    inspect();
  };

  return <InlineEditingContext.Provider value={inline}><div className="canvas" ref={wrapperRef} onDragOver={onShapeDragOver} onDrop={onShapeDrop} onKeyDown={canvasKeyDown}>
    <ReactFlow<StepNode, FlowEdge> key={preview ? `preview-${preview.direction}` : flowId} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      defaultEdgeOptions={defaultEdgeOptions} connectionMode={ConnectionMode.Loose}
      onNodesChange={interactive ? onNodesChange : measure} onEdgesChange={interactive ? onEdgesChange : undefined}
      onNodeDoubleClick={interactive ? nodeDoubleClick : undefined} onEdgeDoubleClick={interactive ? edgeDoubleClick : undefined} onNodeDragStart={interactive ? () => dragActive(true) : undefined} onNodeDragStop={interactive ? (_event, _node, moved) => drop(moved) : undefined}
      onSelectionDragStart={interactive ? () => dragActive(true) : undefined} onSelectionDragStop={interactive ? (_event, moved) => drop(moved) : undefined}
      onConnect={(connection) => void connect(connection)} onReconnect={reconnect} elementsSelectable={interactive}
      nodesDraggable={draggable} nodesConnectable={connectable} edgesReconnectable={connectable} deleteKeyCode={null}
      fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.1} maxZoom={4}
      aria-label={preview ? "Arrangement preview" : `${editable ? "Editable" : "Read-only"} flow canvas: ${document.flows[flowId]?.title ?? ""}`}>
      <Background gap={24} size={1} />
      {interactive && <Controls showInteractive={false} />}
    </ReactFlow>
    {interactive && editable && <ShapePanel disabled={!shapesEnabled} onActivate={activateShape} />}
    {!nodes.length && <div className="canvas-empty"><p>This flow has no steps yet.</p></div>}
    {note && <p className="canvas-note" role="alert">{note}</p>}
  </div></InlineEditingContext.Provider>;
}
