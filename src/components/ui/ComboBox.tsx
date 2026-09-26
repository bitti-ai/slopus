/* ComboBox — the WinUI drop-down, a drop-in for <select>.

   A 32px trigger styled as a standard button with a chevron. It opens an
   acrylic listbox flyout (8px corners, 4px padding, 32px items, a 3×16px
   accent pill beside the selected item) positioned so the selected item sits
   right over the trigger when there is room, else below or above.

   Focus never leaves the trigger: it is the ARIA 1.2 select-only combobox, so
   the list is driven with aria-activedescendant and Tab simply moves on.

   Keyboard, closed: Alt+Down / F4 / Enter / Space open; Up / Down / Home / End
   and typing change the value directly, like a native select.
   Keyboard, open: arrows / Home / End / PageUp / PageDown / typing move,
   Enter or Space picks, Esc or Alt+Up closes, Tab picks-nothing and moves on.

   Migrating from <select> is mechanical — keep the <option> children:

     <select value={v} onChange={(e) => setV(e.target.value)}>…options…</select>
     <ComboBox value={v} onChange={setV}>…same options…</ComboBox>

   or pass data:

     <ComboBox aria-label="Generator" value={id} onChange={setId}
       options={[{ value: "a", label: "Alpha" }, { label: "More", options: [...] }]} />

   Editable mode (`editable`) is the WinUI IsEditable ComboBox: a text field
   with the drop-down button at its end. The list works as above; typed text
   is committed on Enter or when focus leaves, through `parseText`, which
   returns the value the text means or null to refuse it (the field then goes
   back to `displayText`). Esc drops what was typed. Focus stays in the field:

     <ComboBox editable aria-label="Zoom" value={preset} displayText="137%"
       parseText={(text) => parsePercent(text)} options={presets} onChange={zoomTo} />
*/

import { ChevronDown12 } from "./icons";
import {
  Children, Fragment, isValidElement, useId, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  LAYER_ATTR, VIEWPORT_MARGIN, createTypeahead, cx, isPrintableKey, placeAnchored, textOf, useLightDismiss, viewport,
} from "./internal";

export type ComboValue = string | number;

export interface ComboOption<V extends ComboValue = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** A second, caption-sized line under the label (in the list only). */
  description?: ReactNode;
  /** 16px leading icon (list and trigger). */
  icon?: ReactNode;
  /** Plain text for typeahead / accessibility when `label` is not a string. */
  textValue?: string;
}

export interface ComboGroup<V extends ComboValue = string> {
  label: string;
  options: ComboOption<V>[];
}

export type ComboItems<V extends ComboValue = string> = (ComboOption<V> | ComboGroup<V>)[];

export interface ComboBoxProps<V extends ComboValue = string> {
  value: V | null | undefined;
  onChange: (value: V) => void;
  /** Data form. When omitted, <option>/<optgroup> children are read instead. */
  options?: ComboItems<V>;
  children?: ReactNode;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-tooltip"?: string;
  disabled?: boolean;
  /** Shown when no option matches `value`. */
  placeholder?: ReactNode;
  className?: string;
  /** CSS width of the trigger (number = px). Default: sized by the stylesheet (min 120px). */
  width?: number | string;
  onBlur?: () => void;
  onFocus?: () => void;
  /** A text field with a drop-down button instead of a select-only button. */
  editable?: boolean;
  /** Editable mode: the value typed text stands for, or null to reject it.
   *  Default: the option whose label or value matches, ignoring case. */
  parseText?: (text: string) => V | null;
  /** Editable mode: the field's text while nothing is being typed. Default:
   *  the selected option's text (or empty). */
  displayText?: string;
}

const isGroup = <V extends ComboValue>(item: ComboOption<V> | ComboGroup<V>): item is ComboGroup<V> =>
  "options" in item && Array.isArray((item as ComboGroup<V>).options);

/** Read <option>/<optgroup> React children into ComboBox items. Values stay strings, like a select's. */
export function optionsFromChildren(children: ReactNode): ComboItems<string> {
  const items: ComboItems<string> = [];
  const readOption = (element: ReactElement<{ value?: unknown; children?: ReactNode; disabled?: boolean; label?: string }>): ComboOption<string> => {
    const { value, children: label, disabled } = element.props;
    const text = textOf(label);
    return { value: value === undefined ? text : String(value), label: label ?? element.props.label ?? "", disabled: Boolean(disabled), textValue: text };
  };
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === "option") items.push(readOption(child as ReactElement<{ value?: unknown; children?: ReactNode }>));
    else if (child.type === "optgroup") {
      const props = child.props as { label?: string; children?: ReactNode };
      const options: ComboOption<string>[] = [];
      Children.forEach(props.children, (inner) => {
        if (isValidElement(inner) && inner.type === "option") options.push(readOption(inner as ReactElement<{ value?: unknown; children?: ReactNode }>));
      });
      items.push({ label: props.label ?? "", options });
    } else if (child.type === Fragment) {
      // Fragments of options (e.g. {list.map(...)} inside <>…</>).
      items.push(...optionsFromChildren((child.props as { children?: ReactNode }).children));
    }
  });
  return items;
}

interface FlatOption<V extends ComboValue> extends ComboOption<V> { group?: string; firstInGroup?: boolean; text: string }

function flatten<V extends ComboValue>(items: ComboItems<V>): FlatOption<V>[] {
  const flat: FlatOption<V>[] = [];
  for (const item of items) {
    if (isGroup(item)) item.options.forEach((option, index) => flat.push({ ...option, group: item.label, firstInGroup: index === 0, text: option.textValue ?? textOf(option.label) }));
    else flat.push({ ...item, text: item.textValue ?? textOf(item.label) });
  }
  return flat;
}

const ITEM_HEIGHT = 32;

export function ComboBox<V extends ComboValue = string>(props: ComboBoxProps<V>) {
  return props.editable ? <EditableComboBox {...props} /> : <SelectComboBox {...props} />;
}

function SelectComboBox<V extends ComboValue = string>(props: ComboBoxProps<V>) {
  const {
    value, onChange, options, children, id, name, disabled, placeholder, className, width, onBlur, onFocus,
  } = props;
  const items = useMemo(() => (options ?? (optionsFromChildren(children) as unknown as ComboItems<V>)), [options, children]);
  const flat = useMemo(() => flatten(items), [items]);
  const selectedIndex = flat.findIndex((option) => option.value === value || String(option.value) === String(value ?? "\u0000"));
  const selected = selectedIndex >= 0 ? flat[selectedIndex] : undefined;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typeahead = useRef(createTypeahead());
  const autoId = useId();
  const listId = `${autoId}-list`;
  const optionId = (index: number) => `${autoId}-opt-${index}`;

  const enabledIndexes = flat.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);

  const commit = (index: number) => {
    const option = flat[index];
    if (!option || option.disabled) return;
    if (option.value !== value) onChange(option.value);
  };

  const openList = () => {
    if (disabled || !flat.length) return;
    setActive(selectedIndex >= 0 && !flat[selectedIndex].disabled ? selectedIndex : enabledIndexes[0] ?? -1);
    setPosition({ visibility: "hidden" });
    setOpen(true);
  };
  const close = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus({ preventScroll: true });
  };

  useLightDismiss(list, open, (reason) => close(reason === "escape"), { ignore: [trigger] });

  /* Place the list: selected item over the trigger, else below, else above. */
  useLayoutEffect(() => {
    if (!open || !list.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const view = viewport();
    const listRect = list.current.getBoundingClientRect();
    const height = listRect.height || flat.length * ITEM_HEIGHT + 8;
    const width = Math.max(anchor.width, listRect.width);
    const item = active >= 0 ? document.getElementById(optionId(selectedIndex >= 0 ? selectedIndex : active)) : null;
    let top: number;
    let left = anchor.left;
    const overTop = item ? anchor.top + anchor.height / 2 - (item.offsetTop - list.current.scrollTop + item.offsetHeight / 2) : NaN;
    if (item && overTop >= VIEWPORT_MARGIN && overTop + height <= view.height - VIEWPORT_MARGIN) {
      top = overTop;
    } else {
      const placed = placeAnchored(anchor, { width, height }, "bottom", 4, view);
      top = placed.top;
      left = placed.left;
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, view.width - width - VIEWPORT_MARGIN));
    setPosition({ top, left, minWidth: anchor.width });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* Keep the active option in view. */
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const element = document.getElementById(optionId(active));
    element?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const step = (from: number, delta: number) => {
    if (!enabledIndexes.length) return -1;
    const at = enabledIndexes.indexOf(from);
    if (at < 0) return delta > 0 ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1];
    return enabledIndexes[Math.max(0, Math.min(enabledIndexes.length - 1, at + delta))];
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const { key, altKey } = event;
    if (!open) {
      if ((altKey && key === "ArrowDown") || key === "F4" || key === "Enter" || key === " ") {
        event.preventDefault();
        openList();
        return;
      }
      let next = -1;
      if (key === "ArrowDown" || key === "ArrowRight") next = step(selectedIndex, 1);
      else if (key === "ArrowUp" || key === "ArrowLeft") next = step(selectedIndex, -1);
      else if (key === "Home") next = enabledIndexes[0] ?? -1;
      else if (key === "End") next = enabledIndexes.at(-1) ?? -1;
      else if (isPrintableKey(event)) next = typeahead.current(key, flat.map((option) => (option.disabled ? "" : option.text)), selectedIndex);
      else return;
      event.preventDefault();
      if (next >= 0) commit(next);
      return;
    }
    // Open.
    if (key === "Escape" || (altKey && key === "ArrowUp") || key === "F4") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      event.stopPropagation();
      if (active >= 0) commit(active);
      close();
      return;
    }
    if (key === "Tab") { close(false); return; }
    const page = Math.max(1, Math.floor((list.current?.clientHeight ?? 320) / ITEM_HEIGHT) - 1);
    let next = active;
    if (key === "ArrowDown") next = step(active, 1);
    else if (key === "ArrowUp") next = step(active, -1);
    else if (key === "Home") next = enabledIndexes[0] ?? -1;
    else if (key === "End") next = enabledIndexes.at(-1) ?? -1;
    else if (key === "PageDown") next = step(active, page);
    else if (key === "PageUp") next = step(active, -page);
    else if (isPrintableKey(event)) {
      const found = typeahead.current(key, flat.map((option) => (option.disabled ? "" : option.text)), active);
      if (found >= 0) next = found;
    } else return;
    event.preventDefault();
    setActive(next);
  };

  const style: CSSProperties | undefined = width !== undefined ? { width: typeof width === "number" ? `${width}px` : width } : undefined;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        id={id}
        role="combobox"
        className={cx("ui-combo", className)}
        style={style}
        disabled={disabled}
        aria-label={props["aria-label"]}
        aria-labelledby={props["aria-labelledby"]}
        aria-describedby={props["aria-describedby"]}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        data-tooltip={props["data-tooltip"]}
        data-value={value ?? ""}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onFocus={onFocus}
      >
        {selected?.icon && <span className="ui-combo__icon" aria-hidden="true">{selected.icon}</span>}
        <span className={cx("ui-combo__value", !selected && "ui-combo__value--placeholder")}>{selected ? selected.label : placeholder ?? " "}</span>
        <ChevronDown12 className="ui-combo__chevron" aria-hidden="true" />
      </button>
      {name !== undefined && <input type="hidden" name={name} value={value === null || value === undefined ? "" : String(value)} />}
      {open && createPortal(
        <div
          ref={list}
          id={listId}
          role="listbox"
          className="ui-combo__list"
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          style={position}
          {...{ [LAYER_ATTR]: "listbox" }}
          // Keep DOM focus on the trigger.
          onMouseDown={(event) => event.preventDefault()}
        >
          {flat.map((option, index) => (
            <div key={`${String(option.value)}-${index}`} role="presentation">
              {option.firstInGroup && <div className="ui-combo__group" role="presentation">{option.group}</div>}
              <div
                id={optionId(index)}
                role="option"
                data-value={String(option.value)}
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                className={cx("ui-combo__option", index === active && "ui-combo__option--active", index === selectedIndex && "ui-combo__option--selected")}
                onMouseMove={() => { if (!option.disabled && active !== index) setActive(index); }}
                onClick={() => { if (option.disabled) return; commit(index); close(); }}
              >
                {option.icon && <span className="ui-combo__icon" aria-hidden="true">{option.icon}</span>}
                <span className="ui-combo__option-text">
                  <span className="ui-combo__option-label">{option.label}</span>
                  {option.description && <span className="ui-combo__option-description">{option.description}</span>}
                </span>
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/* --- Editable mode ------------------------------------------------------------ */

function EditableComboBox<V extends ComboValue = string>(props: ComboBoxProps<V>) {
  const {
    value, onChange, options, children, id, name, disabled, placeholder, className, width, onBlur, onFocus, parseText, displayText,
  } = props;
  const items = useMemo(() => (options ?? (optionsFromChildren(children) as unknown as ComboItems<V>)), [options, children]);
  const flat = useMemo(() => flatten(items), [items]);
  const selectedIndex = flat.findIndex((option) => option.value === value || String(option.value) === String(value ?? "\u0000"));
  const shown = displayText ?? (selectedIndex >= 0 ? flat[selectedIndex].text : "");

  const [draft, setDraft] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const box = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const autoId = useId();
  const listId = `${autoId}-list`;
  const optionId = (index: number) => `${autoId}-opt-${index}`;
  const enabledIndexes = flat.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);

  const parse = (text: string): V | null => {
    if (parseText) return parseText(text);
    const needle = text.trim().toLowerCase();
    const match = flat.find((option) => !option.disabled && (option.text.toLowerCase() === needle || String(option.value).toLowerCase() === needle));
    return match ? match.value : null;
  };

  /** Commits typed text (if any). Returns true when something was typed. */
  const commitDraft = () => {
    if (draft === null) return false;
    const next = draft.trim() === shown.trim() ? null : parse(draft);
    setDraft(null);
    if (next !== null) onChange(next);
    return true;
  };
  const choose = (index: number) => {
    const option = flat[index];
    if (!option || option.disabled) return;
    setDraft(null);
    onChange(option.value);
  };
  const openList = () => {
    if (disabled || !flat.length) return;
    setActive(selectedIndex >= 0 && !flat[selectedIndex].disabled ? selectedIndex : -1);
    setPosition({ visibility: "hidden" });
    setOpen(true);
  };
  const close = () => setOpen(false);

  useLightDismiss(list, open, () => close(), { ignore: [box] });

  useLayoutEffect(() => {
    if (!open || !list.current || !box.current) return;
    const anchor = box.current.getBoundingClientRect();
    const view = viewport();
    const listRect = list.current.getBoundingClientRect();
    const height = listRect.height || flat.length * ITEM_HEIGHT + 8;
    const listWidth = Math.max(anchor.width, listRect.width);
    const placed = placeAnchored(anchor, { width: listWidth, height }, "bottom", 4, view);
    const left = Math.max(VIEWPORT_MARGIN, Math.min(placed.left, view.width - listWidth - VIEWPORT_MARGIN));
    setPosition({ top: placed.top, left, minWidth: anchor.width });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLayoutEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const step = (from: number, delta: number) => {
    if (!enabledIndexes.length) return -1;
    const at = enabledIndexes.indexOf(from);
    if (at < 0) return delta > 0 ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1];
    return enabledIndexes[Math.max(0, Math.min(enabledIndexes.length - 1, at + delta))];
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    const { key, altKey } = event;
    if ((altKey && key === "ArrowDown") || key === "F4") {
      event.preventDefault();
      if (open) close(); else openList();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (altKey) { close(); return; }
      if (!open) { openList(); return; }
      // Moving through the list drops what was typed: Enter takes the item.
      setDraft(null);
      setActive(step(active, key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!commitDraft() && open && active >= 0) choose(active);
      close();
      input.current?.select();
      return;
    }
    if (key === "Escape") {
      if (!open && draft === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (open) close();
      else setDraft(null);
      return;
    }
    if (key === "Tab" && open) close();
  };

  const style: CSSProperties | undefined = width !== undefined ? { width: typeof width === "number" ? `${width}px` : width } : undefined;

  return (
    <>
      <span ref={box} className={cx("ui-combo", "ui-combo--editable", disabled && "ui-combo--disabled", className)} style={style} data-tooltip={props["data-tooltip"]}>
        <input
          ref={input}
          id={id}
          type="text"
          role="combobox"
          className="ui-combo__input"
          disabled={disabled}
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          aria-describedby={props["aria-describedby"]}
          aria-autocomplete="none"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
          data-value={value ?? ""}
          spellCheck={false}
          autoComplete="off"
          placeholder={typeof placeholder === "string" ? placeholder : undefined}
          value={draft ?? shown}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onFocus={(event) => { event.currentTarget.select(); onFocus?.(); }}
          onBlur={() => { commitDraft(); close(); onBlur?.(); }}
        />
        <button
          type="button"
          className="ui-combo__button"
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          // Keep focus (and any typing) in the field.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { input.current?.focus(); if (open) close(); else openList(); }}
        >
          <ChevronDown12 className="ui-combo__chevron" aria-hidden="true" />
        </button>
      </span>
      {name !== undefined && <input type="hidden" name={name} value={value === null || value === undefined ? "" : String(value)} />}
      {open && createPortal(
        <div
          ref={list}
          id={listId}
          role="listbox"
          className="ui-combo__list"
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          style={position}
          {...{ [LAYER_ATTR]: "listbox" }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {flat.map((option, index) => (
            <div key={`${String(option.value)}-${index}`} role="presentation">
              {option.firstInGroup && <div className="ui-combo__group" role="presentation">{option.group}</div>}
              <div
                id={optionId(index)}
                role="option"
                data-value={String(option.value)}
                aria-selected={index === selectedIndex}
                aria-disabled={option.disabled || undefined}
                className={cx("ui-combo__option", index === active && "ui-combo__option--active", index === selectedIndex && "ui-combo__option--selected")}
                onMouseMove={() => { if (!option.disabled && active !== index) setActive(index); }}
                onClick={() => { if (option.disabled) return; choose(index); close(); input.current?.select(); }}
              >
                {option.icon && <span className="ui-combo__icon" aria-hidden="true">{option.icon}</span>}
                <span className="ui-combo__option-text">
                  <span className="ui-combo__option-label">{option.label}</span>
                  {option.description && <span className="ui-combo__option-description">{option.description}</span>}
                </span>
              </div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
