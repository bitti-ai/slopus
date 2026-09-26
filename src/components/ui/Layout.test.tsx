// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropRow, PropSection } from "./PropRow";
import { SettingsCard, SettingsExpander, SettingsGroup, SettingsRow } from "./Settings";
import { Splitter, usePaneSize } from "./Splitter";
import { placeAnchored, placeAtPoint } from "./internal";

/* jsdom has no PointerEvent, and without one testing-library drops clientX
   and pointerId from pointer events. A MouseEvent carries both. */
if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim;
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function Panes({ reverse = false }: { reverse?: boolean }) {
  const pane = usePaneSize("test.inspector", 300, { min: 200, max: 400 });
  return (
    <div data-testid="grid" style={pane.style}>
      <Splitter {...pane.splitterProps} reverse={reverse} aria-label="Resize inspector" />
    </div>
  );
}

describe("Splitter + usePaneSize", () => {
  it("exposes the size as a CSS variable and a separator value", () => {
    render(<Panes />);
    expect(screen.getByTestId("grid").style.getPropertyValue("--pane-test-inspector")).toBe("300px");
    const separator = screen.getByRole("separator", { name: "Resize inspector" });
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    expect(separator).toHaveAttribute("aria-valuemin", "200");
    expect(separator).toHaveAttribute("aria-valuemax", "400");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
  });

  it("steps with the arrow keys, clamps, persists and resets on double-click", () => {
    const view = render(<Panes />);
    const separator = screen.getByRole("separator");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "308");
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "276");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "400");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "400");
    expect(localStorage.getItem("slopus.pane.test.inspector")).toBe("400");
    view.unmount();
    render(<Panes />);
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "400");
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "300");
  });

  it("drags with the pointer, inverted for a pane after the splitter", () => {
    render(<Panes reverse />);
    const separator = screen.getByRole("separator");
    fireEvent.pointerDown(separator, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 450, pointerId: 1 });
    expect(separator).toHaveAttribute("aria-valuenow", "350");
    expect(separator).toHaveClass("ui-splitter--dragging");
    fireEvent.pointerUp(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { clientX: 300, pointerId: 1 });
    expect(separator).toHaveAttribute("aria-valuenow", "350");
    // Reverse: ArrowLeft grows the pane on the right.
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "358");
  });

  it("survives unusable storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    render(<Panes />);
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "308");
    get.mockRestore();
    set.mockRestore();
  });
});

describe("SettingsCard family", () => {
  it("lays out a labelled card with a control, a clickable card and a link card", () => {
    const open = vi.fn();
    render(
      <SettingsGroup heading="Appearance">
        <SettingsCard icon={<span>i</span>} header="Theme" description="Follow Windows"><button>Pick</button></SettingsCard>
        <SettingsCard header="About" description="Version 1" onClick={open} />
        <SettingsCard header="Docs" href="https://example.com" />
      </SettingsGroup>,
    );
    expect(screen.getByRole("region", { name: "Appearance" })).toBeInTheDocument();
    const card = screen.getByRole("group", { name: "Theme" });
    expect(card).toHaveAccessibleDescription("Follow Windows");
    expect(card).toContainElement(screen.getByRole("button", { name: "Pick" }));
    fireEvent.click(screen.getByRole("button", { name: /About/ }));
    expect(open).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: /Docs/ })).toHaveAttribute("href", "https://example.com");
  });

  it("expands, keeps its header control independent, and supports control", () => {
    const toggled = vi.fn();
    render(
      <SettingsExpander header="GPU" description="Device options" control={<button onClick={toggled}>Enable</button>}>
        <SettingsRow header="Device">cuda:0</SettingsRow>
        <SettingsRow header="Memory">8 GB</SettingsRow>
      </SettingsExpander>,
    );
    const header = screen.getByRole("button", { name: "GPU" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("cuda:0")).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(toggled).toHaveBeenCalled();
    expect(header).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("cuda:0")).toBeVisible();
    expect(screen.getByRole("group", { name: "Memory" })).toBeInTheDocument();
  });

  it("can be controlled", () => {
    function Controlled() {
      const [open, setOpen] = useState(true);
      return <><span>{open ? "open" : "shut"}</span><SettingsExpander header="X" expanded={open} onExpandedChange={setOpen}>body</SettingsExpander></>;
    }
    render(<Controlled />);
    fireEvent.click(screen.getByRole("button", { name: "X" }));
    expect(screen.getByText("shut")).toBeInTheDocument();
  });
});

describe("PropRow + PropSection", () => {
  function Opacity() {
    const [value, setValue] = useState(100);
    return (
      <PropSection title="Transform" persistKey="test.transform">
        <PropRow label="Opacity" htmlFor="opacity" value={value} defaultValue={100} onReset={() => setValue(100)} scrub={{ value, onChange: setValue, min: 0, max: 100 }}>
          <input id="opacity" type="number" value={value} onChange={(event) => setValue(Number(event.target.value))} />
        </PropRow>
      </PropSection>
    );
  }

  it("labels the field, shows reset only when modified, and scrubs from the label", () => {
    render(<Opacity />);
    const field = screen.getByLabelText("Opacity");
    expect(screen.queryByRole("button", { name: "Reset Opacity" })).not.toBeInTheDocument();
    const label = screen.getByText("Opacity");
    expect(label).toHaveClass("ui-prop-row__label--scrub");
    fireEvent.pointerDown(label, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(label, { clientX: 98, pointerId: 1 });   // under the drag threshold
    expect(field).toHaveValue(100);
    fireEvent.pointerMove(label, { clientX: 80, pointerId: 1 });
    expect(field).toHaveValue(80);
    fireEvent.pointerMove(label, { clientX: 79, pointerId: 1, shiftKey: true });
    expect(field).toHaveValue(70);
    fireEvent.pointerMove(label, { clientX: -500, pointerId: 1 });
    expect(field).toHaveValue(0);
    fireEvent.pointerUp(label, { pointerId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Reset Opacity" }));
    expect(field).toHaveValue(100);
    expect(screen.queryByRole("button", { name: "Reset Opacity" })).not.toBeInTheDocument();
  });

  it("collapses its section and remembers it", () => {
    const view = render(<Opacity />);
    const toggle = screen.getByRole("button", { name: "Transform" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("slopus.section.test.transform")).toBe("0");
    view.unmount();
    render(<Opacity />);
    expect(screen.getByRole("button", { name: "Transform" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("placement", () => {
  const view = { width: 800, height: 600 };
  it("opens a menu down-right of the point and flips near the edges", () => {
    expect(placeAtPoint(100, 100, { width: 200, height: 300 }, view)).toEqual({ left: 100, top: 100 });
    expect(placeAtPoint(700, 500, { width: 200, height: 300 }, view)).toEqual({ left: 500, top: 200 });
    // Too big to flip either way: clamped inside the margin.
    expect(placeAtPoint(10, 10, { width: 900, height: 100 }, view).left).toBe(8);
  });

  it("anchors below, flips above, and aligns the end", () => {
    const anchor = { left: 100, top: 100, right: 200, bottom: 132, width: 100, height: 32 };
    expect(placeAnchored(anchor, { width: 150, height: 100 }, "bottom", 4, view)).toEqual({ left: 100, top: 136, placement: "bottom" });
    const low = { ...anchor, top: 550, bottom: 582 };
    expect(placeAnchored(low, { width: 150, height: 100 }, "bottom", 4, view)).toMatchObject({ top: 446, placement: "top" });
    expect(placeAnchored(anchor, { width: 150, height: 100 }, "bottom-end", 4, view)).toMatchObject({ left: 50, placement: "bottom-end" });
    expect(placeAnchored(anchor, { width: 150, height: 100 }, "right", 4, view)).toMatchObject({ left: 204, top: 100, placement: "right" });
  });
});
