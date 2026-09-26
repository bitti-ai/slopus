// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContextMenu, type MenuEntry } from "./ContextMenu";

afterEach(cleanup);

function Surface({ items, label = "Clip actions" }: { items: MenuEntry[]; label?: string }) {
  const menu = useContextMenu();
  return (
    <>
      <div
        tabIndex={0}
        data-testid="surface"
        onContextMenu={(event) => menu.open(event, items, { "aria-label": label })}
        onKeyDown={(event) => { if (event.key === "F10" && event.shiftKey) menu.open(event, items, { "aria-label": label }); }}
      >
        surface
      </div>
      <button>elsewhere</button>
      {menu.element}
    </>
  );
}

const make = () => {
  const rename = vi.fn();
  const copy = vi.fn();
  const remove = vi.fn();
  const snap = vi.fn();
  const items: MenuEntry[] = [
    { id: "rename", label: "Rename", icon: <span>R</span>, shortcut: "F2", onSelect: rename },
    { id: "copy", label: "Copy", shortcut: "Ctrl+C", onSelect: copy },
    { id: "paste", label: "Paste", disabled: true, onSelect: vi.fn() },
    { separator: true },
    { id: "snap", label: "Snap to grid", checked: true, onSelect: snap },
    { id: "delete", label: "Delete", shortcut: "Delete", danger: true, onSelect: remove },
  ];
  return { items, rename, copy, remove, snap };
};

describe("ContextMenu", () => {
  it("opens at the pointer, labelled, with formatted accelerators, separators and checks", () => {
    const { items } = make();
    render(<Surface items={items} />);
    fireEvent.contextMenu(screen.getByTestId("surface"), { clientX: 40, clientY: 50 });
    const menu = screen.getByRole("menu", { name: "Clip actions" });
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole("menuitem", { name: /Copy/ })).toHaveTextContent("Ctrl+C");
    expect(screen.getByRole("menuitem", { name: /Paste/ })).toBeDisabled();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Snap/ })).toHaveAttribute("aria-checked", "true");
    // Opened with the mouse: the menu holds focus, not the first item.
    expect(menu).toHaveFocus();
  });

  it("focuses the first item when opened from the keyboard, and navigates skipping disabled items", () => {
    const { items } = make();
    render(<Surface items={items} />);
    const surface = screen.getByTestId("surface");
    surface.focus();
    fireEvent.keyDown(surface, { key: "F10", shiftKey: true });
    const rename = screen.getByRole("menuitem", { name: /Rename/ });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(rename, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitemcheckbox", { name: /Snap/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(rename).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "c" });
    expect(screen.getByRole("menuitem", { name: /Copy/ })).toHaveFocus();
  });

  it("runs an item on click or Enter, closes, and returns focus to the opener", () => {
    const { items, rename, copy } = make();
    render(<Surface items={items} />);
    const surface = screen.getByTestId("surface");
    surface.focus();
    fireEvent.keyDown(surface, { key: "F10", shiftKey: true });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(surface).toHaveFocus();
    fireEvent.contextMenu(surface, { clientX: 5, clientY: 5 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy/ }));
    expect(copy).toHaveBeenCalledTimes(1);
  });

  it("honours an item's own shortcut while open", () => {
    const { items, remove } = make();
    render(<Surface items={items} />);
    fireEvent.contextMenu(screen.getByTestId("surface"), { clientX: 5, clientY: 5 });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Delete" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on Esc (anywhere), Tab, and a press outside, without running anything", () => {
    const { items, rename, copy, remove } = make();
    render(<Surface items={items} />);
    const surface = screen.getByTestId("surface");
    fireEvent.contextMenu(surface, { clientX: 5, clientY: 5 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.contextMenu(surface, { clientX: 5, clientY: 5 });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.contextMenu(surface, { clientX: 5, clientY: 5 });
    fireEvent.pointerDown(screen.getByText("elsewhere"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(rename).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not let keys leak to the surface behind it", () => {
    const { items } = make();
    const behind = vi.fn();
    render(<div onKeyDown={behind}><Surface items={items} /></div>);
    fireEvent.contextMenu(screen.getByTestId("surface"), { clientX: 5, clientY: 5 });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(behind).not.toHaveBeenCalled();
  });
});
