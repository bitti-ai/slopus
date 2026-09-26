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

  it("puts each option's value on it as data-value", () => {
    render(<ComboBox<number> aria-label="Steps" value={20} onChange={vi.fn()} options={[{ value: 10, label: "Ten" }, { value: 20, label: "Twenty" }]} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("data-value"))).toEqual(["10", "20"]);
  });

  describe("editable", () => {
    const presets: ComboItems = [{ value: "fit", label: "Fit" }, { value: "0.5", label: "50%" }, { value: "1", label: "100%" }];
    const parsePercent = (text: string) => {
      if (/^\s*fit\s*$/i.test(text)) return "fit";
      const match = /^\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(text);
      if (!match) return null;
      const percent = Number(match[1]);
      return percent >= 10 && percent <= 800 ? String(percent / 100) : null;
    };
    function Zoom({ onChange }: { onChange?: (value: string) => void }) {
      const [value, setValue] = useState("fit");
      const text = value === "fit" ? "Fit" : `${Math.round(Number(value) * 100)}%`;
      return <>
        <ComboBox editable aria-label="Zoom" value={value} displayText={text} parseText={parsePercent} options={presets}
          onChange={(next) => { setValue(next); onChange?.(next); }} />
        <button>After</button>
      </>;
    }
    const field = () => screen.getByRole("combobox", { name: "Zoom" }) as HTMLInputElement;

    it("is a text field showing the display text, with the list on its button", () => {
      const { container } = render(<Zoom />);
      expect(field().tagName).toBe("INPUT");
      expect(field()).toHaveValue("Fit");
      fireEvent.click(container.querySelector(".ui-combo__button")!);
      expect(screen.getByRole("listbox", { name: "Zoom" })).toBeInTheDocument();
      expect(field()).toHaveFocus();
      fireEvent.click(screen.getByRole("option", { name: "50%" }));
      expect(field()).toHaveValue("50%");
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("commits typed text on Enter and on blur, through the validation callback", () => {
      const onChange = vi.fn();
      render(<Zoom onChange={onChange} />);
      field().focus();
      fireEvent.change(field(), { target: { value: "137" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(onChange).toHaveBeenLastCalledWith("1.37");
      expect(field()).toHaveValue("137%");
      fireEvent.change(field(), { target: { value: "250 %" } });
      fireEvent.blur(field());
      expect(onChange).toHaveBeenLastCalledWith("2.5");
      expect(field()).toHaveValue("250%");
    });

    it("rejects invalid text and reverts, and Esc drops what was typed", () => {
      const onChange = vi.fn();
      render(<Zoom onChange={onChange} />);
      field().focus();
      fireEvent.change(field(), { target: { value: "huge" } });
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(onChange).not.toHaveBeenCalled();
      expect(field()).toHaveValue("Fit");
      fireEvent.change(field(), { target: { value: "5000" } });
      fireEvent.blur(field());
      expect(onChange).not.toHaveBeenCalled();
      expect(field()).toHaveValue("Fit");
      fireEvent.change(field(), { target: { value: "75" } });
      fireEvent.keyDown(field(), { key: "Escape" });
      expect(field()).toHaveValue("Fit");
      fireEvent.blur(field());
      expect(onChange).not.toHaveBeenCalled();
    });

    it("opens with Alt+Down, moves with the arrows and picks with Enter", () => {
      const onChange = vi.fn();
      render(<Zoom onChange={onChange} />);
      field().focus();
      fireEvent.keyDown(field(), { key: "ArrowDown", altKey: true });
      expect(field()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("option", { name: "Fit" })).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(field(), { key: "ArrowDown" });
      fireEvent.keyDown(field(), { key: "ArrowDown" });
      expect(field().getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "100%" }).id);
      fireEvent.keyDown(field(), { key: "Enter" });
      expect(onChange).toHaveBeenLastCalledWith("1");
      expect(field()).toHaveAttribute("aria-expanded", "false");
      expect(field()).toHaveValue("100%");
    });

    it("matches option labels by default when there is no parseText", () => {
      const onChange = vi.fn();
      render(<ComboBox editable aria-label="Fruit" value="apple" onChange={onChange} options={fruit} />);
      const input = screen.getByRole("combobox", { name: "Fruit" });
      expect(input).toHaveValue("Apple");
      fireEvent.change(input, { target: { value: "lemon" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith("lemon");
      fireEvent.change(input, { target: { value: "durian" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });
});
