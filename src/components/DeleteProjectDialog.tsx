import { AlertTriangle, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ProjectRecord } from "../lib/project";

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])";

export function DeleteProjectDialog({ project, deleting, onConfirm, onCancel }: {
  project: ProjectRecord;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const stops = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && (active === last || !dialog.current.contains(active))) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [deleting, onCancel]);

  return <div className="delete-project-backdrop" onMouseDown={(event) => { if (!deleting && event.target === event.currentTarget) onCancel(); }}>
    <div className="delete-project-dialog" ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" aria-describedby="delete-project-description">
      <div className="delete-project-dialog__head">
        <span aria-hidden="true"><AlertTriangle size={20} /></span>
        <h2 id="delete-project-title">Delete “{project.config.name}”?</h2>
      </div>
      <div className="delete-project-dialog__body" id="delete-project-description">
        <p>This permanently deletes the project folder and every file inside it. This cannot be undone.</p>
        <code title={project.folderPath}>{project.folderPath}</code>
      </div>
      <div className="delete-project-dialog__actions">
        <button className="secondary-button" type="button" ref={cancel} disabled={deleting} onClick={onCancel}>Cancel</button>
        <button className="delete-project-dialog__confirm" type="button" disabled={deleting} onClick={onConfirm}>
          {deleting ? <><LoaderCircle className="spin" size={16} /> Deleting…</> : <><Trash2 size={16} /> Delete project</>}
        </button>
      </div>
    </div>
  </div>;
}
