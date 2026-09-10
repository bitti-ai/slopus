// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
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
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  vi.mocked(getRuntimeStatus).mockResolvedValue(detected);
});
afterEach(cleanup);

it("shows startup guidance, opens NVIDIA in the browser, and stays dismissed after checking settings", async () => {
  render(<App />);
  const dialog = await screen.findByRole("dialog", { name: "Install CUDA for faster generation" });
  expect(within(dialog).getByText(/Vulkan fallback backend, with longer generation times/)).toBeInTheDocument();
  const proceed = within(dialog).getByRole("button", { name: "Continue with Vulkan" });
  expect(proceed).toHaveFocus();
  const download = within(dialog).getByRole("link", { name: "Download CUDA from NVIDIA" });
  expect(download).toHaveAttribute("href", "https://developer.nvidia.com/cuda-downloads");
  fireEvent.keyDown(proceed, { key: "Tab" });
  expect(download).toHaveFocus();
  fireEvent.keyDown(download, { key: "Tab", shiftKey: true });
  expect(proceed).toHaveFocus();
  fireEvent.click(download);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_cuda_download", { version: "latest" }));
  fireEvent.click(proceed);
  expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(getRuntimeStatus).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull();
});

it("offers the CUDA 12.8 archive for older RTX cards and allows Escape to proceed after a browser error", async () => {
  vi.mocked(getRuntimeStatus).mockResolvedValue({ ...detected, slopfab: { ...detected.slopfab, cudaDeviceNames: ["NVIDIA GeForce RTX 3080"] } });
  render(<App />);
  const dialog = await screen.findByRole("dialog", { name: "Install CUDA for faster generation" });
  const download = within(dialog).getByRole("link", { name: "Download CUDA 12.8 from NVIDIA" });
  expect(download).toHaveAttribute("href", "https://developer.nvidia.com/cuda-12-8-0-download-archive");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Browser unavailable"));
  fireEvent.click(download);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Browser unavailable");
  expect(invoke).toHaveBeenCalledWith("open_cuda_download", { version: "12.8" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull();
});

it("does not show the popup when CUDA is usable but Vulkan is selected", async () => {
  vi.mocked(getRuntimeStatus).mockResolvedValue({ ...detected, slopfab: { ...detected.slopfab, cudaAvailable: true } });
  render(<App />);
  await screen.findByText("No projects yet");
  expect(screen.queryByRole("dialog", { name: "Install CUDA for faster generation" })).toBeNull();
});
