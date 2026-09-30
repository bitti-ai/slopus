import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { canCitePromptReference, promptReferenceToken, splitPromptText } from "../../lib/promptReferences";
import { Add14, Delete14 } from "../ui/icons";
import { Flyout, TextField } from "../ui";
import "../../styles/prompt-field.css";

export interface PromptReference {
  id: string;
  name: string;
  /** A glyph or thumbnail shown beside the name in the picker. */
  icon?: ReactNode;
  /** A second line in the picker, e.g. the kind of reference. */
  detail?: string;
}

/* A multi-line prompt whose references are smart chips inside the text.

   The value is plain text; a reference is written into it as `[Name]` (see
   lib/promptReferences) and the field shows every such token as a chip. The
   Reference button on the toolbar above opens a picker and drops the chosen
   reference at the caret; clicking a chip opens the same picker to change it
   to another reference or take it out.

   The editable surface is a contenteditable the component writes itself,
   not React children, so React never reconciles against what the browser
   typed. It is rebuilt from the value only when the two disagree — a change
   from outside, a chip picked, or `[Name]` typed out by hand — and the caret
   is put back by its offset in the text. */

const CHIP = "data-prompt-reference";
const END = "data-prompt-end";
/* A chip is not editable, and a caret cannot sit after one that ends the
   field; a zero-width space after it gives the caret somewhere to go. It is
   never part of the value. */
const CARET_ROOM = "​";

interface Picking {
  anchor: HTMLElement;
  start: number;
  end: number;
  /** The chip being changed; none when inserting. */
  current: string | null;
}

export function PromptTextField({ value, onChange, references, onInsertReference, disabled = false, placeholder, rows = 4, id, className, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy }: {
  value: string;
  onChange: (value: string) => void;
  references: readonly PromptReference[];
  /** Called with the reference a chip was made from, inserted or changed to. */
  onInsertReference?: (reference: PromptReference) => void;
  disabled?: boolean;
  placeholder?: string;
  /** The field's minimum height, in lines. */
  rows?: number;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const field = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const [picking, setPicking] = useState<Picking | null>(null);
  const known = new Set(references.map((reference) => reference.name));
  const knownKey = [...known].join("\n");

  /* Rebuilt when the value no longer matches what is on screen, or when a
     reference is added, removed or renamed and a chip's broken state flips. */
  const renderedKnown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = field.current;
    if (!root) return;
    const caret = pendingCaret.current ?? (document.activeElement === root ? caretRange(root)?.end ?? null : null);
    if (serialize(root) !== value || renderedKnown.current !== knownKey || needsRender(root)) {
      render(root, value, known);
      renderedKnown.current = knownKey;
      if (caret !== null && document.activeElement === root) placeCaret(root, caret);
    }
    if (pendingCaret.current !== null) {
      root.focus();
      placeCaret(root, pendingCaret.current);
      selection.current = { start: pendingCaret.current, end: pendingCaret.current };
      pendingCaret.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, knownKey]);

  /* The toolbar button takes the focus, so where the caret was is kept as it
     moves; a reference goes there, or at the end of a field never focused. */
  useEffect(() => {
    const remember = () => {
      const root = field.current;
      const range = root && caretRange(root);
      if (range) selection.current = range;
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, []);

  const replace = (start: number, end: number, text: string) => {
    pendingCaret.current = start + text.length;
    const next = value.slice(0, start) + text + value.slice(end);
    if (next === value) {
      // Nothing to re-render, but the caret still has to come back.
      const root = field.current!;
      root.focus();
      placeCaret(root, pendingCaret.current);
      pendingCaret.current = null;
    } else onChange(next);
  };

  const input = (native: Event) => {
    const root = field.current!;
    const next = serialize(root);
    // Chrome writes a chip out of `[Name]` typed by hand only once the
    // composition (an IME, a dead key) is over.
    if (!(native as InputEvent).isComposing && needsRender(root)) {
      const caret = caretRange(root)?.end ?? next.length;
      render(root, next, known);
      placeCaret(root, caret);
    }
    if (next !== value) onChange(next);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    // A line break is a character of the value, not a <div> the browser adds.
    event.preventDefault();
    const range = caretRange(field.current!) ?? { start: value.length, end: value.length };
    replace(range.start, range.end, "\n");
  };

  const openPicker = (anchor: HTMLElement, start: number, end: number, current: string | null) => {
    if (disabled) return;
    setPicking({ anchor, start, end, current });
  };

  const choose = (reference: PromptReference) => {
    if (!picking) return;
    const { start, end } = picking;
    setPicking(null);
    replace(start, end, promptReferenceToken(reference.name));
    onInsertReference?.(reference);
  };

  return <div className={`prompt-field ${disabled ? "prompt-field--disabled" : ""} ${className ?? ""}`}>
    <div className="prompt-field__toolbar" role="toolbar" aria-label={`${ariaLabel ?? "Prompt"} tools`}>
      <button
        ref={addButton}
        type="button"
        className="prompt-field__tool"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={picking?.current === null}
        data-tooltip="Insert a reference at the caret"
        onClick={() => {
          if (picking) { setPicking(null); return; }
          const at = selection.current ?? { start: value.length, end: value.length };
          openPicker(addButton.current!, Math.min(at.start, value.length), Math.min(at.end, value.length), null);
        }}
      ><Add14 aria-hidden="true" />Reference</button>
    </div>
    <div
      ref={field}
      id={id}
      className="prompt-field__input text-field"
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-placeholder={placeholder}
      aria-disabled={disabled || undefined}
      data-placeholder={placeholder}
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck
      tabIndex={disabled ? -1 : 0}
      style={{ "--prompt-rows": rows } as CSSProperties}
      onInput={(event) => input(event.nativeEvent)}
      onKeyDown={keyDown}
      onPaste={(event) => {
        // Only the characters: markup pasted from elsewhere would land as
        // elements the value has no way to say.
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
        const range = caretRange(field.current!) ?? { start: value.length, end: value.length };
        replace(range.start, range.end, text);
      }}
      onDrop={(event) => event.preventDefault()}
      onClick={(event) => {
        const chip = (event.target as HTMLElement).closest<HTMLElement>(`[${CHIP}]`);
        if (!chip || !field.current) return;
        event.preventDefault();
        const start = offsetBefore(field.current, chip);
        const name = chip.getAttribute(CHIP)!;
        openPicker(chip, start, start + promptReferenceToken(name).length, name);
      }}
    />
    <ReferencePicker
      picking={picking}
      references={references}
      onChoose={choose}
      onRemove={() => {
        if (!picking) return;
        setPicking(null);
        replace(picking.start, picking.end, "");
      }}
      onClose={() => setPicking(null)}
    />
  </div>;
}

function ReferencePicker({ picking, references, onChoose, onRemove, onClose }: {
  picking: Picking | null;
  references: readonly PromptReference[];
  onChoose: (reference: PromptReference) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (picking) setFilter(""); }, [picking]);
  const query = filter.trim().toLowerCase();
  const shown = references.filter((reference) => !query || reference.name.toLowerCase().includes(query));
  const missing = picking?.current != null && !references.some((reference) => reference.name === picking.current);

  const move = (event: ReactKeyboardEvent, step: number) => {
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!options.length) return;
    event.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    options[at < 0 ? (step > 0 ? 0 : options.length - 1) : (at + step + options.length) % options.length].focus();
  };

  return <Flyout
    open={Boolean(picking)}
    anchor={picking?.anchor ?? null}
    onClose={onClose}
    aria-label={picking?.current != null ? `Change reference ${picking.current}` : "Insert a reference"}
    className="prompt-reference-picker"
    initialFocus={filterInput}
    width={280}
  >
    {picking?.current != null && <p className="prompt-reference-picker__current">
      {missing ? <>No reference is named <b>{picking.current}</b>. Choose one to cite instead.</> : <>Cites <b>{picking.current}</b></>}
    </p>}
    {references.length > 6 && <TextField
      inputRef={filterInput}
      value={filter}
      onChange={setFilter}
      placeholder="Find a reference"
      aria-label="Find a reference"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") move(event, 1);
        if (event.key === "Enter" && shown.length) { event.preventDefault(); if (canCitePromptReference(shown[0].name)) onChoose(shown[0]); }
      }}
    />}
    <div ref={list} className="prompt-reference-picker__list" role="group" aria-label="References" onKeyDown={(event) => {
      if (event.key === "ArrowDown") move(event, 1);
      if (event.key === "ArrowUp") move(event, -1);
    }}>
      {shown.map((reference) => {
        const citable = canCitePromptReference(reference.name);
        return <button
          key={reference.id}
          type="button"
          className="prompt-reference-picker__option ui-selectable"
          aria-pressed={reference.name === picking?.current}
          disabled={!citable}
          data-tooltip={citable ? undefined : "Rename it without brackets to cite it in a prompt"}
          onClick={() => onChoose(reference)}
        >
          {reference.icon && <span className="prompt-reference-picker__icon" aria-hidden="true">{reference.icon}</span>}
          <span className="prompt-reference-picker__text"><span>{reference.name}</span>{reference.detail && <small>{reference.detail}</small>}</span>
        </button>;
      })}
      {!references.length && <p className="prompt-reference-picker__empty">No references yet — add them under References.</p>}
      {references.length > 0 && !shown.length && <p className="prompt-reference-picker__empty">No reference matches “{filter.trim()}”.</p>}
    </div>
    {picking?.current != null && <button type="button" className="prompt-reference-picker__option prompt-reference-picker__remove" onClick={onRemove}>
      <span className="prompt-reference-picker__icon" aria-hidden="true"><Delete14 /></span>Remove from the prompt
    </button>}
  </Flyout>;
}

/* --- The editable surface ------------------------------------------------ */

function chipElement(name: string, known: ReadonlySet<string>): HTMLElement {
  const chip = document.createElement("span");
  chip.setAttribute(CHIP, name);
  chip.setAttribute("contenteditable", "false");
  chip.className = known.has(name) ? "prompt-chip" : "prompt-chip prompt-chip--missing";
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", known.has(name) ? `Reference ${name}` : `Missing reference ${name}`);
  chip.dataset.tooltip = known.has(name) ? "Change or remove this reference" : "No reference has this name — click to choose one";
  chip.textContent = name;
  return chip;
}

function render(root: HTMLElement, value: string, known: ReadonlySet<string>) {
  const parts = splitPromptText(value);
  root.replaceChildren(...parts.map((part) => part.kind === "text" ? document.createTextNode(part.value) : chipElement(part.value, known)));
  if (parts.at(-1)?.kind === "reference") root.append(document.createTextNode(CARET_ROOM));
  // A closing line break draws no line of its own without something after it.
  if (value.endsWith("\n")) {
    const end = document.createElement("br");
    end.setAttribute(END, "");
    root.append(end);
  }
}

/** The value a subtree stands for. Takes a fragment too, so the text before
 *  the caret is measured by the same rule as the whole. */
function serialize(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) out += (child.textContent ?? "").replaceAll(CARET_ROOM, "");
    else if (child instanceof HTMLElement) {
      if (child.hasAttribute(CHIP)) out += promptReferenceToken(child.getAttribute(CHIP)!);
      else if (child.tagName === "BR") out += child.hasAttribute(END) ? "" : "\n";
      else {
        // A block the browser wrapped a line in starts a new line.
        if ((child.tagName === "DIV" || child.tagName === "P") && out && !out.endsWith("\n")) out += "\n";
        out += serialize(child);
      }
    }
  });
  return out;
}

/** Whether the surface holds anything `render` would not have written: a
 *  `[Name]` still as text, a stray element, or typing beside a caret room. */
function needsRender(root: HTMLElement): boolean {
  return [...root.childNodes].some((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      return splitPromptText(text.replaceAll(CARET_ROOM, "")).some((part) => part.kind === "reference") || (text.includes(CARET_ROOM) && text !== CARET_ROOM);
    }
    return !(child instanceof HTMLElement && (child.hasAttribute(CHIP) || child.hasAttribute(END)));
  }) || (root.lastChild?.nodeType === Node.ELEMENT_NODE && (root.lastChild as HTMLElement).hasAttribute(CHIP));
}

function offsetBefore(root: HTMLElement, node: Node): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEndBefore(node);
  return serialize(range.cloneContents()).length;
}

/** The selection as offsets into the value, or null when it is not in the field. */
function caretRange(root: HTMLElement): { start: number; end: number } | null {
  const selection = document.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const measure = (container: Node, offset: number) => {
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(container, offset);
    return serialize(before.cloneContents()).length;
  };
  return { start: measure(range.startContainer, range.startOffset), end: measure(range.endContainer, range.endOffset) };
}

function placeCaret(root: HTMLElement, offset: number) {
  const range = document.createRange();
  let remaining = offset;
  let placed = false;
  for (const child of [...root.childNodes]) {
    const length = serialize(wrap(child)).length;
    if (child.nodeType === Node.TEXT_NODE && remaining <= length) {
      // The caret room is invisible: offset 0 inside it is right after the chip.
      range.setStart(child, child.textContent === CARET_ROOM ? 0 : remaining);
      placed = true;
      break;
    }
    if (remaining === 0) { range.setStartBefore(child); placed = true; break; }
    if (remaining < length) { range.setStartAfter(child); placed = true; break; }
    remaining -= length;
  }
  if (!placed) { range.selectNodeContents(root); range.collapse(false); }
  range.collapse(true);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function wrap(node: Node): Node {
  const fragment = document.createDocumentFragment();
  fragment.append(node.cloneNode(true));
  return fragment;
}
