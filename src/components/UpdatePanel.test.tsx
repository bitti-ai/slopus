// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { AppUpdater } from "../lib/updater";
import { lastCheckedLabel, UpdateInfoBar, UpdatePanel } from "./UpdatePanel";

afterEach(cleanup);
function setup(mode: "installed" | "portable" = "installed") {
  const update = { version: "0.2.0", body: "<b>Release notes</b>", download: vi.fn(async (_listener?: (event: DownloadEvent) => void) => {}), install: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const openReleases = vi.fn(async () => {});
  const updater = new AppUpdater({ mode: async () => mode, openReleases, check: async () => update, relaunch: vi.fn(async () => {}) });
  return { updater, update, openReleases };
}

it("offers manual portable updates even while a project is open", async () => {
  const { updater, update, openReleases } = setup("portable");
  await updater.start();
  render(<UpdatePanel updater={updater} blockReason={() => "Close your project first."} />);
  expect(screen.getByRole("heading", { name: "Slopus 0.2.0 is available" })).toBeInTheDocument();
  expect(screen.queryByText("Close your project first.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Install and restart" })).toBeNull();
  expect(screen.getByText(/download the latest portable ZIP/)).toBeInTheDocument();
  const button = screen.getByRole("button", { name: "Open releases" });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  await waitFor(() => expect(openReleases).toHaveBeenCalledOnce());
  expect(update.download).not.toHaveBeenCalled();
  expect(update.install).not.toHaveBeenCalled();
});

it("opens releases directly from the portable update notification", async () => {
  const { updater, openReleases } = setup("portable");
  await updater.start();
  const onOpen = vi.fn();
  render(<UpdateInfoBar updater={updater} onOpen={onOpen} />);
  expect(screen.getByRole("status")).toHaveTextContent("Slopus 0.2.0 is available to download.");
  fireEvent.click(screen.getByRole("button", { name: "Open releases" }));
  await waitFor(() => expect(openReleases).toHaveBeenCalledOnce());
  expect(onOpen).not.toHaveBeenCalled();
});

it("shows the available version, release notes as text, and blocks installation when a project is open", async () => {
  const { updater, update } = setup();
  await updater.start();
  const view = render(<UpdatePanel updater={updater} blockReason={() => "Close your project before installing an update."} />);
  expect(screen.getByRole("heading", { name: "Slopus 0.2.0 is available" })).toBeInTheDocument();
  expect(screen.getByText(/^Last checked: today/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /What’s new/ }));
  expect(screen.getByText("<b>Release notes</b>").querySelector("b")).toBeNull();
  expect(screen.getByRole("button", { name: "Install and restart" })).toBeDisabled();
  expect(screen.getByText("Close your project before installing an update.")).toBeInTheDocument();
  view.rerender(<UpdatePanel updater={updater} blockReason={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
  await waitFor(() => expect(update.install).toHaveBeenCalledOnce());
});

it("shows download progress inline, without taking over the window, and restores controls after failure", async () => {
  const { updater, update } = setup();
  await updater.start();
  let rejectDownload!: (reason: Error) => void;
  update.download.mockImplementationOnce((listener) => {
    listener?.({ event: "Started", data: {} });
    listener?.({ event: "Progress", data: { chunkLength: 1048576 } });
    return new Promise((_resolve, reject) => { rejectDownload = reject; });
  });
  render(<><UpdatePanel updater={updater} blockReason={() => null} /><UpdateInfoBar updater={updater} onOpen={() => undefined} /></>);
  fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getAllByText("1.0 MB downloaded")).toHaveLength(2);
  expect(screen.getByRole("progressbar", { name: "Update download" })).not.toHaveAttribute("aria-valuenow");
  expect(screen.queryByRole("button", { name: "Install and restart" })).toBeNull();
  await act(async () => { rejectDownload(new Error("Network disconnected")); });
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Network disconnected");
  expect(screen.getByRole("button", { name: "Install and restart" })).toBeEnabled();
  expect(update.install).not.toHaveBeenCalled();
});

it("says when it last checked", () => {
  const now = new Date(2026, 8, 26, 12, 0).getTime();
  expect(lastCheckedLabel(null, now)).toBe("Not checked yet");
  expect(lastCheckedLabel(new Date(2026, 8, 26, 9, 41).getTime(), now)).toMatch(/^Last checked: today, /);
  expect(lastCheckedLabel(new Date(2026, 8, 20, 9, 41).getTime(), now)).not.toMatch(/today/);
});

it("offers the update from the library and can be dismissed", async () => {
  const { updater } = setup();
  await updater.start();
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  render(<UpdateInfoBar updater={updater} onOpen={onOpen} onDismiss={onDismiss} />);
  expect(screen.getByRole("status")).toHaveTextContent("Slopus 0.2.0 is ready to install.");
  fireEvent.click(screen.getByRole("button", { name: "View update" }));
  expect(onOpen).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
