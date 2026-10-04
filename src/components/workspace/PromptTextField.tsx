import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { canTokenizeReference, referenceToken, splitActionText, type ActionPart } from "../../lib/project";
import { Add14 } from "../ui/icons";
import { ReferencePicker, type ReferenceOption } from "./ReferencePicker";
import { filterReferenceOptions, type ReferenceMediaType } from "../../lib/referenceSelection";
import "../../styles/prompt-field.css";

export type PromptReference = ReferenceOption;

/** How references are written into the value. Each chip stands for one token
 *  and carries its key: what `split` reads out of the token and `token` writes
 *  back. */
export interface PromptTokenFormat {
  split: (text: string) => ActionPart[];
  token: (key: string) => string;
  key: (reference: PromptReference) => string;
  /** Why a reference cannot be written as a token, or null when it can. */
  uncitable?: (reference: PromptReference) => string | null;
}

/** `@[ref:<id>]` — an id survives a rename and a reorder; the chip shows the
 *  name. The same token the video compiler and the agent read. */
export const REFERENCE_TOKENS: PromptTokenFormat = {
  split: splitActionText,
  token: referenceToken,
  key: (reference) => reference.id,
  uncitable: (reference) => canTokenizeReference(reference.id) ? null : "This reference can’t be written into a prompt",
};

/* A multi-line prompt whose references are smart chips inside the text.

   The value is plain text with each reference written into it as a token —
   `@[ref:<id>]` by default, or any other `format` — and the field shows every
   token as a chip. The Reference button on the toolbar
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

export function PromptTextField({ value, onChange, references: allReferences, accept, referenceButtonLabel = "Reference", format = REFERENCE_TOKENS, missingLabel = () => "Deleted reference", missingTooltip = "Left out of the prompt — click to swap it for another reference or remove it", onInsertReference, disabled = false, placeholder, rows = 4, id, className, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy }: {
  value: string;
  onChange: (value: string) => void;
  /** The references the picker offers; a chip for any other key is missing. */
  references: readonly PromptReference[];
  accept?: readonly ReferenceMediaType[];
  referenceButtonLabel?: string;
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
  const references = filterReferenceOptions(allReferences, accept);
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
    highlightSelectedChips(root);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, chipsKey]);

  /* The toolbar button takes the focus, so where the caret was is kept as it
     moves; a reference goes there, or at the end of a field never focused. */
  useEffect(() => {
    const remember = () => {
      const root = field.current;
      const range = root && caretRange(root, format);
      if (range) selection.current = range;
      if (root) highlightSelectedChips(root);
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

  const copy = (event: ReactClipboardEvent<HTMLDivElement>, cut = false) => {
    if (cut && disabled) { event.preventDefault(); return; }
    const root = field.current!;
    const range = caretRange(root, format);
    if (!range || range.start === range.end) return;
    // Copy the token IDs, not the chip labels the browser would put on the
    // clipboard. Plain text also preserves citations through other text fields.
    event.clipboardData.setData("text/plain", serialize(root, format).slice(range.start, range.end));
    event.preventDefault();
    if (cut) replace(range.start, range.end, "");
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
      ><Add14 aria-hidden="true" />{referenceButtonLabel}</button>
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
      onCopy={copy}
      onCut={(event) => copy(event, true)}
      onPaste={(event) => {
        // Only the characters: markup pasted from elsewhere would land as
        // elements the value has no way to say.
        event.preventDefault();
        if (disabled) return;
        const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
        const range = caretRange(field.current!, format) ?? { start: value.length, end: value.length };
        replace(range.start, range.end, text);
        const keys = new Set(format.split(text).filter((part) => part.kind === "reference").map((part) => part.value));
        for (const key of keys) {
          const reference = chips.byKey.get(key);
          if (reference) onInsertReference?.(reference);
        }
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
      anchor={picking?.anchor ?? null}
      current={picking?.current ?? null}
      currentLabel={picking?.current != null ? label(picking.current) : undefined}
      title={picking?.current != null ? `Change reference ${label(picking.current)}` : "Insert a reference"}
      references={references}
      referenceKey={format.key}
      unavailableReason={format.uncitable}
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

/* --- The editable surface ------------------------------------------------ */

/** Noneditable chips do not receive the browser's text-selection paint.
 *  Update their appearance directly so selection changes never rebuild the DOM. */
function highlightSelectedChips(root: HTMLElement) {
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).filter((range) => !range.collapsed) : [];
  root.querySelectorAll<HTMLElement>(`[${CHIP}]`).forEach((chip) => {
    chip.classList.toggle("prompt-chip--selected", ranges.some((range) => range.intersectsNode(chip)));
  });
}

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
  const range = selection.getRangeAt(0).cloneRange();
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  // A chip is one token even when a browser selection lands inside its label.
  // Expand nonempty selections to its edges so copy, cut and paste stay atomic.
  if (!range.collapsed) {
    const chipAt = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest(`[${CHIP}]`);
    const startChip = chipAt(range.startContainer);
    const endChip = chipAt(range.endContainer);
    if (startChip) range.setStartBefore(startChip);
    if (endChip) range.setEndAfter(endChip);
  }
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
  highlightSelectedChips(root);
}

function wrap(node: Node): Node {
  const fragment = document.createDocumentFragment();
  fragment.append(node.cloneNode(true));
  return fragment;
}
