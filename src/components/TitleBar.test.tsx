// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  resized: [] as Array<() => void>,
  focus: [] as Array<(event: { payload: boolean }) => void>,
  onResized: vi.fn(async (handler: () => void) => {
    appWindow.resized.push(handler);
    return () => undefined;
  }),
  onFocusChanged: vi.fn(async (handler: (event: { payload: boolean }) => void) => {
    appWindow.focus.push(handler);
    return () => undefined;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));

import { TitleBar } from "./TitleBar";

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  vi.clearAllMocks();
  appWindow.resized = [];
  appWindow.focus = [];
  appWindow.isMaximized.mockResolvedValue(false);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

it("lays out the slots in caption order and defaults the title to Slopus", () => {
  render(
    <TitleBar
      leading={<button type="button">Back</button>}
      secondary="Teaser folder"
      actions={<button type="button">Save</button>}
    >
      <input aria-label="Search" />
    </TitleBar>,
  );
  const bar = screen.getByRole("banner");
  const order = [...bar.querySelectorAll("button, input, .titlebar__title, .titlebar__secondary")]
    .map((element) => element.getAttribute("aria-label") ?? element.textContent);
  expect(order).toEqual(["Back", "Slopus", "Teaser folder", "Search", "Save", "Minimize", "Maximize", "Close"]);
});

it("is one deep drag region, which Tauri's script stops at every control", () => {
  render(<TitleBar title="Product teaser" />);
  const bar = screen.getByRole("banner");
  expect(bar).toHaveAttribute("data-tauri-drag-region", "deep");
  /* The drag script treats a <button> without the attribute as a blocker, so
     none of the caption buttons may carry it. */
  for (const button of screen.getAllByRole("button")) expect(button).not.toHaveAttribute("data-tauri-drag-region");
});

it("draws the Windows caption glyphs and keeps them out of the tab order", () => {
  render(<TitleBar />);
  const minimize = screen.getByRole("button", { name: "Minimize" });
  expect(minimize).toHaveAttribute("tabindex", "-1");
  expect(minimize.textContent).toBe("\uE921");
  expect(screen.getByRole("button", { name: "Close" }).textContent).toBe("\uE8BB");
});

it("can drop or replace the app icon", () => {
  const { container, rerender } = render(<TitleBar />);
  expect(container.querySelector(".titlebar__icon img")).not.toBeNull();
  rerender(<TitleBar icon={false} />);
  expect(container.querySelector(".titlebar__icon")).toBeNull();
  rerender(<TitleBar icon={<svg data-testid="custom" />} />);
  expect(screen.getByTestId("custom")).toBeInTheDocument();
});

it("does nothing outside Tauri", async () => {
  render(<TitleBar />);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await flush();
  expect(appWindow.close).not.toHaveBeenCalled();
});

it("drives the native window and follows its maximized and focus state", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  render(<TitleBar />);
  await flush();

  fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await flush();
  expect(appWindow.minimize).toHaveBeenCalledOnce();
  expect(appWindow.toggleMaximize).toHaveBeenCalledOnce();
  expect(appWindow.close).toHaveBeenCalledOnce();

  appWindow.isMaximized.mockResolvedValue(true);
  await act(async () => { appWindow.resized.forEach((handler) => handler()); });
  await flush();
  const restore = screen.getByRole("button", { name: "Restore" });
  expect(restore.textContent).toBe("\uE923");
  expect(screen.getByRole("banner")).toHaveAttribute("data-maximized", "true");

  await act(async () => { appWindow.focus.forEach((handler) => handler({ payload: false })); });
  expect(screen.getByRole("banner")).toHaveClass("titlebar--inactive");
});
