// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluentRuntime, TOOLTIP_BETWEEN_DELAY, TOOLTIP_DELAY, TooltipLayer, tooltipProps } from "./Tooltip";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

function Page() {
  return (
    <>
      <TooltipLayer />
      <button aria-label="Split" {...tooltipProps("Split clip", "s")}>A</button>
      <button aria-label="Trim" {...tooltipProps("Trim")}>B</button>
      <button>plain</button>
    </>
  );
}

describe("tooltipProps", () => {
  it("spells the data attributes, formatting the shortcut", () => {
    expect(tooltipProps("Save", "ctrl+s")).toEqual({ "data-tooltip": "Save", "data-tooltip-shortcut": "Ctrl+S" });
    expect(tooltipProps("Save")).toEqual({ "data-tooltip": "Save" });
    expect(tooltipProps(undefined)).toEqual({});
  });
});

describe("TooltipLayer", () => {
  it("shows after the hover delay with the shortcut in its own span", () => {
    render(<Page />);
    fireEvent.mouseOver(screen.getByText("A"), { clientX: 10, clientY: 10 });
    advance(TOOLTIP_DELAY - 10);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    advance(20);
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Split clipS");
    expect(tip.querySelector(".ui-tooltip__shortcut")).toHaveTextContent("S");
    expect(tip.parentElement).toBe(document.body);
    // The element's name already differs from the tooltip text, so it is described by it.
    expect(screen.getByText("A")).toHaveAttribute("aria-describedby", tip.id);
  });

  it("moves between tooltips quickly and hides on leave, press, Esc", () => {
    render(<Page />);
    fireEvent.mouseOver(screen.getByText("A"));
    advance(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Split clip");
    fireEvent.mouseOut(screen.getByText("A"), { relatedTarget: screen.getByText("B") });
    fireEvent.mouseOver(screen.getByText("B"));
    advance(TOOLTIP_BETWEEN_DELAY);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Trim");

    fireEvent.mouseDown(screen.getByText("B"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.mouseOver(screen.getByText("plain"));
    fireEvent.mouseOver(screen.getByText("A"));
    advance(TOOLTIP_DELAY);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    advance(1000);
    fireEvent.mouseOver(screen.getByText("B"));
    advance(TOOLTIP_DELAY);
    fireEvent.mouseOut(screen.getByText("B"), { relatedTarget: document.body });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not show if the pointer leaves before the delay", () => {
    render(<Page />);
    fireEvent.mouseOver(screen.getByText("A"));
    advance(200);
    fireEvent.mouseOut(screen.getByText("A"), { relatedTarget: screen.getByText("plain") });
    fireEvent.mouseOver(screen.getByText("plain"));
    advance(TOOLTIP_DELAY);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows on keyboard focus and hides on blur", () => {
    render(<Page />);
    fireEvent.keyDown(document.body, { key: "Tab" });
    const a = screen.getByText("A");
    act(() => a.focus());
    advance(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Split clip");
    act(() => a.blur());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not describe an element whose name already is the tooltip", () => {
    render(<><TooltipLayer /><button aria-label="Trim" data-tooltip="Trim">x</button></>);
    fireEvent.mouseOver(screen.getByText("x"));
    advance(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(screen.getByText("x")).not.toHaveAttribute("aria-describedby");
  });
});

describe("TooltipLayer and popups", () => {
  it("hides on right-click and shows nothing behind an open menu, only inside it", () => {
    render(<><TooltipLayer />
      <button data-tooltip="Open project">card</button>
      <div data-ui-layer="menu" role="menu" aria-label="Card actions"><button data-tooltip="Delete for good">Delete</button></div>
    </>);
    // A menu is open: the card behind it gets no tooltip, even after the delay.
    fireEvent.mouseOver(screen.getByText("card"));
    advance(TOOLTIP_DELAY * 2);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    // An item inside the menu still does.
    fireEvent.mouseOver(screen.getByText("Delete"));
    advance(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Delete for good");
  });

  it("drops a pending tooltip when a menu opens before it shows, and on contextmenu", () => {
    const { rerender } = render(<><TooltipLayer /><button data-tooltip="Open project">card</button></>);
    fireEvent.mouseOver(screen.getByText("card"));
    advance(TOOLTIP_DELAY);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText("card"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    // Pointer rests on the card again, and a menu appears before the delay runs out.
    fireEvent.mouseOut(screen.getByText("card"));
    fireEvent.mouseOver(screen.getByText("card"));
    rerender(<><TooltipLayer /><button data-tooltip="Open project">card</button><div data-ui-layer="menu" role="menu" /></>);
    advance(TOOLTIP_DELAY);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});

describe("FluentRuntime", () => {
  it("mounts the tooltip layer and fills every slider", () => {
    render(<><FluentRuntime /><input type="range" aria-label="Volume" defaultValue="25" /></>);
    expect(screen.getByLabelText("Volume").style.getPropertyValue("--p")).toBe("25%");
    fireEvent.mouseOver(screen.getByLabelText("Volume"));
  });
});
