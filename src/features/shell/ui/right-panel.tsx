"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import type { PanelMode } from "./dock";
import { Icon } from "./icon";
import type { RightTab } from "./project-ui";

/** Overlay behaviour shared by the sidebar and the right panel: focus the selected tab, trap Tab, Esc closes, focus returns to the opener. */
export function useOverlay(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => {
    if (!active) return;
    const before = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    function onKey(event: KeyboardEvent) {
      if (!node || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...node.querySelectorAll<HTMLElement>('a[href], button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter((element) => element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!node.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      requestAnimationFrame(() => {
        // Leave focus alone if the closer already moved it somewhere visible outside the overlay.
        const current = document.activeElement as HTMLElement | null;
        if (current && current !== document.body && current.getClientRects().length && !node?.contains(current)) return;
        if (before && before !== document.body && before.isConnected && before.getClientRects().length) before.focus();
      });
    };
  }, [active, ref]);
}

/** Arrow/Home/End roving focus for a horizontal tablist; the focused tab is activated. */
export function tabListKeyDown<T extends string>(event: ReactKeyboardEvent<HTMLElement>, ids: readonly T[], index: number, onChange: (id: T) => void) {
  const next = event.key === "ArrowRight" ? (index + 1) % ids.length
    : event.key === "ArrowLeft" ? (index - 1 + ids.length) % ids.length
    : event.key === "Home" ? 0
    : event.key === "End" ? ids.length - 1
    : -1;
  if (next < 0) return;
  event.preventDefault();
  onChange(ids[next]);
  (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
}

const TABS = ["details", "ai", "specs", "review"] as const;
const LABELS: Record<RightTab, string> = { details: "Details", ai: "AI", specs: "Specs", review: "Review" };

/** The on-demand right panel. Closed means hidden (display:none): it reserves no width and its in-memory state survives. */
export default function RightPanel({ mode, tab, onTabChange, onClose, children }: { mode: PanelMode; tab: RightTab; onTabChange: (tab: RightTab) => void; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const overlay = mode === "overlay";
  useOverlay(ref, overlay, onClose);
  return <aside ref={ref} id="right-panel" className="right-panel" aria-label="Project panel" role={overlay ? "dialog" : undefined} aria-modal={overlay || undefined} data-dock={mode} hidden={mode === "closed"}>
    <header className="right-panel-header">
      <div className="right-panel-tabs" role="tablist" aria-label="Project panel tabs">
        {TABS.map((id, index) => <button key={id} type="button" role="tab" id={`right-tab-${id}`} aria-selected={tab === id} aria-controls={`right-body-${id}`} tabIndex={tab === id ? 0 : -1} data-active={tab === id}
          onClick={() => onTabChange(id)} onKeyDown={(event) => tabListKeyDown(event, TABS, index, onTabChange)}>{LABELS[id]}</button>)}
      </div>
      <button type="button" className="button quiet small" onClick={onClose} aria-label="Close panel"><Icon name="close" /></button>
    </header>
    <div className="right-panel-body" id={`right-body-${tab}`} role="tabpanel" aria-labelledby={`right-tab-${tab}`}>{children}</div>
  </aside>;
}
