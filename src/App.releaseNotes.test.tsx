// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { hasSeenReleaseNotes, markReleaseNotesSeen } from "./lib/releaseNotes";
import { APP_VERSION } from "./lib/version";
import { getRuntimeStatus } from "./lib/runtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./lib/persistence", async (original) => ({
  ...await original<typeof import("./lib/persistence")>(),
  isTauri: () => true,
  listRecentProjects: async () => ({ projects: [], unreadable: [] }),
}));
vi.mock("./lib/runtime", async (original) => ({
  ...await original<typeof import("./lib/runtime")>(), getRuntimeStatus: vi.fn(),
}));

const title = `What's new in Slopus ${APP_VERSION}`;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(getRuntimeStatus).mockResolvedValue({ providers: [], slopfab: {
    state: "modelsMissing", dllPath: "slopfab.dll", version: "1.4.0", platform: "CUDA",
    cudaAvailable: true, cudaDeviceNames: [], detail: "Missing models", models: [],
  } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("embeds formatted notes on first launch, then remembers the version across launches", async () => {
  const first = render(<StrictMode><App /></StrictMode>);
  const dialog = screen.getByRole("dialog", { name: title });
  expect(within(dialog).getByRole("heading", { name: "What's new" })).toBeInTheDocument();
  expect(within(dialog).getByRole("heading", { name: "Known limitations" })).toBeInTheDocument();
  expect(within(dialog).getAllByRole("listitem").length).toBeGreaterThan(10);
  expect(within(dialog).getByText("24 GB of VRAM or more is recommended").tagName).toBe("STRONG");
  expect(within(dialog).getByText("Slopus.exe").tagName).toBe("CODE");
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  expect(hasSeenReleaseNotes()).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog", { name: title })).toBeNull();
  first.unmount();
  render(<App />);
  await screen.findByText("No projects yet");
  expect(screen.queryByRole("dialog", { name: title })).toBeNull();
});

it("shows a new version even when an earlier release has been seen", () => {
  markReleaseNotesSeen("0.0.1");
  render(<App />);
  const dialog = screen.getByRole("dialog", { name: title });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: title })).toBeNull();
  expect(hasSeenReleaseNotes()).toBe(true);
  expect(hasSeenReleaseNotes("0.0.1")).toBe(true);
});

it("reopens from Settings Updates even when automatic updates are unavailable", async () => {
  markReleaseNotesSeen();
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Updates" }));
  const open = screen.getByRole("button", { name: "View release notes" });
  open.focus();
  fireEvent.click(open);
  const dialog = screen.getByRole("dialog", { name: title });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: title })).toBeNull();
  expect(open).toHaveFocus();
  fireEvent.click(open);
  expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
  await screen.findByRole("heading", { name: "Updates aren’t available in this copy" });
});

it("shows CUDA guidance after the release notes, without overlapping startup dialogs", async () => {
  vi.mocked(getRuntimeStatus).mockResolvedValue({
    providers: [],
    slopfab: { state: "modelsMissing", dllPath: "slopfab.dll", version: "1.4.0", platform: "Vulkan", cudaAvailable: false, cudaDeviceNames: ["NVIDIA GeForce RTX 5090"], detail: "Missing models", models: [] },
  });
  render(<App />);
  await waitFor(() => expect(getRuntimeStatus).toHaveBeenCalled());
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: "Done" }));
  await screen.findByRole("dialog", { name: "Install CUDA for faster generation" });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

it("can still read and dismiss notes when storage is unavailable", () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  expect(hasSeenReleaseNotes()).toBe(false);
  read.mockRestore();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
  render(<App />);
  fireEvent.click(within(screen.getByRole("dialog", { name: title })).getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("dialog", { name: title })).toBeNull();
});
