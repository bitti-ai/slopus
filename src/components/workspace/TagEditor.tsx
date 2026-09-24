import { Plus, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../../styles/tag-editor.css";

/** ImgFab's ordered style chips, stored as the existing comma-separated string. */
export function TagEditor({ label, value, suggestions, onChange }: {
  label: string; value: string; suggestions: readonly string[]; onChange: (value: string) => void;
}) {
  const id = useId();
  const tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [dragging, setDragging] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ index: number; x: number; y: number; active: boolean } | null>(null);
  const available = suggestions.filter((suggestion) => !tags.some((tag) => tag.toLowerCase() === suggestion.toLowerCase()));
  const close = () => { setOpen(false); addButton.current?.focus(); };
  const add = (raw: string) => {
    const next = [...tags];
    for (const tag of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!next.some((existing) => existing.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    if (next.length !== tags.length) onChange(next.join(", "));
    setCustom("");
    input.current?.focus();
  };
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= tags.length) return;
    const next = [...tags];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next.join(", "));
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = addButton.current!.getBoundingClientRect();
      const bounds = popup.current!.getBoundingClientRect();
      const top = anchor.bottom + 6 + bounds.height <= window.innerHeight - 8 ? anchor.bottom + 6 : anchor.top - bounds.height - 6;
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)), top: Math.max(8, top) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, available.length]);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !host.current?.contains(event.target) && !popup.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); };
  }, [open]);

  return <div className="tag-editor" ref={host} role="group" aria-labelledby={`${id}-label`} onBlur={(event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !host.current?.contains(next) && !popup.current?.contains(next)) setOpen(false);
  }}>
    <span className="tag-editor__label" id={`${id}-label`}>{label}</span>
    <div className="tag-editor__chips">
      {tags.map((tag, index) => <span key={`${index}-${tag}`} data-tag-index={index} className={`tag-editor__chip${dragging === index ? " dragging" : ""}`}>
        <button type="button" className="tag-editor__drag" aria-label={`${label} tag: ${tag}`} title="Drag to reorder, or use Alt + Left/Right" onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.preventDefault(); event.stopPropagation();
            const to = index + (event.key === "ArrowLeft" ? -1 : 1);
            move(index, to);
            if (to >= 0 && to < tags.length) requestAnimationFrame(() => host.current?.querySelector<HTMLButtonElement>(`[data-tag-index="${to}"] .tag-editor__drag`)?.focus());
          }
        }} onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { index, x: event.clientX, y: event.clientY, active: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerMove={(event) => {
          const start = drag.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4) { start.active = true; setDragging(start.index); }
        }} onPointerUp={(event) => {
          const start = drag.current;
          if (start?.active) {
            let target = start.index, distance = Infinity;
            host.current?.querySelectorAll<HTMLElement>("[data-tag-index]").forEach((chip) => {
              const box = chip.getBoundingClientRect();
              const d = Math.hypot(event.clientX - box.left - box.width / 2, event.clientY - box.top - box.height / 2);
              if (d < distance) { distance = d; target = Number(chip.dataset.tagIndex); }
            });
            move(start.index, target);
          }
          drag.current = null; setDragging(null);
        }} onLostPointerCapture={() => { drag.current = null; setDragging(null); }}>{tag}</button>
        <button type="button" className="tag-editor__remove" aria-label={`Remove ${tag} from ${label}`} onClick={() => onChange(tags.filter((_, i) => i !== index).join(", "))}><X size={12} /></button>
      </span>)}
      <button ref={addButton} type="button" className="tag-editor__add" aria-label={`Add ${label} tag`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-popup` : undefined} onClick={() => setOpen(!open)}><Plus size={13} /> Add</button>
    </div>
    {open && createPortal(<div ref={popup} id={`${id}-popup`} className="tag-editor__popup" role="dialog" aria-label={`Add ${label} tag`} style={position}>
      <strong>Add tag</strong>
      <div className="tag-editor__custom"><input ref={input} aria-label={`Custom ${label} tags`} placeholder="Custom tag…" value={custom} onChange={(event) => setCustom(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); add(custom); }
      }} /><button type="button" className="secondary-button" disabled={!custom.trim()} onClick={() => add(custom)}>Add</button></div>
      {available.length > 0 && <><span className="tag-editor__hint">Suggestions</span><div className="tag-editor__suggestions">{available.map((tag) => <button type="button" key={tag} onClick={() => add(tag)}>{tag}</button>)}</div></>}
    </div>, document.body)}
  </div>;
}
