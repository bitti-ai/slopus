import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { filterReferenceOptions, type ReferenceMediaType } from "../../lib/referenceSelection";
import { Flyout, TextField } from "../ui";
import { Delete14 } from "../ui/icons";
import "../../styles/prompt-field.css";

export interface ReferenceOption {
  id: string;
  name: string;
  icon?: ReactNode;
  detail?: string;
  mediaTypes?: readonly ReferenceMediaType[];
}
const referenceId = (reference: ReferenceOption) => reference.id;

/** Shared by inline prompt chips and standalone reference selectors. */
export function ReferencePicker({ anchor, references: allReferences, accept, current = null, currentLabel, title, referenceKey = referenceId, unavailableReason,
  emptyLabel = "No references yet — add them under References.", clearLabel = "Remove from the prompt", allowEmpty = false, onChoose, onRemove, onClose }: {
  anchor: HTMLElement | null; references: readonly ReferenceOption[]; accept?: readonly ReferenceMediaType[];
  current?: string | null; currentLabel?: string; title: string;
  referenceKey?: (reference: ReferenceOption) => string; unavailableReason?: (reference: ReferenceOption) => string | null;
  emptyLabel?: string; clearLabel?: string; allowEmpty?: boolean;
  onChoose: (reference: ReferenceOption) => void; onRemove: () => void; onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const filterInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (anchor) setFilter(""); }, [anchor, current]);
  const references = filterReferenceOptions(allReferences, accept);
  const query = filter.trim().toLowerCase();
  const shown = references.filter((reference) => !query || reference.name.toLowerCase().includes(query));
  const missing = current !== null && !references.some((reference) => referenceKey(reference) === current);
  const move = (event: KeyboardEvent, step: number) => {
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!options.length) return;
    event.preventDefault();
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    options[at < 0 ? (step > 0 ? 0 : options.length - 1) : (at + step + options.length) % options.length].focus();
  };
  return <Flyout open={Boolean(anchor)} anchor={anchor} onClose={onClose} aria-label={title} className="prompt-reference-picker" initialFocus={filterInput} width={280}>
    {current !== null && <p className="prompt-reference-picker__current">
      {missing ? <><b>{currentLabel}</b> can’t be used. Choose another reference.</> : <>{allowEmpty ? "Selected:" : "Cites"} <b>{currentLabel}</b></>}
    </p>}
    {references.length > 6 && <TextField inputRef={filterInput} value={filter} onChange={setFilter} placeholder="Find a reference" aria-label="Find a reference"
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") move(event, 1);
        if (event.key === "Enter" && shown.length) { event.preventDefault(); const first = shown.find((reference) => !unavailableReason?.(reference)); if (first) onChoose(first); }
      }} />}
    <div ref={list} className="prompt-reference-picker__list" role="group" aria-label="References" onKeyDown={(event) => {
      if (event.key === "ArrowDown") move(event, 1);
      if (event.key === "ArrowUp") move(event, -1);
    }}>
      {allowEmpty && <button type="button" className="prompt-reference-picker__option ui-selectable" aria-pressed={current === null} onClick={onRemove}>{clearLabel}</button>}
      {shown.map((reference) => {
        const why = unavailableReason?.(reference) ?? null;
        return <button key={reference.id} type="button" className="prompt-reference-picker__option ui-selectable" aria-pressed={referenceKey(reference) === current}
          disabled={why !== null} data-tooltip={why ?? undefined} onClick={() => onChoose(reference)}>
          {reference.icon && <span className="prompt-reference-picker__icon" aria-hidden="true">{reference.icon}</span>}
          <span className="prompt-reference-picker__text"><span>{reference.name}</span>{reference.detail && <small>{reference.detail}</small>}</span>
        </button>;
      })}
      {!references.length && <p className="prompt-reference-picker__empty">{emptyLabel}</p>}
      {references.length > 0 && !shown.length && <p className="prompt-reference-picker__empty">No reference matches “{filter.trim()}”.</p>}
    </div>
    {!allowEmpty && current !== null && <button type="button" className="prompt-reference-picker__option prompt-reference-picker__remove" onClick={onRemove}>
      <span className="prompt-reference-picker__icon" aria-hidden="true"><Delete14 /></span>{clearLabel}
    </button>}
  </Flyout>;
}
