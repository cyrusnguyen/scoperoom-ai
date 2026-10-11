"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { PANEL_WIDTHS, type PanelSide } from "./dock";

const LABELS: Record<PanelSide, string> = { left: "Resize projects sidebar", right: "Resize project panel" };
const CONTROLS: Record<PanelSide, string> = { left: "projects-nav", right: "right-panel" };

type Props = { side: PanelSide; width: number; clamp: (width: number) => number; onPreview: (width: number) => void; onCommit: (width: number) => void };

/**
 * Window splitter on a docked panel's inner edge. Dragging previews through `onPreview` once per frame, so the shell
 * can move the layout without re-rendering the editor; the width is committed on release. Arrows move 16 px (Shift 64),
 * Home and End jump to the limits, and Enter or a double click restores the initial width.
 */
export default function PanelResizer({ side, width, clamp, onPreview, onCommit }: Props) {
  const drag = useRef<{ x: number; start: number; current: number; frame: number; shell: HTMLElement | null } | null>(null);
  const commit = useRef(onCommit);
  useEffect(() => { commit.current = onCommit; });
  // A splitter removed mid-drag (its panel closed or became an overlay) still commits the width the layout shows.
  useEffect(() => () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    cancelAnimationFrame(state.frame);
    state.shell?.removeAttribute("data-resizing");
    commit.current(state.current);
  }, []);
  // Moving the splitter right widens the left panel and narrows the right one.
  const sign = side === "left" ? 1 : -1;
  const { initial, min, max } = PANEL_WIDTHS[side];

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const shell = event.currentTarget.closest<HTMLElement>(".app-shell");
    shell?.setAttribute("data-resizing", side);
    drag.current = { x: event.clientX, start: width, current: width, frame: 0, shell };
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    state.current = clamp(state.start + sign * (event.clientX - state.x));
    if (!state.frame) state.frame = requestAnimationFrame(() => {
      if (!drag.current) return;
      drag.current.frame = 0;
      onPreview(drag.current.current);
    });
  }
  function finish(event: PointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    cancelAnimationFrame(state.frame);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    state.shell?.removeAttribute("data-resizing");
    onCommit(state.current);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16;
    const next = event.key === "ArrowRight" ? width + sign * step
      : event.key === "ArrowLeft" ? width - sign * step
      : event.key === "Home" ? min
      : event.key === "End" ? max
      : event.key === "Enter" ? initial
      : null;
    if (next === null) return;
    event.preventDefault();
    onCommit(clamp(next));
  }

  return <div role="separator" tabIndex={0} className="panel-resizer" data-side={side} aria-orientation="vertical" aria-label={LABELS[side]}
    aria-controls={CONTROLS[side]} aria-valuenow={width} aria-valuemin={min} aria-valuemax={max}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onDoubleClick={() => onCommit(clamp(initial))} onKeyDown={onKeyDown} />;
}
