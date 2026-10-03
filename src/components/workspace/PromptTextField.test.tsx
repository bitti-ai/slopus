// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PromptTextField, type PromptReference } from "./PromptTextField";
import { referenceTypeLabel, type ProjectReference } from "../../lib/project";

afterEach(cleanup);

const references: PromptReference[] = [
  { id: "hero", name: "Hero", icon: <img alt="" src="data:image/png;base64," data-testid="hero-icon" /> },
  { id: "castle", name: "Castle" },
  { id: "odd]", name: "Odd" },
];

function setup(initial: string, onInsertReference = vi.fn()) {
  let latest = initial;
  function Harness() {
    const [value, setValue] = useState(initial);
    latest = value;
    return <PromptTextField aria-label="Prompt" value={value} onChange={setValue} references={references} onInsertReference={onInsertReference} />;
  }
  render(<Harness />);
  return { value: () => latest, field: screen.getByRole("textbox", { name: "Prompt" }) };
}

const caretAt = (node: Node, offset: number) => {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
};

const selectRange = (start: Node, startOffset: number, end: Node, endOffset: number) => {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
};
const clipboard = () => {
  const data = new Map<string, string>();
  return { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
};

it.each(["", "\n"])("copies multiline prompts with chip IDs into another field (ending: %j)", (ending) => {
  const initial = `Meet @[ref:hero]\n@[ref:castle] with @[ref:hero] and @[ref:missing]${ending}`;
  const onInsert = vi.fn();
  let pasted = "Before after";
  const renamed = references.map((reference) => ({ ...reference, name: `${reference.name} renamed` }));
  function Harness() {
    const [target, setTarget] = useState(pasted);
    pasted = target;
    return <>
      <PromptTextField aria-label="Source" value={initial} onChange={vi.fn()} references={references} />
      <PromptTextField aria-label="Target" value={target} onChange={setTarget} references={renamed} onInsertReference={onInsert} />
    </>;
  }
  render(<Harness />);
  const source = screen.getByRole("textbox", { name: "Source" });
  const target = screen.getByRole("textbox", { name: "Target" });
  const clipboardData = clipboard();
  selectRange(source, 0, source, source.childNodes.length);
  fireEvent.copy(source, { clipboardData });
  expect(clipboardData.getData("text/plain")).toBe(initial);
  expect(clipboardData.getData("text/plain")).not.toContain("\u200b");
  selectRange(target.firstChild!, 7, target.firstChild!, 12);
  fireEvent.paste(target, { clipboardData });
  expect(pasted).toBe(`Before ${initial}`);
  expect([...target.querySelectorAll(".prompt-chip")].map((chip) => chip.textContent)).toEqual(["Hero renamed", "Castle renamed", "Hero renamed", "Deleted reference"]);
  expect(onInsert.mock.calls.map(([reference]) => reference.id)).toEqual(["hero", "castle"]);
  expect(target).toHaveFocus();
  // Further typing belongs after the inserted prompt, not before its chips.
  fireEvent.paste(target, { clipboardData: { getData: () => " Next" } });
  expect(pasted).toBe(`Before ${initial} Next`);
});

it("cuts only the selected text and chips and can paste them back at the cut position", () => {
  const initial = "Before @[ref:hero] after @[ref:castle].";
  const { field, value } = setup(initial);
  const clipboardData = clipboard();
  selectRange(field.firstChild!, 3, field.lastChild!, 1);
  fireEvent.cut(field, { clipboardData });
  expect(clipboardData.getData("text/plain")).toBe("ore @[ref:hero] after @[ref:castle].");
  expect(value()).toBe("Bef");
  expect(field.querySelectorAll(".prompt-chip")).toHaveLength(0);
  fireEvent.paste(field, { clipboardData });
  expect(value()).toBe(initial);
  expect(field.querySelectorAll(".prompt-chip")).toHaveLength(2);
});

it("treats a partial chip-label selection as one complete reference when copying, cutting or replacing", () => {
  const { field, value } = setup("Start @[ref:hero] end");
  const clipboardData = clipboard();
  const label = field.querySelector(".prompt-chip")!.firstChild!;
  selectRange(label, 1, label, 3);
  fireEvent.copy(field, { clipboardData });
  expect(clipboardData.getData("text/plain")).toBe("@[ref:hero]");
  fireEvent.cut(field, { clipboardData });
  expect(value()).toBe("Start  end");
  fireEvent.paste(field, { clipboardData });
  expect(value()).toBe("Start @[ref:hero] end");
  const restoredLabel = field.querySelector(".prompt-chip")!.firstChild!;
  selectRange(restoredLabel, 1, restoredLabel, 3);
  fireEvent.paste(field, { clipboardData: { getData: () => "@[ref:castle]" } });
  expect(value()).toBe("Start @[ref:castle] end");
});

it("allows copying a disabled prompt but prevents cut and paste from changing it", () => {
  const onChange = vi.fn();
  render(<PromptTextField aria-label="Prompt" value="@[ref:hero]" onChange={onChange} references={references} disabled />);
  const field = screen.getByRole("textbox", { name: "Prompt" });
  const clipboardData = clipboard();
  selectRange(field, 0, field, field.childNodes.length);
  fireEvent.copy(field, { clipboardData });
  expect(clipboardData.getData("text/plain")).toBe("@[ref:hero]");
  fireEvent.cut(field, { clipboardData });
  fireEvent.paste(field, { clipboardData });
  expect(onChange).not.toHaveBeenCalled();
});

it("leaves the clipboard alone when there is no selection", () => {
  const { field, value } = setup("Hello @[ref:hero]");
  const clipboardData = clipboard();
  clipboardData.setData("text/plain", "Previous clipboard");
  caretAt(field.firstChild!, 2);
  fireEvent.copy(field, { clipboardData });
  fireEvent.cut(field, { clipboardData });
  expect(clipboardData.getData("text/plain")).toBe("Previous clipboard");
  expect(value()).toBe("Hello @[ref:hero]");
});

it("shows cited references as chips by name, and a deleted one as missing", () => {
  const { field } = setup("@[ref:hero] walks to @[ref:tower]");
  const chips = field.querySelectorAll(".prompt-chip");
  expect([...chips].map((chip) => chip.textContent)).toEqual(["Hero", "Deleted reference"]);
  expect(chips[1]).toHaveClass("prompt-chip--missing");
  expect(chips[0]).toHaveAttribute("contenteditable", "false");
  expect(field).toHaveTextContent("Hero walks to Deleted reference");
});

it("inserts the chosen reference at the caret from the toolbar, never fused to a word", () => {
  const onInsert = vi.fn();
  const { field, value } = setup("A knight rides", onInsert);
  caretAt(field.firstChild!, 2);
  fireEvent.click(screen.getByRole("button", { name: "Reference" }));
  expect(screen.getByRole("dialog", { name: "Insert a reference" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Odd" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Hero" })).toContainElement(screen.getByTestId("hero-icon"));
  fireEvent.click(screen.getByRole("button", { name: "Hero" }));
  expect(value()).toBe("A @[ref:hero] knight rides");
  expect(onInsert).toHaveBeenCalledWith(references[0]);
  expect(field.querySelector(".prompt-chip")).toHaveTextContent("Hero");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("adds a reference at the end of a field that was never focused", () => {
  const { value } = setup("Ride to ");
  fireEvent.click(screen.getByRole("button", { name: "Reference" }));
  fireEvent.click(screen.getByRole("button", { name: "Castle" }));
  expect(value()).toBe("Ride to @[ref:castle]");
});

it("opens the picker from a chip to change it or take it out", () => {
  const { field, value } = setup("@[ref:hero] at the @[ref:hero] gate");
  fireEvent.click(field.querySelectorAll(".prompt-chip")[1]);
  expect(screen.getByRole("dialog", { name: "Change reference Hero" })).toHaveTextContent("Cites Hero");
  expect(screen.getByRole("button", { name: "Hero" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Castle" }));
  expect(value()).toBe("@[ref:hero] at the @[ref:castle] gate");

  fireEvent.click(field.querySelectorAll(".prompt-chip")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Remove from the prompt" }));
  expect(value()).toBe(" at the @[ref:castle] gate");
  expect(field.querySelectorAll(".prompt-chip")).toHaveLength(1);
});

it("turns a token pasted or typed by hand into a chip and keeps line breaks as text", () => {
  const { field, value } = setup("");
  field.textContent = "Meet @[ref:hero]";
  fireEvent.input(field);
  expect(value()).toBe("Meet @[ref:hero]");
  expect(field.querySelector(".prompt-chip")).toHaveTextContent("Hero");

  field.focus();
  caretAt(field.firstChild!, 4);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(value()).toBe("Meet\n @[ref:hero]");
});

it("pastes only the characters", () => {
  const { field, value } = setup("Hello");
  caretAt(field.firstChild!, 5);
  fireEvent.paste(field, { clipboardData: { getData: (type: string) => type === "text/plain" ? " <b>@[ref:castle]</b>\r\nnext" : "" } });
  expect(value()).toBe("Hello <b>@[ref:castle]</b>\nnext");
});

it("names a refmod reference as a refmod, whatever else it holds", () => {
  const base = { description: "", intendedUse: [], createdAt: "2026-01-01T00:00:00.000Z" };
  const refmods = [{ id: "encoded", name: "Identity", sourcePath: "D:/identity.safetensors", strength: 1, copies: 1 }];
  expect(referenceTypeLabel({ ...base, id: "a", kind: "text", name: "A", refmods } as ProjectReference)).toBe("Refmod");
  expect(referenceTypeLabel({ ...base, id: "b", kind: "image", name: "B", relativePath: "b.png", refmods } as ProjectReference)).toBe("Refmod");
  expect(referenceTypeLabel({ ...base, id: "c", kind: "image", name: "C", relativePath: "c.png" } as ProjectReference)).toBe("Image");
  expect(referenceTypeLabel({ ...base, id: "d", kind: "text", name: "D" } as ProjectReference)).toBe("Text");
});
