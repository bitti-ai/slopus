import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { canCitePromptReference, promptReferenceToken, splitPromptText, type PromptPart } from "../../lib/promptReferences";
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

/** How references are written into the value. Each chip stands for one token
 *  and carries its key: what `split` reads out of the token and `token` writes
 *  back. */
export interface PromptTokenFormat {
  split: (text: string) => PromptPart[];
  token: (key: string) => string;
  key: (reference: PromptReference) => string;
  /** Why a reference cannot be written as a token, or null when it can. */
  uncitable?: (reference: PromptReference) => string | null;
}

/** `[Name]` — readable in the saved text, and what a person may type by hand. */
export const NAME_TOKENS: PromptTokenFormat = {
  split: splitPromptText,
  token: promptReferenceToken,
  key: (reference) => reference.name,
  uncitable: (reference) => canCitePromptReference(reference.name) ? null : "Rename it without brackets to cite it in a prompt",
};

/* A multi-line prompt whose references are smart chips inside the text.

   The value is plain text with each reference written into it as a token —
   `[Name]` by default (see lib/promptReferences), or any other `format` — and
   the field shows every token as a chip. The Reference button on the toolbar
   above opens a picker and drops the chosen reference at the caret; clicking a
   chip opens the same picker to change it to another reference or take it out.

   The editable surface is a contenteditable the component writes itself,
   not React children, so React never reconciles against what the browser
   typed. It is rebuilt from the value only when the two disagree — a change
   from outside, a chip picked, or a token typed out by hand — and the caret
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
  /** The key of the chip being changed; none when inserting. */
  current: string | null;
}

interface Chips {
  format: PromptTokenFormat;
  byKey: ReadonlyMap<string, PromptReference>;
  /** What a chip whose key no reference in the list has is called. */
  missingLabel: (key: string) => string;
}

export function PromptTextField({ value, onChange, references, format = NAME_TOKENS, missingLabel = (key) => key, missingTooltip = "No reference has this name — click to choose one", onInsertReference, disabled = false, placeholder, rows = 4, id, className, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy }: {
  value: string;
  onChange: (value: string) => void;
  /** The references the picker offers; a chip for any other key is missing. */
  references: readonly PromptReference[];
  format?: PromptTokenFormat;
  missingLabel?: (key: string) => string;
  missingTooltip?: string;
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
  const chips: Chips = { format, byKey: new Map(references.map((reference) => [format.key(reference), reference])), missingLabel };
  const label = (key: string) => chips.byKey.get(key)?.name ?? missingLabel(key);
  // What a chip shows: a rename or a reference coming and going redraws them.
  const chipsKey = references.map((reference) => `${format.key(reference)}\u0000${reference.name}`).join("\n");

  /* Rebuilt when the value no longer matches what is on screen, or when a
     reference is added, removed or renamed and a chip's label or state flips. */
  const renderedChips = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = field.current;
    if (!root) return;
    const caret = pendingCaret.current ?? (document.activeElement === root ? caretRange(root, format)?.end ?? null : null);
    if (serialize(root, format) !== value || renderedChips.current !== chipsKey || needsRender(root, format)) {
      render(root, value, chips, missingTooltip);
      renderedChips.current = chipsKey;
      if (caret !== null && document.activeElement === root) placeCaret(root, caret, format);
    }
    if (pendingCaret.current !== null) {
      root.focus();
      placeCaret(root, pendingCaret.current, format);
      selection.current = { start: pendingCaret.current, end: pendingCaret.current };
      pendingCaret.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, chipsKey]);

  /* The toolbar button takes the focus, so where the caret was is kept as it
     moves; a reference goes there, or at the end of a field never focused. */
  useEffect(() => {
    const remember = () => {
      const root = field.current;
      const range = root && caretRange(root, format);
      if (range) selection.current = range;
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, [format]);

  const replace = (start: number, end: number, text: string) => {
    pendingCaret.current = start + text.length;
    const next = value.slice(0, start) + text + value.slice(end);
    if (next === value) {
      // Nothing to re-render, but the caret still has to come back.
      const root = field.current!;
      root.focus();
      placeCaret(root, pendingCaret.current, format);
      pendingCaret.current = null;
    } else onChange(next);
  };

  const input = (native: Event) => {
    const root = field.current!;
    const next = serialize(root, format);
    // A token typed by hand becomes a chip only once the composition (an
    // IME, a dead key) is over.
    if (!(native as InputEvent).isComposing && needsRender(root, format)) {
      const caret = caretRange(root, format)?.end ?? next.length;
      render(root, next, chips, missingTooltip);
      placeCaret(root, caret, format);
    }
    if (next !== value) onChange(next);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    // A line break is a character of the value, not a <div> the browser adds.
    event.preventDefault();
    const range = caretRange(field.current!, format) ?? { start: value.length, end: value.length };
    replace(range.start, range.end, "\n");
  };

  const openPicker = (anchor: HTMLElement, start: number, end: number, current: string | null) => {
    if (disabled) return;
    setPicking({ anchor, start, end, current });
  };

  const choose = (reference: PromptReference) => {
    if (!picking) return;
    const { start, end, current } = picking;
    setPicking(null);
    // A new chip never touches a word: a citation fused to one reads as a
    // malformed token ("<Subject 1>walks") once the prompt is compiled. A
    // changed chip keeps the spacing it had.
    const lead = current === null && start > 0 && !/\s/.test(value[start - 1]) ? " " : "";
    const trail = current === null && end < value.length && !/\s/.test(value[end]) ? " " : "";
    replace(start, end, `${lead}${format.token(format.key(reference))}${trail}`);
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
        const range = caretRange(field.current!, format) ?? { start: value.length, end: value.length };
        replace(range.start, range.end, text);
      }}
      onDrop={(event) => event.preventDefault()}
      onClick={(event) => {
        const chip = (event.target as HTMLElement).closest<HTMLElement>(`[${CHIP}]`);
        if (!chip || !field.current) return;
        event.preventDefault();
        const start = offsetBefore(field.current, chip, format);
        const key = chip.getAttribute(CHIP)!;
        openPicker(chip, start, start + format.token(key).length, key);
      }}
    />
    <ReferencePicker
      picking={picking}
      references={references}
      format={format}
      label={label}
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

function ReferencePicker({ picking, references, format, label, onChoose, onRemove, onClose }: {
  picking: Picking | null;
  references: readonly PromptReference[];
  format: PromptTokenFormat;
  label: (key: string) => string;
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
  const current = picking?.current ?? null;
  const missing = current !== null && !references.some((reference) => format.key(reference) === current);

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
    aria-label={current !== null ? `Change reference ${label(current)}` : "Insert a reference"}
    className="prompt-reference-picker"
    initialFocus={filterInput}
    width={280}
  >
    {current !== null && <p className="prompt-reference-picker__current">
      {missing ? <><b>{label(current)}</b> can’t be used. Choose a reference to cite instead.</> : <>Cites <b>{label(current)}</b></>}
    </p>}
    {references.length > 6 && <TextField
      inputRef={filterInput}
      value={filter}
      onChange={setFilter}
      placeholder="Find a reference"
      aria-label="Find a reference"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") move(event, 1);
        if (event.key === "Enter" && shown.length) { event.preventDefault(); if (!format.uncitable?.(shown[0])) onChoose(shown[0]); }
      }}
    />}
    <div ref={list} className="prompt-reference-picker__list" role="group" aria-label="References" onKeyDown={(event) => {
      if (event.key === "ArrowDown") move(event, 1);
      if (event.key === "ArrowUp") move(event, -1);
    }}>
      {shown.map((reference) => {
        const why = format.uncitable?.(reference) ?? null;
        return <button
          key={reference.id}
          type="button"
          className="prompt-reference-picker__option ui-selectable"
          aria-pressed={format.key(reference) === current}
          disabled={why !== null}
          data-tooltip={why ?? undefined}
          onClick={() => onChoose(reference)}
        >
          {reference.icon && <span className="prompt-reference-picker__icon" aria-hidden="true">{reference.icon}</span>}
          <span className="prompt-reference-picker__text"><span>{reference.name}</span>{reference.detail && <small>{reference.detail}</small>}</span>
        </button>;
      })}
      {!references.length && <p className="prompt-reference-picker__empty">No references yet — add them under References.</p>}
      {references.length > 0 && !shown.length && <p className="prompt-reference-picker__empty">No reference matches “{filter.trim()}”.</p>}
    </div>
    {current !== null && <button type="button" className="prompt-reference-picker__option prompt-reference-picker__remove" onClick={onRemove}>
      <span className="prompt-reference-picker__icon" aria-hidden="true"><Delete14 /></span>Remove from the prompt
    </button>}
  </Flyout>;
}

/* --- The editable surface ------------------------------------------------ */

function chipElement(key: string, chips: Chips, missingTooltip: string): HTMLElement {
  const reference = chips.byKey.get(key);
  const name = reference?.name ?? chips.missingLabel(key);
  const chip = document.createElement("span");
  chip.setAttribute(CHIP, key);
  chip.setAttribute("contenteditable", "false");
  chip.className = reference ? "prompt-chip" : "prompt-chip prompt-chip--missing";
  chip.setAttribute("role", "button");
  chip.setAttribute("aria-label", reference ? `Reference ${name}` : `Missing reference ${name}`);
  chip.dataset.tooltip = reference ? "Change or remove this reference" : missingTooltip;
  chip.textContent = name;
  return chip;
}

function render(root: HTMLElement, value: string, chips: Chips, missingTooltip: string) {
  const parts = chips.format.split(value);
  root.replaceChildren(...parts.map((part) => part.kind === "text" ? document.createTextNode(part.value) : chipElement(part.value, chips, missingTooltip)));
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
function serialize(node: Node, format: PromptTokenFormat): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) out += (child.textContent ?? "").replaceAll(CARET_ROOM, "");
    else if (child instanceof HTMLElement) {
      if (child.hasAttribute(CHIP)) out += format.token(child.getAttribute(CHIP)!);
      else if (child.tagName === "BR") out += child.hasAttribute(END) ? "" : "\n";
      else {
        // A block the browser wrapped a line in starts a new line.
        if ((child.tagName === "DIV" || child.tagName === "P") && out && !out.endsWith("\n")) out += "\n";
        out += serialize(child, format);
      }
    }
  });
  return out;
}

/** Whether the surface holds anything `render` would not have written: a
 *  token still as text, a stray element, or typing beside a caret room. */
function needsRender(root: HTMLElement, format: PromptTokenFormat): boolean {
  return [...root.childNodes].some((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      return format.split(text.replaceAll(CARET_ROOM, "")).some((part) => part.kind === "reference") || (text.includes(CARET_ROOM) && text !== CARET_ROOM);
    }
    return !(child instanceof HTMLElement && (child.hasAttribute(CHIP) || child.hasAttribute(END)));
  }) || (root.lastChild?.nodeType === Node.ELEMENT_NODE && (root.lastChild as HTMLElement).hasAttribute(CHIP));
}

function offsetBefore(root: HTMLElement, node: Node, format: PromptTokenFormat): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEndBefore(node);
  return serialize(range.cloneContents(), format).length;
}

/** The selection as offsets into the value, or null when it is not in the field. */
function caretRange(root: HTMLElement, format: PromptTokenFormat): { start: number; end: number } | null {
  const selection = document.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const measure = (container: Node, offset: number) => {
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(container, offset);
    return serialize(before.cloneContents(), format).length;
  };
  return { start: measure(range.startContainer, range.startOffset), end: measure(range.endContainer, range.endOffset) };
}

function placeCaret(root: HTMLElement, offset: number, format: PromptTokenFormat) {
  const range = document.createRange();
  let remaining = offset;
  let placed = false;
  for (const child of [...root.childNodes]) {
    const length = serialize(wrap(child), format).length;
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
