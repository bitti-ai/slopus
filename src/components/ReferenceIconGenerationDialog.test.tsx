// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReferenceIconGenerationDialog } from "./ReferenceIconGenerationDialog";

afterEach(cleanup);

it("shows the batch and starts only after an explicit answer", () => {
  const answer = vi.fn();
  render(<ReferenceIconGenerationDialog count={3} onAnswer={answer} />);
  expect(screen.getByRole("alertdialog").textContent).toContain("3 references need icons");
  expect(answer).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start generation" }));
  expect(answer).toHaveBeenCalledWith(true, true);
});

it("remembers Cancel only when the button is explicitly chosen", () => {
  const answer = vi.fn();
  render(<ReferenceIconGenerationDialog count={1} onAnswer={answer} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith(false, false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(answer).toHaveBeenLastCalledWith(false, true);
});

it("traps keyboard focus and returns it when dismissed", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const view = render(<ReferenceIconGenerationDialog count={1} onAnswer={vi.fn()} />);
  const checkbox = screen.getByRole("checkbox");
  const start = screen.getByRole("button", { name: "Start generation" });
  start.focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(document.activeElement).toBe(checkbox);
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(start);
  view.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
