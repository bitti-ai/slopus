import { ArrowLeft, X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

export function SettingsEditorDialog({ children, footer, title, headingId, initialFocusLabel, closeLabel, onClose }: {
  children: ReactNode; footer?: ReactNode; title: string; headingId: string;
  initialFocusLabel: string; closeLabel: string; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>(`[aria-label="${initialFocusLabel}"]`)?.focus();
    return () => { requestAnimationFrame(() => { if (opener?.isConnected) opener.focus(); }); };
  }, [initialFocusLabel]);
  return <div className="generator-dialog-overlay" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary') ?? []);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <div ref={dialog} className="generator-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <header className="generator-dialog__head">
        <button type="button" className="icon-button icon-button--strong" onClick={onClose} aria-label="Generators" title="Back to generators"><ArrowLeft size={18} /></button>
        <h2 id={headingId}>{title}</h2>
        <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="generator-dialog__body">{children}</div>
      {footer}
    </div>
  </div>;
}
