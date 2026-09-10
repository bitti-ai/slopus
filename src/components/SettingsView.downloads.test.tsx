// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import { loadGeneratorTemplateSettings } from "../lib/settings";

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
