import { useEffect, useRef } from "react";
import type { ReactFlowInstance } from "@xyflow/react";

export type ShortcutAction = "zoomIn" | "zoomOut" | "undo" | "redo" | "save";

/** Which canvas shortcut a key press is, if any. Ctrl/Cmd+plus and minus stay the browser's own page zoom. */
export function shortcutOf(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): ShortcutAction | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && !event.shiftKey) return "redo";
    if (key === "s" && !event.shiftKey) return "save";
    return null;
  }
  if (event.key === "+" || event.key === "=") return "zoomIn";
  if (event.key === "-") return "zoomOut";
  return null;
}

/** Typing, IME composition, or a modal dialog (native or the narrow-screen overlay panel) owns the keyboard. */
function keyboardBusy(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (event.isComposing || target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return true;
  return Boolean(document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])'));
}

/**
 * Canvas keyboard shortcuts on `window` (mount it only while the canvas view is shown): + / = zoom in, - zoom out,
 * Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo, Ctrl/Cmd+S save. An action left undefined is unavailable (a
 * reader, nothing to undo) and its key keeps the browser's behaviour: `preventDefault` runs only when a shortcut acts.
 */
export function useKeyboardShortcuts(
  instance: Pick<ReactFlowInstance, "zoomIn" | "zoomOut">,
  actions: { undo?: () => void; redo?: () => void; save?: () => void },
  enabled = true,
) {
  const latest = useRef({ instance, actions });
  useEffect(() => { latest.current = { instance, actions }; });
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = shortcutOf(event);
      if (!action || keyboardBusy(event)) return;
      const { instance: flow, actions: available } = latest.current;
      const run = action === "zoomIn" ? () => void flow.zoomIn({ duration: 200 }) : action === "zoomOut" ? () => void flow.zoomOut({ duration: 200 }) : available[action];
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}
