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
import { loadLoras, TAOMATE_LORA } from "../lib/loras";

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

it("downloads TaoMate and persists manual adapters, activation, strength and order per template", async () => {
  const settings = render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Download LoRA TaoMate 3-Step" }));
  await waitFor(() => expect(loadLoras()[0].path).not.toBe(""));
  fireEvent.click(screen.getByRole("button", { name: "Add LoRA manually" }));
  fireEvent.change(screen.getByLabelText("LoRA name"), { target: { value: "My style" } });
  fireEvent.change(screen.getByLabelText("LoRA path"), { target: { value: "D:/models/style.safetensors" } });
  fireEvent.click(screen.getByRole("button", { name: "Add local LoRA" }));
  const manual = loadLoras().find(({ name }) => name === "My style")!;
  fireEvent.click(screen.getByRole("button", { name: "Edit Default generator" }));
  fireEvent.change(screen.getByLabelText("Add LoRA to generator"), { target: { value: TAOMATE_LORA.id } });
  fireEvent.change(screen.getByLabelText("Add LoRA to generator"), { target: { value: manual.id } });
  fireEvent.change(screen.getByLabelText("My style strength"), { target: { value: "-0.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Move My style up" }));
  fireEvent.click(screen.getByLabelText("Enable TaoMate 3-Step"));
  expect(screen.getByText("1 active")).toBeInTheDocument();
  const expected = [{ loraId: manual.id, enabled: true, strength: -0.5 }, { loraId: TAOMATE_LORA.id, enabled: false, strength: 1 }];
  expect(loadGeneratorTemplateSettings().templates.find(({ id }) => id === "default")!.loras).toEqual(expected);
  settings.unmount();
  render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Default generator" }));
  expect(screen.getByLabelText("My style strength")).toHaveValue(-0.5);
  expect(screen.getByLabelText("Enable TaoMate 3-Step")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Move My style up" })).toBeDisabled();
});

it("keeps a LoRA download alive outside Settings, shows progress and cancels through Work Queue", async () => {
  let progress: (event: { payload: { requestId: string; downloaded: number; total: number | null } }) => void = () => undefined;
  vi.mocked(listen).mockImplementation((async (_name, callback) => { progress = callback as typeof progress; return () => undefined; }) as typeof listen);
  const normal = vi.mocked(invoke).getMockImplementation()!;
  let requestId = "";
  let rejectDownload: (reason: Error) => void = () => undefined;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "download_weight") {
      requestId = (args as { requestId: string }).requestId;
      return new Promise((_resolve, reject) => { rejectDownload = reject; });
    }
    if (command === "cancel_weight_download") { rejectDownload(new Error("Download cancelled.")); return; }
    return normal(command, args);
  });
  const settings = render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Download LoRA TaoMate 3-Step" }));
  await waitFor(() => expect(requestId).not.toBe(""));
  expect(screen.getByRole("button", { name: "Download generator First/Last Frame" })).toBeDisabled();
  settings.unmount();
  render(<WorkQueuePanel queue={new WorkQueue()} items={[]} onClose={() => undefined} />);
  act(() => progress({ payload: { requestId, downloaded: 50, total: 100 } }));
  expect(screen.getByRole("progressbar", { name: "TaoMate 3-Step download progress" })).toHaveAttribute("value", "50");
  fireEvent.click(screen.getByRole("button", { name: "Cancel TaoMate 3-Step download" }));
  await waitFor(() => expect(getWeightDownloadState()).toMatchObject({ active: false, error: "Download cancelled." }));
  expect(loadLoras()[0].path).toBe("");
  expect(screen.getByRole("button", { name: "Retry download" })).toBeInTheDocument();
});

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
  fireEvent.click(screen.getByRole("button", { name: "Download generator First/Last Frame" }));
  await waitFor(() => expect(pending).toHaveLength(1));
  act(() => progress({ payload: { requestId: pending[0].requestId, downloaded: 50, total: 100 } }));
  const fill = screen.getByRole("progressbar", { name: "Downloading First/Last Frame weights" });
  expect(fill.closest(".generator-template-item")).not.toBeNull();
  expect(within(screen.getByRole("list", { name: "Download" })).getByRole("progressbar")).toBe(fill);
  expect(within(screen.getByRole("list", { name: "Generators" })).queryByText("First/Last Frame")).toBeNull();
  expect(fill).toHaveStyle({ width: "12.5%" });
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  await act(async () => pending[0].finish());
  await waitFor(() => expect(pending).toHaveLength(2));
  act(() => progress({ payload: { requestId: pending[1].requestId, downloaded: 50, total: 100 } }));
  const queue = new WorkQueue(async (record) => record);
  const panel = render(<WorkQueuePanel queue={queue} items={[]} onClose={() => panel.unmount()} />);
  expect(screen.getByRole("region", { name: "Weight downloads" })).toHaveTextContent("First/Last Frame");
  expect(screen.getByRole("progressbar", { name: "First/Last Frame download progress" })).toHaveAttribute("value", "37.5");
  expect(screen.queryByText("No work yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close work queue" }));
  const reopened = render(<SettingsView onClose={() => reopened.unmount()} />);
  expect(screen.getByRole("progressbar", { name: "Downloading First/Last Frame weights" })).toHaveStyle({ width: "37.5%" });
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
  const radio = () => screen.getByRole("radio", { name: "Use First/Last Frame as the default generator" });
  expect(within(screen.getByRole("list", { name: "Generators" })).getByText("Default")).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "Download" })).getByText("First/Last Frame")).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "Download" })).queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove generator First/Last Frame" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download generator First/Last Frame" }));
  const remove = await screen.findByRole("button", { name: "Remove downloaded weights for First/Last Frame" });
  expect(within(screen.getByRole("list", { name: "Generators" })).getByText("First/Last Frame")).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "Download" })).queryByText("First/Last Frame")).toBeNull();
  expect(within(screen.getByRole("list", { name: "Download" })).getByText("References")).toBeInTheDocument();
  expect(radio()).toBeEnabled();
  fireEvent.click(radio());
  await waitFor(() => expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe("minimax-h3-original"));
  fireEvent.click(remove);
  expect(await screen.findByRole("button", { name: "Download generator First/Last Frame" })).toBeEnabled();
  expect(within(screen.getByRole("list", { name: "Download" })).getByText("First/Last Frame")).toBeInTheDocument();
  expect(within(screen.getByRole("list", { name: "Generators" })).queryByText("First/Last Frame")).toBeNull();
  expect(within(screen.getByRole("list", { name: "Download" })).queryByRole("radio")).toBeNull();
  expect(files.size).toBe(0);
  expect(loadGeneratorTemplateSettings().templates.find((template) => template.id === "minimax-h3-original")?.paths.transformer).toMatch(/^https:/);
});

it("restores a deleted downloaded file when Settings regains focus", async () => {
  render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Download generator First/Last Frame" }));
  await screen.findByRole("button", { name: "Remove downloaded weights for First/Last Frame" });
  files.clear();
  fireEvent.focus(window);
  expect(await screen.findByRole("button", { name: "Download generator First/Last Frame" })).toBeEnabled();
});

it("stores multiple variants and their GPU and VRAM criteria in the editor", async () => {
  render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit First/Last Frame generator" }));
  const advanced = screen.getByRole("checkbox", { name: "Show advanced options" });
  expect(advanced).not.toBeChecked();
  expect(screen.queryByText(/Download variants/)).toBeNull();
  expect(advanced.closest(".generator-editor")?.lastElementChild).toBe(advanced.closest("label"));
  fireEvent.click(advanced);
  const weight = screen.getByLabelText("Transformer weights").closest(".settings-path")!;
  const details = weight.querySelector("details")!;
  fireEvent.click(within(weight as HTMLElement).getByText("Download variants (2)"));
  details.open = true;
  fireEvent.change(screen.getByLabelText("Add Transformer weights download URL"), { target: { value: "https://example.com/larger.safetensors" } });
  fireEvent.click(within(weight as HTMLElement).getByRole("button", { name: "Add URL" }));
  const gpu = screen.getByLabelText("Transformer weights variant 3 GPU model");
  fireEvent.change(gpu, { target: { value: "RTX 5090" } });
  fireEvent.blur(gpu);
  fireEvent.change(screen.getByLabelText("Transformer weights variant 3 minimum VRAM"), { target: { value: "32" } });
  await waitFor(() => expect(loadGeneratorTemplateSettings().templates.find((template) => template.id === "minimax-h3-original")?.sources?.transformer?.[2]).toMatchObject({ url: "https://example.com/larger.safetensors", gpuModel: "RTX 5090", minVramGb: 32 }));
  fireEvent.click(advanced);
  expect(screen.queryByText(/Download variants/)).toBeNull();
  fireEvent.click(advanced);
  expect(screen.getByLabelText("Transformer weights variant 3 GPU model")).toHaveValue("RTX 5090");
  fireEvent.click(screen.getByRole("button", { name: "Generators" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit Default generator" }));
  expect(screen.getByRole("checkbox", { name: "Show advanced options" })).not.toBeChecked();
  expect(screen.queryByText(/Download variants/)).toBeNull();
});
