// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReferenceIconGenerationDialog } from "./ReferenceIconGenerationDialog";

afterEach(cleanup);

it("shows the batch and starts only after an explicit answer", () => {
  const answer = vi.fn();
  render(<ReferenceIconGenerationDialog count={3} onAnswer={answer} />);
  const dialog = screen.getByRole("dialog", { name: "Generate reference icons?" });
  expect(dialog.textContent).toContain("3 references need icons");
  expect(answer).not.toHaveBeenCalled();
  // Windows order: [Primary] [Cancel]; Cancel is the default (Enter).
  expect([...dialog.querySelectorAll("[data-dialog-button]")].map((button) => button.textContent)).toEqual(["Start generation", "Cancel"]);
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("primary-button");
  fireEvent.click(screen.getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start generation" }));
  expect(answer).toHaveBeenCalledWith(true, true);
});

it("remembers Cancel only when the button is explicitly chosen", () => {
  const answer = vi.fn();
  render(<ReferenceIconGenerationDialog count={1} onAnswer={answer} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(answer).toHaveBeenLastCalledWith(false, false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(answer).toHaveBeenLastCalledWith(false, true);
});

it("keeps keyboard focus inside and returns it when dismissed", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const view = render(<ReferenceIconGenerationDialog count={1} onAnswer={vi.fn()} />);
  const checkbox = screen.getByRole("checkbox");
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(checkbox);
  cancel.focus();
  fireEvent.keyDown(cancel, { key: "Tab" });
  expect(document.activeElement).toBe(checkbox);
  fireEvent.keyDown(checkbox, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(cancel);
  view.unmount();
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
