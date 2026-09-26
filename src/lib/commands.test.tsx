// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ariaKeyShortcuts, formatShortcut, isTextEntry, matchesCombo, parseCombo, registerShortcut,
  resetShortcutsForTests, useCommand, useShortcut, type ShortcutOptions,
} from "./commands";

afterEach(() => { cleanup(); resetShortcutsForTests(); });

const press = (key: string, init: Partial<KeyboardEventInit> = {}, target: EventTarget = document.body) =>
  fireEvent.keyDown(target, { key, bubbles: true, cancelable: true, ...init });

describe("combo parsing and matching", () => {
  it("parses modifiers and normalises key names", () => {
    expect(parseCombo("Ctrl+Shift+Z")).toMatchObject({ ctrl: true, shift: true, alt: false, key: "z" });
    expect(parseCombo("Alt+Left").key).toBe("ArrowLeft");
    expect(parseCombo("Del").key).toBe("Delete");
    expect(parseCombo("f2").key).toBe("F2");
    expect(parseCombo("Ctrl++").key).toBe("+");
    expect(parseCombo("Space").key).toBe(" ");
  });

  it("matches letters case-insensitively and modifiers exactly", () => {
    const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(matchesCombo({ ...base, key: "s", ctrlKey: true }, "Ctrl+S")).toBe(true);
    expect(matchesCombo({ ...base, key: "S", ctrlKey: true, shiftKey: true }, "Ctrl+S")).toBe(false);
    expect(matchesCombo({ ...base, key: "Z", ctrlKey: true, shiftKey: true }, "Ctrl+Shift+Z")).toBe(true);
    expect(matchesCombo({ ...base, key: "j" }, "J")).toBe(true);
    expect(matchesCombo({ ...base, key: "F10", shiftKey: true }, "Shift+F10")).toBe(true);
    expect(matchesCombo({ ...base, key: "F10" }, "Shift+F10")).toBe(false);
    expect(matchesCombo({ ...base, key: "ArrowLeft", altKey: true }, "Alt+ArrowLeft")).toBe(true);
    // A shifted symbol does not need "Shift" spelled out.
    expect(matchesCombo({ ...base, key: "?", shiftKey: true }, "?")).toBe(true);
    // Non-Latin layout: the physical code still identifies the letter.
    expect(matchesCombo({ ...base, key: "ы", code: "KeyS", ctrlKey: true }, "Ctrl+S")).toBe(true);
  });

  it("formats for display the way Windows does", () => {
    expect(formatShortcut("ctrl+shift+z")).toBe("Ctrl+Shift+Z");
    expect(formatShortcut("Alt+ArrowLeft")).toBe("Alt+Left");
    expect(formatShortcut("Delete")).toBe("Delete");
    expect(formatShortcut("Escape")).toBe("Esc");
    expect(formatShortcut("space")).toBe("Space");
    expect(formatShortcut(["Ctrl+Y", "Ctrl+Shift+Z"])).toBe("Ctrl+Y, Ctrl+Shift+Z");
    expect(formatShortcut(undefined)).toBe("");
    expect(ariaKeyShortcuts("Ctrl+S")).toBe("Control+S");
  });

  it("knows which elements take typed text", () => {
    const text = document.createElement("input");
    const box = document.createElement("input");
    box.type = "checkbox";
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.append(inner);
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(box)).toBe(false);
    expect(isTextEntry(document.createElement("textarea"))).toBe(true);
    expect(isTextEntry(document.createElement("select"))).toBe(true);
    expect(isTextEntry(inner)).toBe(true);
    expect(isTextEntry(document.createElement("button"))).toBe(false);
  });
});

function Bind({ combo, handler, options, withScope }: { combo: string | string[]; handler: () => void | boolean; options?: ShortcutOptions; withScope?: boolean }) {
  const scope = useRef<HTMLDivElement>(null);
  useShortcut(combo, handler, withScope ? { ...options, scope } : options);
  return <div ref={scope} data-testid={`scope-${String(combo)}`}><button>inside</button></div>;
}

describe("useShortcut", () => {
  it("fires on the window and prevents the default", () => {
    const save = vi.fn();
    render(<Bind combo="Ctrl+S" handler={save} />);
    const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(save).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores presses from text entry unless allowed", () => {
    const remove = vi.fn();
    const undo = vi.fn();
    const view = render(<>
      <Bind combo="Delete" handler={remove} />
      <Bind combo="Ctrl+Z" handler={undo} options={{ allowInInput: true }} />
      <input aria-label="name" />
    </>);
    const input = view.getByLabelText("name");
    press("Delete", {}, input);
    expect(remove).not.toHaveBeenCalled();
    press("z", { ctrlKey: true }, input);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("respects enabled and an already-handled event", () => {
    const handler = vi.fn();
    const view = render(<Bind combo="F2" handler={handler} options={{ enabled: false }} />);
    press("F2");
    expect(handler).not.toHaveBeenCalled();
    view.rerender(<Bind combo="F2" handler={handler} options={{ enabled: true }} />);
    const event = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
    press("F2");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("lets the innermost scope win, then the latest registration", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const later = vi.fn();
    const view = render(<>
      <Bind combo="Delete" handler={outer} />
      <Bind combo={["Delete"]} handler={inner} withScope />
    </>);
    const button = view.getAllByText("inside")[1];
    press("Delete", {}, button);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    // Outside the scope only the global one is eligible.
    press("Delete");
    expect(outer).toHaveBeenCalledTimes(1);

    const stop = registerShortcut("Delete", later);
    press("Delete");
    expect(later).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledTimes(1);
    stop();
    press("Delete");
    expect(outer).toHaveBeenCalledTimes(2);
  });

  it("falls through when a handler declines", () => {
    const first = vi.fn();
    const decline = vi.fn(() => false as const);
    render(<Bind combo="J" handler={first} />);
    registerShortcut("J", decline);
    press("j");
    expect(decline).toHaveBeenCalled();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("mutes unscoped shortcuts behind a modal dialog", () => {
    const handler = vi.fn();
    const modalOk = vi.fn();
    render(<>
      <Bind combo="Ctrl+S" handler={handler} />
      <Bind combo="Ctrl+E" handler={modalOk} options={{ allowInModal: true }} />
      <div role="dialog" aria-modal="true" />
    </>);
    press("s", { ctrlKey: true });
    press("e", { ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
    expect(modalOk).toHaveBeenCalledTimes(1);
  });

  it("stops listening when unmounted", () => {
    const handler = vi.fn();
    const view = render(<Bind combo="F5" handler={handler} />);
    view.unmount();
    press("F5");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("useCommand", () => {
  function Save({ run, disabled }: { run: () => void; disabled?: boolean }) {
    const command = useCommand({ id: "save", label: "Save", shortcut: "Ctrl+S", disabled, run });
    return <button {...command.buttonProps}>{command.label}</button>;
  }

  it("binds the key and describes the button", () => {
    const run = vi.fn();
    const view = render(<Save run={run} />);
    const button = view.getByRole("button", { name: "Save" });
    expect(button).toHaveProperty("dataset.tooltipShortcut", "Ctrl+S");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("Control+S");
    press("s", { ctrlKey: true });
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(2);
    view.rerender(<Save run={run} disabled />);
    press("s", { ctrlKey: true });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
