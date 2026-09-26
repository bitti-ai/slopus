/* Test helpers for the Fluent ComboBox, which replaced native <select>s in the
   workspace screens. A ComboBox is a button (role="combobox") with a portal
   listbox, so `fireEvent.change(select, { target: { value } })` no longer
   works: open it and click the option by its visible name instead. Its
   current value is on the trigger as `data-value`. */

import { fireEvent, screen, within } from "@testing-library/react";

/** The open list of `combobox` (its aria-controls), so options elsewhere on
 *  the page — a library listbox, another menu — never match. */
const listOf = (combobox: HTMLElement) => {
  const id = combobox.getAttribute("aria-controls");
  const list = id ? document.getElementById(id) : null;
  return list ? within(list) : screen;
};

/** Open `combobox` and click the option named `option`. */
export function chooseOption(combobox: HTMLElement, option: string | RegExp): void {
  fireEvent.click(combobox);
  fireEvent.click(listOf(combobox).getByRole("option", { name: option }));
}

/** Open the combobox named `name` and click the option named `option`. */
export function choose(name: string | RegExp, option: string | RegExp): void {
  chooseOption(screen.getByRole("combobox", { name }), option);
}

/** The option labels a combobox offers (opens and closes it). */
export function optionNames(combobox: HTMLElement): string[] {
  fireEvent.click(combobox);
  const names = listOf(combobox).getAllByRole("option").map((option) => option.textContent ?? "");
  fireEvent.click(combobox);
  return names;
}

/** The value currently selected in a ComboBox. */
export const comboValue = (combobox: HTMLElement): string => combobox.getAttribute("data-value") ?? "";
