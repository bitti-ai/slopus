import { useEffect, useState, type InputHTMLAttributes } from "react";

/** A controlled number field that does not erase an in-progress keyboard edit.
 *  Empty strings, a lone minus sign, and values below a minimum are legitimate
 *  intermediate text; the parent only receives complete, valid numbers. */
export function CommittedNumberInput({ value, minimum, maximum, integer = false, onCommit, onChange: _onChange, onBlur: _onBlur, onKeyDown: _onKeyDown, ...input }: {
  value: number;
  minimum: number;
  maximum: number;
  integer?: boolean;
  onCommit: (value: number) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "min" | "max">) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const valid = (text: string): number | null => {
    if (text.trim() === "") return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) return null;
    return parsed >= minimum && parsed <= maximum ? parsed : null;
  };

  const finish = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || draft.trim() === "") {
      setDraft(String(value));
      return;
    }
    const normalized = Math.max(minimum, Math.min(maximum, integer ? Math.round(parsed) : parsed));
    setDraft(String(normalized));
    onCommit(normalized);
  };

  return <input
    {...input}
    type="number"
    min={minimum}
    max={maximum}
    value={draft}
    onChange={(event) => {
      const next = event.currentTarget.value;
      setDraft(next);
      const parsed = valid(next);
      if (parsed !== null) onCommit(parsed);
    }}
    onBlur={finish}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") {
        setDraft(String(value));
        event.currentTarget.blur();
      }
    }}
  />;
}
