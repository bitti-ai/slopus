import { X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../../styles/tag-editor.css";

const MAX_SUGGESTIONS = 8;

/** ImgFab's ordered style tokens, stored as the existing comma-separated string.
 *
 *  A token box, the way Windows mail "To" fields work: the tokens, then an
 *  inline text box. Typing filters the suggestions under it; Enter (or a
 *  comma) commits what was typed or the highlighted suggestion as a token;
 *  Backspace in an empty box removes the last token. Tokens reorder by drag
 *  or Alt+Left/Right. */
export function TagEditor({ label, value, suggestions, onChange }: {
  label: string; value: string; suggestions: readonly string[]; onChange: (value: string) => void;
}) {
  const id = useId();
  const tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<{ left: number; top: number; width: number }>({ left: 0, top: 0, width: 0 });
  const [dragging, setDragging] = useState<number | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ index: number; x: number; y: number; active: boolean } | null>(null);
  const query = text.trim().toLowerCase();
  const available = suggestions
    .filter((suggestion) => !tags.some((tag) => tag.toLowerCase() === suggestion.toLowerCase()))
    .filter((suggestion) => !query || suggestion.toLowerCase().includes(query))
    .slice(0, MAX_SUGGESTIONS);
  const listOpen = open && available.length > 0;
  const listId = `${id}-suggestions`;

  const add = (raw: string) => {
    const next = [...tags];
    for (const tag of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
      if (!next.some((existing) => existing.toLowerCase() === tag.toLowerCase())) next.push(tag);
    }
    if (next.length !== tags.length) onChange(next.join(", "));
    setText("");
    setActive(-1);
  };
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= tags.length) return;
    const next = [...tags];
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next.join(", "));
  };
  const removeAt = (index: number) => onChange(tags.filter((_, i) => i !== index).join(", "));

  useLayoutEffect(() => {
    if (!listOpen) return;
    const place = () => {
      const box = field.current?.getBoundingClientRect();
      if (box) setPosition({ left: box.left, top: box.bottom + 2, width: box.width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [listOpen]);

  return <div className="tag-editor" ref={host} role="group" aria-labelledby={`${id}-label`}>
    <span className="tag-editor__label" id={`${id}-label`}>{label}</span>
    <div className="tag-editor__field" ref={field} onMouseDown={(event) => {
      // A click on the field's empty space puts the caret in the text box.
      if (event.target === event.currentTarget) { event.preventDefault(); input.current?.focus(); }
    }}>
      {tags.map((tag, index) => <span key={`${index}-${tag}`} data-tag-index={index} className={`tag-editor__chip${dragging === index ? " dragging" : ""}`}>
        <button type="button" className="tag-editor__drag" aria-label={`${label} tag: ${tag}`} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight" data-tooltip="Drag to reorder" data-tooltip-shortcut="Alt+Left, Alt+Right" onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.preventDefault(); event.stopPropagation();
            const to = index + (event.key === "ArrowLeft" ? -1 : 1);
            move(index, to);
            if (to >= 0 && to < tags.length) requestAnimationFrame(() => host.current?.querySelector<HTMLButtonElement>(`[data-tag-index="${to}"] .tag-editor__drag`)?.focus());
          } else if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault(); event.stopPropagation();
            removeAt(index);
            requestAnimationFrame(() => input.current?.focus());
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
        <button type="button" className="tag-editor__remove" aria-label={`Remove ${tag} from ${label}`} tabIndex={-1} onClick={() => removeAt(index)}><X size={12} aria-hidden="true" /></button>
      </span>)}
      <input
        ref={input}
        className="tag-editor__input"
        role="combobox"
        aria-label={`Add ${label} tag`}
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={listOpen && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={tags.length ? "" : "Add a tag…"}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          // A typed comma commits everything before it.
          if (next.includes(",")) { add(next); return; }
          setText(next);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => { setOpen(false); setActive(-1); }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            if (listOpen && active >= 0) add(available[active]);
            else if (text.trim()) add(text);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!available.length) return;
            setOpen(true);
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((current) => (current + step + available.length + (current < 0 && step < 0 ? 1 : 0)) % available.length);
          } else if (event.key === "Escape" && (listOpen || text)) {
            event.preventDefault();
            event.stopPropagation();
            if (listOpen) setOpen(false); else setText("");
          } else if (event.key === "Backspace" && !text && tags.length) {
            event.preventDefault();
            removeAt(tags.length - 1);
          }
        }}
      />
    </div>
    {listOpen && createPortal(<div
      id={listId}
      role="listbox"
      className="tag-editor__suggestions"
      aria-label={`${label} suggestions`}
      style={{ left: position.left, top: position.top, minWidth: position.width }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {available.map((suggestion, index) => <div
        key={suggestion}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={index === active}
        className={`tag-editor__suggestion${index === active ? " tag-editor__suggestion--active" : ""}`}
        onMouseMove={() => setActive(index)}
        onClick={() => add(suggestion)}
      >{suggestion}</div>)}
    </div>, document.body)}
  </div>;
}
