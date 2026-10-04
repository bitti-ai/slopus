import { fireEvent, screen, within } from "@testing-library/react";

/** Choose a standalone reference using the same flyout as the prompt chips. */
export const chooseReference = (label: string, name: string) => {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(within(screen.getByRole("dialog", { name: label })).getByText(name, { exact: true }).closest("button")!);
};

/* PromptTextField is a contenteditable: typing into it is its text and an
   input event, and its value reads each chip back as the token it stands for. */

export const typePrompt = (field: HTMLElement, text: string) => {
  field.textContent = text;
  fireEvent.input(field);
};

/** The value on screen, each chip written back as the token it stands for. */
export const promptValue = (field: HTMLElement, token = (key: string) => `@[ref:${key}]`): string =>
  [...field.childNodes].map((node) => node instanceof HTMLElement && node.dataset.promptReference !== undefined
    ? token(node.dataset.promptReference) : node.textContent ?? "").join("").replaceAll("​", "");

/** The names on a field's chips, in order. */
export const promptChips = (field: HTMLElement): string[] =>
  [...field.querySelectorAll(".prompt-chip")].map((chip) => chip.textContent ?? "");

/** Puts the caret `offset` characters into the field's first text, or at its end. */
export const placePromptCaret = (field: HTMLElement, offset?: number) => {
  const range = document.createRange();
  if (offset === undefined) { range.selectNodeContents(field); range.collapse(false); }
  else { range.setStart(field.firstChild!, offset); range.collapse(true); }
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange"));
};

const option = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) });

/** Inserts a reference with the field's Reference button, at the caret. */
export const insertPromptReference = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Reference" }));
  fireEvent.click(option(name));
};

/** Opens the picker from a field's `index`th chip and picks `name` (or Remove). */
export const changePromptChip = (field: HTMLElement, index: number, name: string | null) => {
  fireEvent.click(field.querySelectorAll(".prompt-chip")[index]);
  fireEvent.click(name === null ? screen.getByRole("button", { name: "Remove from the prompt" }) : option(name));
};
