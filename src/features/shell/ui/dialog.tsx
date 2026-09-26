"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Native modal: showModal() traps focus and turns Esc into onClose; closing returns focus to the opener. */
export default function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="modal-header"><h2 id="dialog-title">{title}</h2></header>
    <div className="modal-body">{children}</div>
    <footer className="modal-footer">{footer}</footer>
  </dialog>;
}

/** showModal() focuses the first control; a confirmation moves initial focus to its safe choice instead. */
export function CancelFocus({ label, onClick }: { label: string; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <button ref={ref} type="button" className="button quiet" onClick={onClick}>{label}</button>;
}
