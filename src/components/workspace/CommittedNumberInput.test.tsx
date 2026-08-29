// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommittedNumberInput } from "./CommittedNumberInput";

afterEach(cleanup);

describe("keyboard-editable number fields", () => {
  it("keeps partial input visible until it becomes a valid transform value", () => {
    const commit = vi.fn();
    render(<CommittedNumberInput aria-label="Scale" value={100} minimum={10} maximum={400} onCommit={commit} />);
    const field = screen.getByRole("spinbutton", { name: "Scale" }) as HTMLInputElement;

    fireEvent.change(field, { target: { value: "" } });
    fireEvent.change(field, { target: { value: "1" } });
    expect(field.value).toBe("1");
    expect(commit).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "125" } });
    expect(field.value).toBe("125");
    expect(commit).toHaveBeenLastCalledWith(125);
  });

  it("clamps a finished edit and accepts a typed negative seed", () => {
    const commit = vi.fn();
    const view = render(<CommittedNumberInput aria-label="Seed" value={20} minimum={2} maximum={50} integer onCommit={commit} />);
    const field = screen.getByRole("spinbutton", { name: "Seed" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "500" } });
    fireEvent.blur(field);
    expect(commit).toHaveBeenLastCalledWith(50);

    view.rerender(<CommittedNumberInput aria-label="Seed" value={-1} minimum={-1} maximum={Number.MAX_SAFE_INTEGER} integer onCommit={commit} />);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.change(field, { target: { value: "-1" } });
    expect(commit).toHaveBeenLastCalledWith(-1);
  });
});
