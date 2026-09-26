// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComboBox, optionsFromChildren, type ComboItems } from "./ComboBox";

afterEach(cleanup);

const fruit: ComboItems = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana", disabled: true },
  { value: "cherry", label: "Cherry", description: "Stone fruit" },
  { label: "Citrus", options: [{ value: "lemon", label: "Lemon" }, { value: "lime", label: "Lime" }] },
];

function Controlled({ initial = "apple", onChange }: { initial?: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="fruit">Fruit</label>
      <ComboBox id="fruit" value={value} onChange={(next) => { setValue(next); onChange?.(next); }} options={fruit} />
      <button>After</button>
    </>
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Fruit" });

describe("ComboBox", () => {
  it("shows the selected label on a labelled combobox trigger", () => {
    render(<Controlled />);
    expect(trigger()).toHaveTextContent("Apple");
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).toHaveAttribute("aria-haspopup", "listbox");
  });

  it("opens a portalled listbox with the selected item marked and picks with the mouse", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    fireEvent.click(trigger());
    const list = screen.getByRole("listbox");
    expect(list.parentElement).toBe(document.body);
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", list.id);
    expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Banana" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Citrus")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Banana" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("option", { name: /Cherry/ }));
    expect(onChange).toHaveBeenCalledWith("cherry");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Cherry");
    expect(trigger()).toHaveFocus();
  });

  it("changes the value with arrows while closed, skipping disabled items, like a native select", () => {
    render(<Controlled />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger()).toHaveTextContent("Cherry");
    fireEvent.keyDown(trigger(), { key: "End" });
    expect(trigger()).toHaveTextContent("Lime");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(trigger()).toHaveTextContent("Lime");
    fireEvent.keyDown(trigger(), { key: "Home" });
    expect(trigger()).toHaveTextContent("Apple");
    fireEvent.keyDown(trigger(), { key: "l" });
    expect(trigger()).toHaveTextContent("Lemon");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens with Alt+Down, F4, Enter or Space and drives the list with aria-activedescendant", () => {
    render(<Controlled />);
    for (const init of [{ key: "ArrowDown", altKey: true }, { key: "F4" }, { key: "Enter" }, { key: " " }]) {
      fireEvent.keyDown(trigger(), init);
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      fireEvent.keyDown(trigger(), { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(trigger()).toHaveFocus();
    }
    fireEvent.keyDown(trigger(), { key: "Enter" });
    const active = () => document.getElementById(trigger().getAttribute("aria-activedescendant")!);
    expect(active()).toHaveTextContent("Apple");
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(active()).toHaveTextContent("Cherry");
    fireEvent.keyDown(trigger(), { key: "End" });
    expect(active()).toHaveTextContent("Lime");
    fireEvent.keyDown(trigger(), { key: "l" });
    expect(active()).toHaveTextContent("Lemon");
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Lemon");
  });

  it("closes without choosing on Tab and on a press outside", () => {
    render(<Controlled />);
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    fireEvent.keyDown(trigger(), { key: "Tab" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger()).toHaveTextContent("Apple");
    fireEvent.click(trigger());
    fireEvent.mouseDown(screen.getByText("After"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps Esc inside itself so a dialog around it stays open", () => {
    const outer = vi.fn();
    render(<div onKeyDown={outer}><Controlled /></div>);
    fireEvent.click(trigger());
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });

  it("reads <option> and <optgroup> children, so a <select> migrates by renaming", () => {
    const onChange = vi.fn();
    render(
      <ComboBox aria-label="Size" value="m" onChange={onChange}>
        <option value="s">Small</option>
        <option value="m">Medium</option>
        <optgroup label="Big"><option value="l">Large</option><option value="xl" disabled>Huge</option></optgroup>
      </ComboBox>,
    );
    const combo = screen.getByRole("combobox", { name: "Size" });
    expect(combo).toHaveTextContent("Medium");
    fireEvent.keyDown(combo, { key: "ArrowDown" });
    expect(onChange).toHaveBeenCalledWith("l");
    expect(optionsFromChildren(<><option value="a">A {"1"}</option></>)).toEqual([{ value: "a", label: ["A ", "1"], disabled: false, textValue: "A 1" }]);
  });

  it("shows a placeholder, and does nothing when disabled", () => {
    const onChange = vi.fn();
    const view = render(<ComboBox aria-label="Pick" value="" onChange={onChange} placeholder="Choose…" options={[{ value: "a", label: "A" }]} />);
    expect(screen.getByRole("combobox")).toHaveTextContent("Choose…");
    view.rerender(<ComboBox aria-label="Pick" value="" onChange={onChange} disabled options={[{ value: "a", label: "A" }]} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works with numeric values", () => {
    const onChange = vi.fn();
    render(<ComboBox<number> aria-label="Steps" value={20} onChange={onChange} options={[{ value: 10, label: "10" }, { value: 20, label: "20" }, { value: 30, label: "30" }]} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledWith(10);
  });
});
