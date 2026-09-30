// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PromptTextField, type PromptReference } from "./PromptTextField";
import { canCitePromptReference, promptReferenceNames, splitPromptText } from "../../lib/promptReferences";

afterEach(cleanup);

const references: PromptReference[] = [{ id: "hero", name: "Hero", icon: <img alt="" src="data:image/png;base64," data-testid="hero-icon" /> }, { id: "castle", name: "Castle" }, { id: "odd", name: "Odd [v2]" }];

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

it("reads references out of the text as [Name]", () => {
  expect(splitPromptText("A [Hero] at the [Castle].")).toEqual([
    { kind: "text", value: "A " }, { kind: "reference", value: "Hero" }, { kind: "text", value: " at the " },
    { kind: "reference", value: "Castle" }, { kind: "text", value: "." },
  ]);
  expect(splitPromptText("[] and [a\nb] stay text")).toEqual([{ kind: "text", value: "[] and [a\nb] stay text" }]);
  expect(promptReferenceNames("[Hero] meets [Castle] and [Hero]")).toEqual(["Hero", "Castle"]);
  expect(canCitePromptReference("Odd [v2]")).toBe(false);
});

it("shows references as chips, and ones no reference is named as missing", () => {
  const { field } = setup("[Hero] walks to [Tower]");
  const chips = field.querySelectorAll(".prompt-chip");
  expect([...chips].map((chip) => chip.textContent)).toEqual(["Hero", "Tower"]);
  expect(chips[1]).toHaveClass("prompt-chip--missing");
  expect(chips[0]).toHaveAttribute("contenteditable", "false");
  expect(field).toHaveTextContent("Hero walks to Tower");
});

it("inserts the chosen reference at the caret from the toolbar", () => {
  const onInsert = vi.fn();
  const { field, value } = setup("A knight rides", onInsert);
  caretAt(field.firstChild!, 2);
  fireEvent.click(screen.getByRole("button", { name: "Reference" }));
  expect(screen.getByRole("dialog", { name: "Insert a reference" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Odd [v2]" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Hero" })).toContainElement(screen.getByTestId("hero-icon"));
  fireEvent.click(screen.getByRole("button", { name: "Hero" }));
  expect(value()).toBe("A [Hero] knight rides");
  expect(onInsert).toHaveBeenCalledWith(references[0]);
  expect(field.querySelector(".prompt-chip")).toHaveTextContent("Hero");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("adds a reference at the end of a field that was never focused", () => {
  const { value } = setup("Ride to ");
  fireEvent.click(screen.getByRole("button", { name: "Reference" }));
  fireEvent.click(screen.getByRole("button", { name: "Castle" }));
  expect(value()).toBe("Ride to [Castle]");
});

it("opens the picker from a chip to change it or take it out", () => {
  const { field, value } = setup("[Hero] at the [Hero] gate");
  fireEvent.click(field.querySelectorAll(".prompt-chip")[1]);
  expect(screen.getByRole("dialog", { name: "Change reference Hero" })).toHaveTextContent("Cites Hero");
  expect(screen.getByRole("button", { name: "Hero" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Castle" }));
  expect(value()).toBe("[Hero] at the [Castle] gate");

  fireEvent.click(field.querySelectorAll(".prompt-chip")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Remove from the prompt" }));
  expect(value()).toBe(" at the [Castle] gate");
  expect(field.querySelectorAll(".prompt-chip")).toHaveLength(1);
});

it("turns a [Name] typed by hand into a chip and keeps line breaks as text", () => {
  const { field, value } = setup("");
  field.textContent = "Meet [Hero]";
  fireEvent.input(field);
  expect(value()).toBe("Meet [Hero]");
  expect(field.querySelector(".prompt-chip")).toHaveTextContent("Hero");

  field.focus();
  caretAt(field.firstChild!, 4);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(value()).toBe("Meet\n [Hero]");
});

it("pastes only the characters", () => {
  const { field, value } = setup("Hello");
  caretAt(field.firstChild!, 5);
  fireEvent.paste(field, { clipboardData: { getData: (type: string) => type === "text/plain" ? " <b>[Castle]</b>\r\nnext" : "" } });
  expect(value()).toBe("Hello <b>[Castle]</b>\nnext");
});
