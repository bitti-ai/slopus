// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});
afterEach(() => {
  cleanup();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

const open = () => render(<SettingsView onClose={() => undefined} />);
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const editDefaultGenerator = () => fireEvent.click(screen.getByRole("button", { name: "Edit Default generator" }));

/* jsdom does no layout, so the one thing that can be checked here is that the
   rule which makes the two tabs the same height is still in the sheet: the
   panels differ by hundreds of pixels, and a shrink-to-fit dialog moved the tab
   row out from under the pointer that had just clicked it. */
describe("the frame the tabs sit in", () => {
  it("gives the dialog a height of its own rather than letting the open tab set it", () => {
    const css = readFileSync("src/styles/shell.css", "utf8");
    const rule = css.slice(css.indexOf(".settings-view {"), css.indexOf(".settings-view__body"));
    expect(rule).toMatch(/^\s*height: min\(/m);
    expect(rule).not.toMatch(/^\s*max-height:/m);
  });
});

describe("the settings screen", () => {
  it("defaults to Sage and remembers each generator's attention", () => {
    const view = open();
    editDefaultGenerator();
    expect((screen.getByLabelText("Generator attention") as HTMLSelectElement).value).toBe("sage2");
    expect(within(screen.getByLabelText("Generator attention")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Exact attention", "Flash attention", "Sage attention"]);
    fireEvent.change(screen.getByLabelText("Generator attention"), { target: { value: "flash2" } });
    fireEvent.click(screen.getByRole("button", { name: "Generators" }));
    fireEvent.click(screen.getByRole("button", { name: "New generator" }));
    expect((screen.getByLabelText("Generator attention") as HTMLSelectElement).value).toBe("sage2");
    view.unmount();
    open();
    editDefaultGenerator();
    expect((screen.getByLabelText("Generator attention") as HTMLSelectElement).value).toBe("flash2");
  });

  it("switches NVIDIA between CUDA and Vulkan and keeps both choices after switching", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.mocked(invoke).mockImplementation(async (command, args) => command === "slopfab_status" ? {
      state: "ready", dllPath: "slopfab.dll", version: "1.4.0", cudaAvailable: true,
      platform: (args as { settings: { slopfab: { options: { inferenceBackend: string } } } }).settings.slopfab.options.inferenceBackend === "vulkan" ? "Vulkan" : "CUDA 13",
      detail: "Ready.", models: [],
    } : null);
    const view = open();
    fireEvent.click(tab("Diagnostics"));
    const backend = () => screen.getByLabelText("GPU backend") as HTMLSelectElement;
    await waitFor(() => expect(backend().disabled).toBe(false));
    expect(backend().value).toBe("cuda");
    fireEvent.change(backend(), { target: { value: "vulkan" } });
    await waitFor(() => expect(backend().disabled).toBe(false));
    expect(backend().value).toBe("vulkan");
    expect(within(backend()).getAllByRole("option")).toHaveLength(2);
    view.unmount();
    open();
    fireEvent.click(tab("Diagnostics"));
    await waitFor(() => expect(backend().disabled).toBe(false));
    expect(backend().value).toBe("vulkan");
    fireEvent.change(backend(), { target: { value: "cuda" } });
    await waitFor(() => expect(backend().value).toBe("cuda"));
    expect(localStorage.getItem("slopus.inference-backend.v1")).toBe("cuda");
  });

  it("locks machines without CUDA hardware to Vulkan despite a saved CUDA preference", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    localStorage.setItem("slopus.inference-backend.v1", "cuda");
    vi.mocked(invoke).mockResolvedValue({ state: "ready", dllPath: "slopfab.dll", version: "1.4.0", platform: "Vulkan", cudaAvailable: false, detail: "Ready.", models: [] });
    open();
    fireEvent.click(tab("Diagnostics"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("slopfab_status", expect.anything()));
    const backend = screen.getByLabelText("GPU backend") as HTMLSelectElement;
    expect(backend.disabled).toBe(true);
    expect(backend.value).toBe("vulkan");
    expect(within(backend).getAllByRole("option")).toHaveLength(1);
  });

  it("keeps the popup's saved icon choice without exposing confirmation in settings", () => {
    localStorage.setItem("slopus.reference-icon-automation.v1", "enabled");
    const view = open();
    const automatic = () => screen.getByRole("checkbox", { name: "Automatic reference icon generation" }) as HTMLInputElement;
    expect(automatic().checked).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Ask before automatic icon generation" })).toBeNull();
    view.unmount();
    open();
    expect(automatic().checked).toBe(true);
    expect(localStorage.getItem("slopus.reference-icon-automation.v1")).toBe("enabled");
    fireEvent.click(automatic());
    expect(automatic().checked).toBe(false);
    expect(localStorage.getItem("slopus.reference-icon-automation.v1")).toBe("disabled");
    fireEvent.click(automatic());
    expect(automatic().checked).toBe(true);
    expect(localStorage.getItem("slopus.reference-icon-automation.v1")).toBe("ask");
  });

  it("keeps debug options off by default and remembers the Diagnostics choice", () => {
    const view = open();
    fireEvent.click(tab("Diagnostics"));
    const toggle = screen.getByRole("checkbox", { name: "Enable debug options" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    view.unmount();
    open();
    fireEvent.click(tab("Diagnostics"));
    const restored = screen.getByRole("checkbox", { name: "Enable debug options" }) as HTMLInputElement;
    expect(restored.checked).toBe(true);
    fireEvent.click(restored);
    expect(restored.checked).toBe(false);
  });

  it("opens on the engine, because that is what has to be set before anything renders", async () => {
    open();
    expect(tab("Generator").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Generators" })).toBeTruthy();
    expect(screen.queryByLabelText(/Transformer weights/)).toBeNull();
    editDefaultGenerator();
    expect(screen.getByLabelText(/Transformer weights/)).toBeTruthy();
    // The other tab's contents are not merely hidden, they are not rendered:
    // a settings screen that draws both panels is the tall screen tabs replaced.
    expect(screen.queryByLabelText("Appearance")).toBeNull();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Browser preview"));
  });

  it("shows the compute platform selected by the desktop engine probe", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    vi.mocked(invoke).mockResolvedValue({
      state: "ready",
      dllPath: "C:\\Slopus\\slopfab.dll",
      version: "1.4.0",
      platform: "CUDA 13",
      detail: "Ready.",
      models: [],
    });
    open();
    editDefaultGenerator();
    await waitFor(() => expect(screen.getByText("CUDA 13")).toBeTruthy());
    expect(screen.getByText("Platform")).toBeTruthy();
  });

  it("swaps panels when a tab is chosen, and follows the arrow keys", () => {
    open();
    expect(screen.getAllByRole("tab").map((item) => item.textContent?.replace(/\d+$/, ""))).toEqual([
      "Generator", "Agents", "Appearance", "Diagnostics", "Updates",
    ]);
    fireEvent.click(tab("Appearance"));
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByLabelText(/Transformer weights/)).toBeNull();
    // Each panel is named by the tab that opened it, so a screen reader lands
    // somewhere that says what it is.
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("settings-tab-appearance");

    fireEvent.keyDown(tab("Appearance"), { key: "ArrowRight" });
    expect(tab("Diagnostics").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("Diagnostics"), { key: "ArrowLeft" });
    expect(tab("Appearance").getAttribute("aria-selected")).toBe("true");
  });

  it("counts the paths still to set on the engine tab, from either tab", () => {
    open();
    // Four of the five fields are required and none is set yet.
    expect(within(tab("Generator")).getByText("4")).toBeTruthy();
    fireEvent.click(tab("Appearance"));
    // Still legible from the other side: what is unfinished is the reason the
    // screen was opened, and hiding it behind a tab would bury it.
    expect(within(tab("Generator")).getByText("4")).toBeTruthy();
  });

  it("keeps the settings header short", () => {
    const { container } = open();
    for (const gone of ["belongs to this computer", "stays behind when", "needs the model files", "ships with the app"]) {
      expect(container.textContent, gone).not.toContain(gone);
    }
    expect(screen.queryByText("This computer")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    editDefaultGenerator();
    expect(screen.getByText("Reads your prompt so the transformer can act on it.")).toBeTruthy();
  });

  it("puts the optional tokenizer setting last", () => {
    const { container } = open();
    editDefaultGenerator();
    const labels = Array.from(container.querySelectorAll(".settings-path label b")).map((label) => label.textContent);
    expect(labels.at(-1)).toContain("Tokenizer");
  });

  it("offers Clear generator paths only on the generator editor page", () => {
    open();
    expect(screen.queryByRole("button", { name: /Clear generator paths/ })).toBeNull();
    editDefaultGenerator();
    expect(screen.getByRole("button", { name: /Clear generator paths/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generators" }));
    expect(screen.queryByRole("button", { name: /Clear generator paths/ })).toBeNull();
    fireEvent.click(tab("Appearance"));
    expect(screen.queryByRole("button", { name: /Clear generator paths/ })).toBeNull();
  });

  it("replaces the settings tabs with the Generators back button while editing", () => {
    open();
    expect(screen.queryByText("Changes are saved as you type.")).toBeNull();
    editDefaultGenerator();
    const back = screen.getByRole("button", { name: "Generators" });
    expect(screen.queryByRole("tab", { name: "Appearance" })).toBeNull();
    expect(back.closest(".settings-tabs")).not.toBeNull();

    fireEvent.click(back);
    expect(screen.getByRole("tab", { name: "Appearance" })).toBeTruthy();
  });

  it("creates a generator with 20 steps, edits it on its own page, and can make it the default", () => {
    open();
    expect(screen.queryByLabelText(/Transformer weights/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New generator" }));
    expect((screen.getByLabelText("Generator name") as HTMLInputElement).value).toBe("Generator 2");
    expect((screen.getByLabelText("Generator default steps") as HTMLInputElement).value).toBe("20");

    fireEvent.change(screen.getByLabelText("Generator name"), { target: { value: "Fast draft" } });
    fireEvent.change(screen.getByLabelText("Generator default steps"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText(/Transformer weights/), { target: { value: "D:\\Models\\draft.safetensors" } });
    fireEvent.click(screen.getByRole("button", { name: "Generators" }));
    expect(screen.queryByLabelText(/Transformer weights/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Use Fast draft as the default generator" }));

    const stored = JSON.parse(localStorage.getItem("slopus.generator-templates.v1") ?? "null");
    const selected = stored.templates.find((template: { id: string }) => template.id === stored.defaultTemplateId);
    expect(selected).toMatchObject({ name: "Fast draft", defaultSteps: 12, paths: { transformer: "D:\\Models\\draft.safetensors" } });
  });

  it("puts each generator's radio first without a visible Default label", () => {
    open();
    const radio = screen.getByRole("radio", { name: "Use Default as the default generator" });
    const row = radio.closest(".generator-template-item");
    expect(row?.firstElementChild).toBe(radio.closest("label"));
    expect(radio.closest("label")?.textContent).toBe("");
  });

  it("offers only a button to reveal the log without fetching log details", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const info = {
      path: "C:\\Users\\Editor\\AppData\\Local\\com.slopus.desktop\\logs\\slopus.log",
      previousPath: null,
      sessionId: "42-1",
      maxFileBytes: 5_242_880,
    };
    vi.mocked(invoke).mockImplementation(async (command) => command === "diagnostic_log_info" || command === "reveal_diagnostic_log"
      ? info
      : { state: "ready", dllPath: "C:\\Slopus\\slopfab.dll", version: "1.4.0", platform: "CUDA 13", detail: "Ready.", models: [] });

    open();
    fireEvent.click(tab("Diagnostics"));
    expect(screen.queryByText(info.path)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Application log" })).toBeNull();
    expect(screen.queryByText(/Prompt text and credentials are not recorded/)).toBeNull();
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).not.toContain("diagnostic_log_info");
    fireEvent.click(screen.getByRole("button", { name: "Show log file" }));
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toContain("reveal_diagnostic_log"));
  });

  it("configures OpenRouter and local OpenAI-compatible models without requiring a local API key", () => {
    open();
    fireEvent.click(tab("Agents"));

    const openrouter = screen.getByRole("heading", { name: "OpenRouter" }).closest("section")!;
    expect((within(openrouter).getByLabelText("OpenRouter endpoint") as HTMLInputElement).value).toBe("https://openrouter.ai/api/v1");
    fireEvent.change(within(openrouter).getByLabelText("OpenRouter API key"), { target: { value: "sk-or-test" } });
    fireEvent.change(within(openrouter).getByLabelText("OpenRouter model"), { target: { value: "openai/gpt-test" } });
    expect(openrouter.textContent).toContain("Configured");

    const local = screen.getByRole("heading", { name: "Local OpenAI-compatible" }).closest("section")!;
    fireEvent.change(within(local).getByLabelText("Local OpenAI-compatible endpoint"), { target: { value: "http://localhost:1234/v1" } });
    fireEvent.change(within(local).getByLabelText("Local OpenAI-compatible model"), { target: { value: "local-model" } });
    expect(local.textContent).toContain("Configured");

    const stored = JSON.parse(localStorage.getItem("slopus.agent-endpoints.v1") ?? "null");
    expect(stored.openrouter).toMatchObject({ apiKey: "sk-or-test", model: "openai/gpt-test" });
    expect(stored.local).toMatchObject({ endpoint: "http://localhost:1234/v1", model: "local-model", apiKey: "" });
  });
});
