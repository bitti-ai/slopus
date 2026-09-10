// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import { loadGeneratorTemplateSettings } from "../lib/settings";
import { getWeightDownloadState } from "../lib/weightDownloads";
import { WorkQueuePanel } from "./WorkQueuePanel";
import { WorkQueue } from "../lib/workQueue";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
const files = new Set<string>();

beforeEach(() => {
  localStorage.clear(); files.clear(); vi.clearAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "weight_download_hardware") return [{ name: "RTX 5090", memoryBytes: 32 * 1024 ** 3 }];
    if (command === "check_weight_files") return Object.fromEntries((args as { paths: string[] }).paths.map((path) => [path, files.has(path)]));
    if (command === "remove_downloaded_weights") { for (const path of (args as { paths: string[] }).paths) files.delete(path); return; }
    if (command === "download_weight") {
      const path = `C:/Slopus/weights/${(args as { url: string }).url.split('/').at(-1)}`;
      files.add(path); return path;
    }
    return { state: "modelsMissing", dllPath: "slopfab.dll", version: "1.4.0", platform: "Vulkan", detail: "Missing models", models: [] };
  });
});
afterEach(() => { cleanup(); delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

it("keeps downloading with Settings closed and restores progress in the template row and Work Queue", async () => {
  let progress: (event: { payload: { requestId: string; downloaded: number; total: number | null } }) => void = () => undefined;
  vi.mocked(listen).mockImplementation((async (_name, callback) => { progress = callback as typeof progress; return () => undefined; }) as typeof listen);
  const original = vi.mocked(invoke).getMockImplementation()!;
  const pending: { requestId: string; finish: () => void }[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== "download_weight") return original(command, args);
    const request = args as { requestId: string; url: string };
    return new Promise<string>((resolve) => pending.push({ requestId: request.requestId, finish: () => {
      const path = `C:/Slopus/weights/${request.url.split('/').at(-1)}`;
      files.add(path); resolve(path);
    } }));
  });
  const settings = render(<SettingsView onClose={() => settings.unmount()} />);
  fireEvent.click(screen.getByRole("button", { name: "Download generator Minimax H3 Original" }));
  await waitFor(() => expect(pending).toHaveLength(1));
  act(() => progress({ payload: { requestId: pending[0].requestId, downloaded: 50, total: 100 } }));
  const fill = screen.getByRole("progressbar", { name: "Downloading Minimax H3 Original weights" });
  expect(fill.closest(".generator-template-item")).not.toBeNull();
  expect(fill).toHaveStyle({ width: "12.5%" });
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  await act(async () => pending[0].finish());
  await waitFor(() => expect(pending).toHaveLength(2));
  act(() => progress({ payload: { requestId: pending[1].requestId, downloaded: 50, total: 100 } }));
  const queue = new WorkQueue(async (record) => record);
  const panel = render(<WorkQueuePanel queue={queue} items={[]} onClose={() => panel.unmount()} />);
  expect(screen.getByRole("region", { name: "Weight downloads" })).toHaveTextContent("Minimax H3 Original");
  expect(screen.getByRole("progressbar", { name: "Minimax H3 Original download progress" })).toHaveAttribute("value", "37.5");
  expect(screen.queryByText("No work yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close work queue" }));
  const reopened = render(<SettingsView onClose={() => reopened.unmount()} />);
  expect(screen.getByRole("progressbar", { name: "Downloading Minimax H3 Original weights" })).toHaveStyle({ width: "37.5%" });
  reopened.unmount();
  for (let index = 1; index < 4; index++) {
    await waitFor(() => expect(pending.length).toBe(index + 1));
    await act(async () => pending[index].finish());
  }
  await waitFor(() => expect(getWeightDownloadState()?.active).toBe(false));
  expect(getWeightDownloadState()).toMatchObject({ completed: 4, error: null });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "cancel_weight_download")).toBe(false);
  render(<WorkQueuePanel queue={queue} items={[]} onClose={() => undefined} />);
  expect(screen.getByRole("region", { name: "Weight downloads" })).toHaveTextContent("Download complete");
});

it("downloads the sample, enables its default choice, and removes only weights to restore the download action", async () => {
  render(<SettingsView onClose={() => undefined} />);
  const radio = () => screen.getByRole("radio", { name: "Use Minimax H3 Original as the default generator" });
  expect(radio()).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Remove generator Minimax H3 Original" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download generator Minimax H3 Original" }));
  const remove = await screen.findByRole("button", { name: "Remove downloaded weights for Minimax H3 Original" });
  expect(radio()).toBeEnabled();
  fireEvent.click(radio());
  await waitFor(() => expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe("minimax-h3-original"));
  fireEvent.click(remove);
  expect(await screen.findByRole("button", { name: "Download generator Minimax H3 Original" })).toBeEnabled();
  expect(radio()).toBeDisabled();
  expect(files.size).toBe(0);
  expect(loadGeneratorTemplateSettings().templates.find((template) => template.id === "minimax-h3-original")?.paths.transformer).toMatch(/^https:/);
});

it("restores a deleted downloaded file when Settings regains focus", async () => {
  render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Download generator Minimax H3 Original" }));
  await screen.findByRole("button", { name: "Remove downloaded weights for Minimax H3 Original" });
  files.clear();
  fireEvent.focus(window);
  expect(await screen.findByRole("button", { name: "Download generator Minimax H3 Original" })).toBeEnabled();
});

it("stores multiple variants and their GPU and VRAM criteria in the editor", async () => {
  render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Minimax H3 Original generator" }));
  const weight = screen.getByLabelText("Transformer weights").closest(".settings-path")!;
  const details = weight.querySelector("details")!;
  fireEvent.click(within(weight as HTMLElement).getByText("Download variants (1)"));
  details.open = true;
  fireEvent.change(screen.getByLabelText("Add Transformer weights download URL"), { target: { value: "https://example.com/larger.safetensors" } });
  fireEvent.click(within(weight as HTMLElement).getByRole("button", { name: "Add URL" }));
  const gpu = screen.getByLabelText("Transformer weights variant 2 GPU model");
  fireEvent.change(gpu, { target: { value: "RTX 5090" } });
  fireEvent.blur(gpu);
  fireEvent.change(screen.getByLabelText("Transformer weights variant 2 minimum VRAM"), { target: { value: "32" } });
  await waitFor(() => expect(loadGeneratorTemplateSettings().templates.find((template) => template.id === "minimax-h3-original")?.sources?.transformer?.[1]).toMatchObject({ url: "https://example.com/larger.safetensors", gpuModel: "RTX 5090", minVramGb: 32 }));
});
