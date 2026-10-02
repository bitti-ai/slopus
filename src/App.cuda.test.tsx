// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { markReleaseNotesSeen } from "./lib/releaseNotes";
import { getRuntimeStatus, type RuntimeStatus } from "./lib/runtime";

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

const detected: RuntimeStatus = {
  providers: [],
  slopfab: { state: "modelsMissing", dllPath: "slopfab.dll", version: "1.4.0", platform: "Vulkan", cudaAvailable: false, cudaDeviceNames: ["NVIDIA GeForce RTX 5090"], detail: "Missing models", models: [] },
};

beforeEach(() => {
  localStorage.clear();
  markReleaseNotesSeen();
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(getRuntimeStatus).mockResolvedValue(detected);
});
afterEach(cleanup);

it("shows startup guidance, opens NVIDIA in the browser, and stays dismissed after checking settings", async () => {
  render(<App />);
  const dialog = await screen.findByRole("dialog", { name: "Install CUDA for faster generation" });
  expect(within(dialog).getByText(/Vulkan fallback backend, with longer generation times/)).toBeInTheDocument();
  expect(within(dialog).getByText(/RTX 5090/)).toBeInTheDocument();
  const download = within(dialog).getByRole("button", { name: "Download CUDA" });
  const proceed = within(dialog).getByRole("button", { name: "Continue with Vulkan" });
  // [Primary] [Close]: Download is the default (Enter), Continue is Esc.
  expect(download).toHaveFocus();
  // Tab wraps inside the dialog; the step between the two is the browser's.
  proceed.focus();
  fireEvent.keyDown(proceed, { key: "Tab" });
  expect(download).toHaveFocus();
  fireEvent.keyDown(download, { key: "Tab", shiftKey: true });
  expect(proceed).toHaveFocus();
  fireEvent.click(download);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_cuda_download", { version: "latest" }));
  // Opening the page answers the question.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.keyDown(screen.getByRole("main", { name: "Settings" }), { key: "Escape" });
  expect(screen.queryByRole("main", { name: "Settings" })).toBeNull();
  await waitFor(() => expect(getRuntimeStatus).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull();
});

it("offers the CUDA 12.8 archive for older RTX cards and allows Escape to proceed after a browser error", async () => {
  vi.mocked(getRuntimeStatus).mockResolvedValue({ ...detected, slopfab: { ...detected.slopfab, cudaDeviceNames: ["NVIDIA GeForce RTX 3080"] } });
  render(<App />);
  const dialog = await screen.findByRole("dialog", { name: "Install CUDA for faster generation" });
  const download = within(dialog).getByRole("button", { name: "Download CUDA 12.8" });
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Browser unavailable"));
  fireEvent.click(download);
  const alert = await within(dialog).findByRole("alert");
  expect(alert).toHaveTextContent("Browser unavailable");
  // The address is still there to type in by hand.
  expect(alert).toHaveTextContent("https://developer.nvidia.com/cuda-12-8-0-download-archive");
  expect(invoke).toHaveBeenCalledWith("open_cuda_download", { version: "12.8" });
  fireEvent.keyDown(download, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull();
});

it("does not show the popup when CUDA is usable but Vulkan is selected", async () => {
  vi.mocked(getRuntimeStatus).mockResolvedValue({ ...detected, slopfab: { ...detected.slopfab, cudaAvailable: true } });
  render(<App />);
  await screen.findByText("No projects yet");
  expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull();
});
