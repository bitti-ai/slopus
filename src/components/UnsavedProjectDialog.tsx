import { Save } from "lucide-react";
import { useEffect, useRef } from "react";

export function UnsavedProjectDialog({ name, busy, error, onSave, onDiscard, onBack }: {
  name: string;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onBack: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const save = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    save.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onBack(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (buttons.length === 0) { event.preventDefault(); return; }
      const next = event.shiftKey ? buttons.at(-1)! : buttons[0];
      if (!dialog.current?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === buttons[0] : document.activeElement === buttons.at(-1))) {
        event.preventDefault(); next.focus();
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [busy, onBack]);
  return <div className="delete-project-backdrop">
    <div ref={dialog} className="delete-project-dialog" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-project-title" aria-describedby="unsaved-project-description">
      <div className="delete-project-dialog__head"><h2 id="unsaved-project-title">Save changes?</h2></div>
      <div className="delete-project-dialog__body">
        <p id="unsaved-project-description">Save changes to “{name}” before returning to the project library?</p>
        {error && <p role="alert">Couldn’t save the project: {error}</p>}
      </div>
      <div className="delete-project-dialog__actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onBack}>Back</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onDiscard}>Discard changes</button>
        <button ref={save} type="button" className="primary-button" disabled={busy} onClick={onSave}><Save size={16} />{busy ? "Saving…" : "Save changes"}</button>
      </div>
    </div>
  </div>;
}
