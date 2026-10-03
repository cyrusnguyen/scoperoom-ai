"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Native modal: showModal() traps focus and turns Esc into onClose; closing returns focus to the opener. A layout effect
 * closes it before React removes the node (a removed modal no longer restores focus) and opens it before child effects run.
 */
export default function Dialog({ title, description, className = "", onClose, children, footer }: { title: string; description?: string; className?: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  // Chrome closes a modal on a repeated Esc even when `cancel` is prevented. This dialog is open for as long as it is
  // mounted, so a native close its owner didn't ask for (e.g. Esc while a request is in flight) reopens it.
  const reopen = () => { const dialog = ref.current; if (dialog?.isConnected && !dialog.open) dialog.showModal(); };
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby="dialog-title" aria-describedby={description ? "dialog-description" : undefined} onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={reopen}>
    <header className="modal-header"><h2 id="dialog-title">{title}</h2>{description && <p id="dialog-description" className="dialog-description">{description}</p>}</header>
    <div className="modal-body">{children}</div>
    <footer className="modal-footer">{footer}</footer>
  </dialog>;
}

/** showModal() focuses the first control; a confirmation moves initial focus to its safe choice instead (this effect runs after showModal). */
export function CancelFocus({ id, label, onClick, disabled }: { id?: string; label: string; onClick: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <button ref={ref} id={id} type="button" className="button quiet" onClick={onClick} disabled={disabled}>{label}</button>;
}
