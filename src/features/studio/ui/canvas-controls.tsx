"use client";

import { useReactFlow } from "@xyflow/react";
import { Icon, type IconName } from "@/features/shell/ui/icon";
import { useStudio } from "./studio-context";

function ControlButton({ label, icon, onClick, disabled }: { label: string; icon: IconName; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="canvas-control" aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon name={icon} size={16} /></button>;
}

/**
 * The floating bar at the canvas's bottom-left (UI02 Task 9): zoom out, fit view, zoom in, then Undo and Redo of the
 * unsaved changes. Readers and archived projects (not `editable`) get only the zoom group. The zoom buttons keep React
 * Flow's own names ("Zoom In", "Zoom Out", "Fit View").
 */
export default function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { editable, canUndo, canRedo, undo, redo } = useStudio();
  return <div className="canvas-controls" role="group" aria-label="Canvas controls">
    <ControlButton label="Zoom Out" icon="minus" onClick={() => void zoomOut({ duration: 200 })} />
    <ControlButton label="Fit View" icon="fit" onClick={() => void fitView({ padding: 0.2, maxZoom: 1, duration: 200 })} />
    <ControlButton label="Zoom In" icon="plus" onClick={() => void zoomIn({ duration: 200 })} />
    {editable && <>
      <span className="canvas-controls-divider" aria-hidden="true" />
      <ControlButton label="Undo" icon="undo" onClick={undo} disabled={!canUndo} />
      <ControlButton label="Redo" icon="redo" onClick={redo} disabled={!canRedo} />
    </>}
  </div>;
}
