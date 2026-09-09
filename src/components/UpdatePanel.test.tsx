// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { AppUpdater } from "../lib/updater";
import { UpdatePanel, UpdateProgress } from "./UpdatePanel";

afterEach(cleanup);
function setup() {
  const update = { version: "0.2.0", body: "<b>Release notes</b>", download: vi.fn(async (_listener?: (event: DownloadEvent) => void) => {}), install: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const updater = new AppUpdater({ enabled: async () => true, check: async () => update, relaunch: vi.fn(async () => {}) });
  return { updater, update };
}

it("shows release notes as text and blocks installation when a project is open", async () => {
  const { updater, update } = setup();
  await updater.start();
  const view = render(<UpdatePanel updater={updater} blockReason={() => "Close your project before installing an update."} />);
  expect(screen.getByText("<b>Release notes</b>").querySelector("b")).toBeNull();
  expect(screen.getByRole("button", { name: "Install and restart" })).toBeDisabled();
  view.rerender(<UpdatePanel updater={updater} blockReason={() => null} />);
  fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
  await waitFor(() => expect(update.install).toHaveBeenCalledOnce());
});

it("shows download progress in a blocking dialog and restores controls after failure", async () => {
  const { updater, update } = setup();
  await updater.start();
  let rejectDownload!: (reason: Error) => void;
  update.download.mockImplementationOnce((listener) => {
    listener?.({ event: "Started", data: {} });
    listener?.({ event: "Progress", data: { chunkLength: 1048576 } });
    return new Promise((_resolve, reject) => { rejectDownload = reject; });
  });
  render(<><UpdatePanel updater={updater} blockReason={() => null} /><UpdateProgress updater={updater} /></>);
  fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
  expect(screen.getByRole("dialog", { name: "Updating Slopus" })).toHaveFocus();
  expect(screen.getByText("1.0 MB downloaded")).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).not.toHaveAttribute("value");
  await act(async () => { rejectDownload(new Error("Network disconnected")); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("Network disconnected");
  expect(screen.getByRole("button", { name: "Install and restart" })).toBeEnabled();
  expect(update.install).not.toHaveBeenCalled();
});
