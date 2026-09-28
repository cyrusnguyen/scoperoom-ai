"use client";

import { useRef, type DragEvent } from "react";
import { STEP_SIZE } from "@/features/drafts/contracts/draft-layout";
import type { NodeKind } from "@/features/drafts/contracts/scope-document";
import { KindShape } from "./flow-canvas";
import { KIND_LABELS } from "./fields";
import { SHAPE_DRAG_MIME, type ShapeDragPayload } from "./studio-ui";

// Left to right, not NODE_KINDS order (Task 7 brief): Start, Step, Decision, Data store, End.
const PANEL_KINDS: readonly NodeKind[] = ["START", "ACTION", "DECISION", "DATA_STORE", "OUTCOME"];
// KIND_LABELS.OUTCOME stays "Outcome" for an existing e2e's Add-step "Shape" option; the panel button says more.
const PANEL_LABELS: Record<NodeKind, string> = { ...KIND_LABELS, OUTCOME: "End (Outcome)" };

/**
 * The floating bottom-centre shape toolbar (UI02 Task 7): five buttons, each both draggable (drop-to-create, handled
 * by the canvas wrapper) and clickable/keyboard-activatable (adds the kind at the canvas centre). The pill is only
 * the container; every button's shape comes from the same `KindShape` the canvas node draws. A native drag image is
 * set from an off-screen full-size copy of that shape so the ghost matches the step it will create.
 */
export default function ShapePanel({ disabled, onActivate }: { disabled: boolean; onActivate: (kind: NodeKind) => void }) {
  const ghosts = useRef<Partial<Record<NodeKind, HTMLDivElement>>>({});
  const dragStart = (kind: NodeKind) => (event: DragEvent<HTMLButtonElement>) => {
    if (disabled) { event.preventDefault(); return; }
    const size = STEP_SIZE[kind];
    const payload: ShapeDragPayload = { kind, width: size.width, height: size.height };
    event.dataTransfer.setData(SHAPE_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
    const ghost = ghosts.current[kind];
    if (ghost) event.dataTransfer.setDragImage(ghost, size.width / 2, size.height / 2);
  };
  return <div className="shape-panel nodrag nopan nowheel" role="group" aria-label="Add a shape">
    {PANEL_KINDS.map((kind) => (
      <button key={kind} type="button" className="shape-button" draggable={!disabled} disabled={disabled}
        aria-label={PANEL_LABELS[kind]} title={PANEL_LABELS[kind]} onDragStart={dragStart(kind)} onClick={() => onActivate(kind)}>
        <span className="step-node shape-icon" data-kind={kind} aria-hidden="true"><KindShape kind={kind} /></span>
      </button>
    ))}
    {/* Off-screen, full STEP_SIZE copies: the only source of each drag's native ghost image (never rendered visibly). */}
    <div className="shape-panel-ghosts" aria-hidden="true">
      {PANEL_KINDS.map((kind) => {
        const size = STEP_SIZE[kind];
        return <div key={kind} ref={(element) => { if (element) ghosts.current[kind] = element; }}
          className="step-node" data-kind={kind} style={{ width: size.width, height: size.height }}>
          <KindShape kind={kind} />
        </div>;
      })}
    </div>
  </div>;
}
