// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SliderNumberInput, GENERATION_STEPS_RANGE, SIGMA_SHIFT_RANGE } from "./SliderNumberInput";

afterEach(cleanup);
it("synchronizes dragging, keyboard edits and range enforcement without erasing partial input", () => {
  const changed = vi.fn();
  function Harness() {
    const [value, set] = useState(12);
    return <SliderNumberInput aria-label="Sigma" {...SIGMA_SHIFT_RANGE} value={value} onCommit={next => { set(next); changed(next); }} />;
  }
  render(<Harness />);
  const bar = screen.getByRole("slider", { name: "Sigma slider" });
  const field = screen.getByRole("spinbutton", { name: "Sigma" });
  fireEvent.change(bar, { target: { value: "8.5" } });
  expect(field).toHaveValue(8.5);
  fireEvent.change(field, { target: { value: "" } });
  expect(field).toHaveValue(null);
  expect(bar).toHaveValue("8.5");
  fireEvent.change(field, { target: { value: "3.7" } });
  expect(bar).toHaveValue("3.7");
  fireEvent.change(field, { target: { value: "999" } });
  expect(changed).toHaveBeenLastCalledWith(3.7);
  fireEvent.blur(field);
  expect(field).toHaveValue(100);
  expect(bar).toHaveValue("100");
  fireEvent.change(field, { target: { value: "-1" } });
  fireEvent.blur(field);
  expect(field).toHaveValue(0.1);
});

it("keeps integer controls integral and both controls disabled together", () => {
  const changed = vi.fn();
  const view = render(<SliderNumberInput aria-label="Steps" {...GENERATION_STEPS_RANGE} value={20} onCommit={changed} />);
  const field = screen.getByRole("spinbutton");
  fireEvent.change(field, { target: { value: "4.5" } });
  expect(changed).not.toHaveBeenCalled();
  fireEvent.blur(field);
  expect(changed).toHaveBeenLastCalledWith(5);
  view.rerender(<SliderNumberInput aria-label="Steps" {...GENERATION_STEPS_RANGE} value={20} disabled onCommit={changed} />);
  expect(field).toBeDisabled();
  expect(screen.getByRole("slider")).toBeDisabled();
  expect(field).toHaveAttribute("min", "2");
  expect(field).toHaveAttribute("max", "1000");
});
