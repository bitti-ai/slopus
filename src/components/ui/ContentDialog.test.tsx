// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentDialog } from "./ContentDialog";

afterEach(cleanup);

function Harness(props: Partial<Parameters<typeof ContentDialog>[0]> & { body?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <ContentDialog
          title="Save changes?"
          primaryText="Save"
          secondaryText="Don't save"
          closeText="Cancel"
          onClose={() => setOpen(false)}
          {...props}
        >
          {props.body ?? "Your edits will be lost."}
        </ContentDialog>
      )}
    </>
  );
}

describe("ContentDialog", () => {
  it("is a labelled modal with buttons in the Windows order", () => {
    render(<ContentDialog title="Delete project?" primaryText="Delete" closeText="Cancel" secondaryText="Archive" onClose={() => {}}>Gone for good.</ContentDialog>);
    const dialog = screen.getByRole("dialog", { name: "Delete project?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("Gone for good.");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Delete", "Archive", "Cancel"]);
    // Rendered into document.body, not inside the caller.
    expect(dialog.closest(".ui-dialog-scrim")?.parentElement).toBe(document.body);
  });

  it("accent-styles the default button and runs it on Enter, but not from a textarea or a button", () => {
    const onPrimary = vi.fn();
    render(<ContentDialog title="Rename" primaryText="Rename" onPrimary={onPrimary} closeText="Cancel" onClose={() => {}} defaultButton="primary">
      <input aria-label="Name" />
      <textarea aria-label="Notes" />
    </ContentDialog>);
    expect(screen.getByRole("button", { name: "Rename" })).toHaveClass("primary-button");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass("secondary-button");
    fireEvent.keyDown(screen.getByLabelText("Notes"), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Enter" });
    expect(onPrimary).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it("does not run a disabled default button", () => {
    const onPrimary = vi.fn();
    render(<ContentDialog title="Go" primaryText="Go" onPrimary={onPrimary} primaryDisabled onClose={() => {}} defaultButton="primary"><input aria-label="x" /></ContentDialog>);
    fireEvent.keyDown(screen.getByLabelText("x"), { key: "Enter" });
    expect(onPrimary).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Go" })).toBeDisabled();
  });

  it("closes on Esc and the Close button but never on a click outside", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    fireEvent.mouseDown(document.querySelector(".ui-dialog-scrim")!);
    fireEvent.click(document.querySelector(".ui-dialog-scrim")!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Open"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("focuses the first field in the body, traps Tab and restores focus on close", () => {
    render(<Harness body={<input aria-label="Name" />} />);
    const opener = screen.getByText("Open");
    opener.focus();
    fireEvent.click(opener);
    const name = screen.getByLabelText("Name");
    expect(name).toHaveFocus();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(name).toHaveFocus();
    fireEvent.keyDown(name, { key: "Tab", shiftKey: true });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(opener).toHaveFocus();
  });

  it("falls back to the default button when the body has nothing to focus", () => {
    render(<Harness defaultButton="secondary" />);
    fireEvent.click(screen.getByText("Open"));
    expect(screen.getByRole("button", { name: "Don't save" })).toHaveFocus();
  });

  it("pulls focus back when it escapes to the page behind", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open"));
    const outside = screen.getByText("Open");
    outside.focus();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("honours a wider max width", () => {
    render(<ContentDialog title="Wide" onClose={() => {}} width={720} />);
    expect(screen.getByRole("dialog").style.maxWidth).toContain("720px");
  });
});
