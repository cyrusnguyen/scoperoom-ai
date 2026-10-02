"use client";

import { Handle, MarkerType, Position, ReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { STEP_SIZE } from "@/features/drafts/contracts/draft-layout";
import type { FlowFileNode } from "../contracts/flow-file";
import type { ImportPreviewView } from "../contracts/import";
import { KindShape } from "@/features/studio/ui/flow-canvas";
import { KIND_LABELS } from "@/features/studio/ui/fields";

type PreviewNode = Node<FlowFileNode>;
function Step({ data }: NodeProps<PreviewNode>) {
  return <div className="step-node" data-kind={data.kind}>
    <KindShape kind={data.kind} />
    {Object.values(Position).flatMap((side) => ["source", "target"].map((type) => <Handle key={`${side}-${type}`} id={side} type={type as "source" | "target"} position={side} isConnectable={false} style={{ visibility: "hidden" }} />))}
    <div className="step-body"><span className="step-kind">{KIND_LABELS[data.kind]}</span><span className="step-label">{data.label}</span>{data.actorLabel && <span className="step-actor">{data.actorLabel}</span>}</div>
  </div>;
}
const nodeTypes = { importStep: Step };

/** File-only presentation: no Studio, sync, authoritative draft or editing callbacks. */
export function ImportPreview({ preview, view }: { preview: ImportPreviewView; view: "canvas" | "list" }) {
  const file = preview.file;
  if (!file || !preview.positions) return <p>The preview body is no longer retained. Select the same file again for a new inspection.</p>;
  if (view === "list") return <div aria-label="Import graph list">
    <h3>{file.flow.title}</h3><p>{file.flow.purpose}</p>
    <ol>{file.nodes.map((node) => <li key={node.id}><strong>{node.label}</strong> · {KIND_LABELS[node.kind]}{node.actorLabel && <span> · {node.actorLabel}</span>}{node.description && <p>{node.description}</p>}{node.assumptionNotes.map((text, index) => <p key={index}>{text}</p>)}</li>)}</ol>
    <h4>Connections</h4><ul>{file.edges.map((edge) => <li key={edge.id}>{file.nodes.find((node) => node.id === edge.fromId)?.label} → {file.nodes.find((node) => node.id === edge.toId)?.label}{edge.condition && <span> · {edge.condition}</span>}</li>)}</ul>
  </div>;
  const positions = new Map(preview.positions.map((position) => [position.nodeId, position]));
  const nodes: PreviewNode[] = file.nodes.map((node) => ({ id: node.id, type: "importStep", data: node, position: positions.get(node.id)!, ...STEP_SIZE[node.kind] }));
  const edges = file.edges.map((edge) => {
    const sides = file.edgeSides?.find((sides) => sides.edgeId === edge.id);
    return { id: edge.id, source: edge.fromId, target: edge.toId, sourceHandle: sides?.from ?? (file.flow.direction === "LR" ? "right" : "bottom"), targetHandle: sides?.to ?? (file.flow.direction === "LR" ? "left" : "top"), label: edge.condition ?? "", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } };
  });
  return <div className="arrange-preview" aria-label="Read-only import graph"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} elementsSelectable={false} deleteKeyCode={null} proOptions={{ hideAttribution: true }} /></div>;
}
