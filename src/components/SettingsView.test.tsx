// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { middleEllipsis, SettingsView } from "./SettingsView";
import { createGeneratorTemplate, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings } from "../lib/settings";
import { loadReferenceIconGeneratorId } from "../lib/referenceIconSettings";
import { loadLoras } from "../lib/loras";

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
const tab = (name: string) => within(screen.getByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: new RegExp(`^${name}`) });
const editDefaultGenerator = () => fireEvent.click(screen.getByRole("button", { name: "Edit Default generator" }));
const combo = (name: string) => screen.getByRole("combobox", { name });
const pick = (name: string, option: string) => { fireEvent.click(combo(name)); fireEvent.click(screen.getByRole("option", { name: option })); };
const optionsOf = (name: string) => {
  fireEvent.click(combo(name));
  const labels = screen.getAllByRole("option").map((option) => option.textContent);
  fireEvent.keyDown(combo(name), { key: "Escape" });
  return labels;
};
const toggle = (name: string) => screen.getByRole("switch", { name });
const enterPath = (label: string, value: string) => {
  fireEvent.click(screen.getByRole("button", { name: `More options for ${label}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Enter path or URL…" }));
  const input = screen.getByRole("textbox", { name: label });
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

describe("the settings page", () => {
  it("opens a focused page with a navigation pane and a Back action", () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole("main", { name: "Settings" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Generator" })).toBeTruthy();
    expect(tab("Generator").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape from the top level", () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("main", { name: "Settings" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("middle-ellipsises long paths and keeps the file name", () => {
    expect(middleEllipsis("C:\\short.safetensors")).toBe("C:\\short.safetensors");
    const long = `D:\\${"folder\\".repeat(20)}model.safetensors`;
    const shown = middleEllipsis(long);
    expect(shown.length).toBe(64);
    expect(shown).toMatch(/^D:\\folder.*….*model\.safetensors$/);
  });
});

describe("the settings screen", () => {
  it("remembers MotionCache per generator and disables it in Animate mode", () => {
    const view = open();
    editDefaultGenerator();
    const motion = () => toggle("Enable MotionCache");
    expect(motion().getAttribute("aria-checked")).toBe("false");
    fireEvent.click(motion());
    expect(loadGeneratorTemplateSettings().templates.find(({ id }) => id === "default")?.motionCache).toBe(true);
    pick("Generator mode", "Animate (reference video)");
    expect(motion().getAttribute("aria-checked")).toBe("false");
    expect((motion() as HTMLButtonElement).disabled).toBe(true);
    pick("Generator mode", "Text prompt");
    expect(motion().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Generators" }));
    fireEvent.click(screen.getByRole("button", { name: "New generator" }));
    expect(motion().getAttribute("aria-checked")).toBe("false");
    view.unmount();
    open();
    editDefaultGenerator();
    expect(motion().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(motion());
    expect(loadGeneratorTemplateSettings().templates.find(({ id }) => id === "default")?.motionCache).toBe(false);
  });

  it("defaults to Sage and remembers each generator's attention", () => {
    const view = open();
    editDefaultGenerator();
    expect(combo("Generator attention").getAttribute("data-value")).toBe("sage2");
    expect(optionsOf("Generator attention")).toEqual(["Exact attention", "Flash attention", "Sage attention", "Sol attention"]);
    pick("Generator attention", "Sol attention");
    expect(screen.getByText("Sol attention requires a CUDA GPU on the machine running generation.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generators" }));
    fireEvent.click(screen.getByRole("button", { name: "New generator" }));
    expect(combo("Generator attention").getAttribute("data-value")).toBe("sage2");
    view.unmount();
    open();
    editDefaultGenerator();
    expect(combo("Generator attention").getAttribute("data-value")).toBe("sol");
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
    const backend = () => combo("GPU backend") as HTMLButtonElement;
    await waitFor(() => expect(backend().disabled).toBe(false));
    expect(backend().getAttribute("data-value")).toBe("cuda");
    expect(optionsOf("GPU backend")).toEqual(["CUDA", "Vulkan"]);
    pick("GPU backend", "Vulkan");
    await waitFor(() => expect(backend().disabled).toBe(false));
    expect(backend().getAttribute("data-value")).toBe("vulkan");
    view.unmount();
    open();
    fireEvent.click(tab("Diagnostics"));
    await waitFor(() => expect(backend().disabled).toBe(false));
    expect(backend().getAttribute("data-value")).toBe("vulkan");
    pick("GPU backend", "CUDA");
    await waitFor(() => expect(backend().getAttribute("data-value")).toBe("cuda"));
    expect(localStorage.getItem("slopus.inference-backend.v1")).toBe("cuda");
  });

  it("locks machines without CUDA hardware to Vulkan despite a saved CUDA preference", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    localStorage.setItem("slopus.inference-backend.v1", "cuda");
    vi.mocked(invoke).mockResolvedValue({ state: "ready", dllPath: "slopfab.dll", version: "1.4.0", platform: "Vulkan", cudaAvailable: false, detail: "Ready.", models: [] });
    open();
    fireEvent.click(tab("Diagnostics"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("slopfab_status", expect.anything()));
    const backend = combo("GPU backend") as HTMLButtonElement;
    expect(backend.disabled).toBe(true);
    expect(backend.getAttribute("data-value")).toBe("vulkan");
    expect(backend.textContent).toBe("Vulkan");
  });

  it("keeps the popup's saved icon choice without exposing confirmation in settings", () => {
    localStorage.setItem("slopus.reference-icon-automation.v1", "enabled");
    const view = open();
    const automatic = () => toggle("Automatic reference icon generation");
    expect(automatic().getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("switch", { name: "Ask before automatic icon generation" })).toBeNull();
    view.unmount();
    open();
    expect(automatic().getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("slopus.reference-icon-automation.v1")).toBe("enabled");
    fireEvent.click(automatic());
    expect(automatic().getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("slopus.reference-icon-automation.v1")).toBe("disabled");
    fireEvent.click(automatic());
    expect(automatic().getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("slopus.reference-icon-automation.v1")).toBe("ask");
  });

  it("keeps debug options off by default and remembers the Diagnostics choice", () => {
    const view = open();
    fireEvent.click(tab("Diagnostics"));
    expect(toggle("Enable debug options").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle("Enable debug options"));
    view.unmount();
    open();
    fireEvent.click(tab("Diagnostics"));
    expect(toggle("Enable debug options").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle("Enable debug options"));
    expect(toggle("Enable debug options").getAttribute("aria-checked")).toBe("false");
  });

  it("picks the app theme from one combo box and saves it", () => {
    open();
    fireEvent.click(tab("Appearance"));
    expect(screen.getByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    expect(combo("App theme").textContent).toBe("Use system setting");
    expect(optionsOf("App theme")).toEqual(["Use system setting", "Light", "Dark"]);
    pick("App theme", "Light");
    expect(localStorage.getItem("slopus.theme.v1")).toBe("light");
    expect(combo("App theme").textContent).toBe("Light");
  });

  it("opens on the engine, because that is what has to be set before anything renders", async () => {
    open();
    expect(tab("Generator").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Generators" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Transformer weights" })).toBeNull();
    editDefaultGenerator();
    expect(screen.getByRole("group", { name: "Transformer weights" })).toBeTruthy();
    // The other sections are not merely hidden, they are not rendered.
    expect(screen.queryByRole("combobox", { name: "App theme" })).toBeNull();
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

  it("swaps sections from the navigation pane, and follows the arrow keys", () => {
    open();
    const items = within(screen.getByRole("navigation", { name: "Settings sections" })).getAllByRole("button").filter((item) => item.id.startsWith("settings-tab-"));
    expect(items.map((item) => item.textContent?.replace(/\d+$/, ""))).toEqual([
      "Generator", "Workers", "Agents", "Appearance", "Diagnostics", "Updates",
    ]);
    fireEvent.click(tab("Appearance"));
    expect(combo("App theme")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Transformer weights" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Appearance");

    fireEvent.keyDown(tab("Appearance"), { key: "ArrowDown" });
    expect(tab("Diagnostics").getAttribute("aria-current")).toBe("page");
    fireEvent.keyDown(tab("Diagnostics"), { key: "ArrowUp" });
    expect(tab("Appearance").getAttribute("aria-current")).toBe("page");
    fireEvent.keyDown(tab("Appearance"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Generator"));
    fireEvent.keyDown(tab("Generator"), { key: "End" });
    expect(document.activeElement).toBe(tab("Updates"));
  });

  it("counts the paths still to set on the Generator item, from any section", () => {
    open();
    // Four of the five fields are required and none is set yet.
    expect(within(tab("Generator")).getByText("4")).toBeTruthy();
    expect(tab("Generator").getAttribute("aria-label")).toBe("Generator, 4 model paths to set");
    fireEvent.click(tab("Appearance"));
    expect(within(tab("Generator")).getByText("4")).toBeTruthy();
  });

  it("keeps the settings copy short", () => {
    const { container } = open();
    for (const gone of ["belongs to this computer", "stays behind when", "needs the model files", "ships with the app", "Match this computer", "whatever this computer"]) {
      expect(container.textContent, gone).not.toContain(gone);
    }
    expect(screen.queryByText("This computer")).toBeNull();
    editDefaultGenerator();
    expect(screen.queryByText("Reads your prompt so the transformer can act on it.")).toBeNull();
    expect(screen.queryByText("Set its name, generation steps, attention, and model locations on this computer.")).toBeNull();
  });

  it("puts the optional tokenizer setting last, marked (optional) in plain text", () => {
    const { container } = open();
    editDefaultGenerator();
    const labels = Array.from(container.querySelectorAll(".settings-path .ui-settings-card__header")).map((label) => label.textContent);
    expect(labels.at(-1)).toBe("Tokenizer (optional)");
  });

  it("shows paths in cards and edits them through the More menu", () => {
    open();
    editDefaultGenerator();
    const card = screen.getByRole("group", { name: "Transformer weights" });
    expect(card.textContent).toContain("Not set");
    expect(within(card).getByRole("button", { name: "Browse for Transformer weights" })).toBeTruthy();
    const long = "D:\\Models\\a-very-long-folder-name\\another-nested-folder\\wan2.2\\transformer-weights.safetensors";
    enterPath("Transformer weights", long);
    expect(loadGeneratorTemplateSettings().templates.find(({ id }) => id === "default")?.paths.transformer).toBe(long);
    const shown = card.querySelector(".settings-path__value")!;
    expect(shown.textContent).toContain("…");
    expect(shown.textContent).toMatch(/transformer-weights\.safetensors$/);
    expect(shown.getAttribute("data-tooltip")).toBe(long);
    fireEvent.click(screen.getByRole("button", { name: "More options for Transformer weights" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear" }));
    expect(loadGeneratorTemplateSettings().templates.find(({ id }) => id === "default")?.paths.transformer).toBe("");
  });

  it("offers Clear generator paths only on the generator sub-page", () => {
    open();
    expect(screen.queryByRole("button", { name: /Clear generator paths/ })).toBeNull();
    editDefaultGenerator();
    expect(screen.getByRole("button", { name: /Clear generator paths/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generators" }));
    expect(screen.queryByRole("button", { name: /Clear generator paths/ })).toBeNull();
    fireEvent.click(tab("Appearance"));
    expect(screen.queryByRole("button", { name: /Clear generator paths/ })).toBeNull();
  });

  it("edits generators on a sub-page with a breadcrumb and returns on Escape or Back", async () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Edit Default generator" });
    opener.focus(); fireEvent.click(opener);
    expect(screen.queryByRole("dialog")).toBeNull();
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb.textContent).toBe("GeneratorsDefault");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Default" }));
    // The navigation pane stays usable while a sub-page is open.
    expect(tab("Appearance")).toBeTruthy();
    for (const group of ["General", "Performance", "Model files", /^Additional safetensors/, /^LoRAs/]) {
      expect(screen.getByRole("heading", { name: group })).toBeTruthy();
    }

    fireEvent.keyDown(screen.getByLabelText("Generator name"), { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit Default generator" })));

    fireEvent.click(screen.getByRole("button", { name: "Edit Default generator" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByLabelText("Generator name")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("edits LoRAs in a content dialog and discards unsaved changes on Cancel or Escape", async () => {
    const onClose = vi.fn();
    render(<SettingsView onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Edit TaoMate 3-Step LoRA" });
    opener.focus(); fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Edit LoRA" });
    const name = within(dialog).getByLabelText("LoRA name");
    expect(document.activeElement).toBe(name);
    // The page behind is hidden from assistive technology while it is open.
    expect(screen.queryByRole("main", { name: "Settings" })).toBeNull();
    expect(within(dialog).queryByLabelText("LoRA multiplier")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeTruthy();
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(loadLoras()[0].name).toBe("TaoMate 3-Step");
    await waitFor(() => expect(document.activeElement).toBe(opener));
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves and clears independent LoRA sigma shift overrides", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Edit TaoMate 3-Step LoRA" }));
    fireEvent.change(screen.getByLabelText("LoRA video sigma shift override"), { target: { value: "8.5" } });
    fireEvent.change(screen.getByLabelText("LoRA audio sigma shift override"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loadLoras()[0]).toMatchObject({ videoSigmaShiftOverride: 8.5, audioSigmaShiftOverride: 2.5 });
    fireEvent.click(screen.getByRole("button", { name: "Edit TaoMate 3-Step LoRA" }));
    expect((screen.getByLabelText("LoRA video sigma shift override") as HTMLInputElement).value).toBe("8.5");
    fireEvent.change(screen.getByLabelText("LoRA video sigma shift override"), { target: { value: "0" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("LoRA video sigma shift override"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(loadLoras()[0].videoSigmaShiftOverride).toBeUndefined();
    expect(loadLoras()[0].audioSigmaShiftOverride).toBe(2.5);
  });

  it("defaults icon generation to the sole available generator and remembers a separate selection", () => {
    const first = createGeneratorTemplate("Video"), second = createGeneratorTemplate("Icons");
    const templates = { templates: [first], defaultTemplateId: first.id, catalogVersion: 9 };
    saveGeneratorTemplateSettings(templates);
    const view = open();
    expect(combo("Reference icon generator").getAttribute("data-value")).toBe(first.id);
    view.unmount();
    saveGeneratorTemplateSettings({ ...templates, templates: [first, second] });
    const reopened = open();
    pick("Reference icon generator", "Icons");
    expect(loadReferenceIconGeneratorId()).toBe(second.id);
    expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe(first.id);
    reopened.unmount();
    open();
    expect(combo("Reference icon generator").getAttribute("data-value")).toBe(second.id);
  });

  it("creates a generator with 20 steps, edits it on its own page, and can make it the default", () => {
    open();
    expect(screen.queryByRole("group", { name: "Transformer weights" })).toBeNull();
    const nextGeneratorName = `Generator ${loadGeneratorTemplateSettings().templates.length + 1}`;
    fireEvent.click(screen.getByRole("button", { name: "New generator" }));
    expect((screen.getByLabelText("Generator name") as HTMLInputElement).value).toBe(nextGeneratorName);
    expect(document.activeElement).toBe(screen.getByLabelText("Generator name"));
    expect((screen.getByLabelText("Generator default steps") as HTMLInputElement).value).toBe("20");

    fireEvent.change(screen.getByLabelText("Generator name"), { target: { value: "Fast draft" } });
    fireEvent.change(screen.getByLabelText("Generator default steps"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Generator video sigma shift"), { target: { value: "8.5" } });
    fireEvent.change(screen.getByLabelText("Generator audio sigma shift"), { target: { value: "2.5" } });
    expect(loadGeneratorTemplateSettings().templates.find((template) => template.name === "Fast draft")).toMatchObject({ videoSigmaShift: 8.5, audioSigmaShift: 2.5 });
    expect(screen.getByRole("heading", { level: 1, name: "Fast draft" })).toBeTruthy();
    enterPath("Transformer weights", "D:\\Models\\draft.safetensors");
    fireEvent.click(screen.getByRole("button", { name: "Generators" }));
    expect(screen.queryByRole("group", { name: "Transformer weights" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set Fast draft as default" }));

    const stored = JSON.parse(localStorage.getItem("slopus.generator-templates.v1") ?? "null");
    const selected = stored.templates.find((template: { id: string }) => template.id === stored.defaultTemplateId);
    expect(selected).toMatchObject({ name: "Fast draft", defaultSteps: 12, paths: { transformer: "D:\\Models\\draft.safetensors" } });
    expect(screen.queryByRole("button", { name: "Set Fast draft as default" })).toBeNull();
    expect(screen.getByRole("button", { name: "Set Default as default" })).toBeTruthy();
  });

  it("marks the default generator in its card description instead of a radio", () => {
    open();
    expect(screen.queryByRole("radio")).toBeNull();
    const card = screen.getByRole("button", { name: "Edit Default generator" }).closest(".settings-open-card") as HTMLElement;
    expect(card.textContent).toContain("Used by default");
    expect(within(card).queryByRole("button", { name: /as default/ })).toBeNull();
  });

  it("offers only a row to reveal the log without fetching log details", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const info = {
      path: "C:\\Users\\Editor\\AppData\\Local\\Slopus\\logs\\slopus.log",
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
    const provider = (name: string) => screen.getByRole("button", { name }).closest(".ui-settings-expander") as HTMLElement;

    const openrouter = provider("OpenRouter");
    fireEvent.click(screen.getByRole("button", { name: "OpenRouter" }));
    expect(screen.getByRole("button", { name: "OpenRouter" }).getAttribute("aria-expanded")).toBe("true");
    expect((within(openrouter).getByLabelText("OpenRouter endpoint") as HTMLInputElement).value).toBe("https://openrouter.ai/api/v1");
    fireEvent.change(within(openrouter).getByLabelText("OpenRouter API key"), { target: { value: "sk-or-test" } });
    fireEvent.change(within(openrouter).getByLabelText("OpenRouter model"), { target: { value: "openai/gpt-test" } });
    expect(openrouter.textContent).toContain("Configured");

    const local = provider("Local OpenAI-compatible");
    fireEvent.change(within(local).getByLabelText("Local OpenAI-compatible endpoint"), { target: { value: "http://localhost:1234/v1" } });
    fireEvent.change(within(local).getByLabelText("Local OpenAI-compatible model"), { target: { value: "local-model" } });
    expect(local.textContent).toContain("Configured");

    const stored = JSON.parse(localStorage.getItem("slopus.agent-endpoints.v1") ?? "null");
    expect(stored.openrouter).toMatchObject({ apiKey: "sk-or-test", model: "openai/gpt-test" });
    expect(stored.local).toMatchObject({ endpoint: "http://localhost:1234/v1", model: "local-model", apiKey: "" });
  });
});
