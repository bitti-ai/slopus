// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig, referenceImages, type ProjectConfig } from "../../lib/project";
import { ReferencesView } from "./ReferencesView";
import { choose, chooseOption, comboValue } from "./comboTestUtils";
import { referenceIconPrompt } from "../../lib/referenceIcons";
import { saveDebugOptionsEnabled } from "../../lib/settings";
import { REFERENCE_PRESETS } from "../../lib/reference-presets";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const originalPresetIcons = new Map(REFERENCE_PRESETS.map((preset) => [preset.id, preset.icon]));

beforeEach(() => localStorage.clear());

afterEach(() => {
  REFERENCE_PRESETS.forEach((preset) => { preset.icon = originalPresetIcons.get(preset.id); });
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
  vi.restoreAllMocks();
});

const project = (): ProjectConfig => {
  const base = createProjectConfig({
    name: "Reference presets",
    prompt: "A short character film",
    aspectRatio: "16:9",
    resolution: "1080p",
    targetDurationSeconds: 20,
  });
  return parseProjectConfig({
    ...base,
    references: [{
      id: "ref-hero",
      kind: "text",
      name: "Hero",
      description: "A traveler with a weathered red coat.",
      content: "A traveler with a weathered red coat.",
      intendedUse: [],
      createdAt: base.createdAt,
    }],
  });
};

function setup(initial = project(), onRegenerateIcon = vi.fn(), pendingIconIds = new Set<string>()) {
  let latest = initial;
  function Harness() {
    const [config, setConfig] = useState(latest);
    latest = config;
    return <ReferencesView config={config} folderPath="C:\\project" onChange={setConfig} onRegenerateIcon={onRegenerateIcon} pendingIconIds={pendingIconIds} />;
  }
  render(<Harness />);
  return { latest: () => latest };
}

describe("Reference type presets", () => {
  it("pages through one image at a time, resets on reference changes, and removes images through the last page", () => {
    const initial = project();
    initial.references[0].images = ["front", "side", "back"].map((name) => ({ id: name, name, relativePath: `references/${name}.png` }));
    initial.references.push({ ...initial.references[0], id: "ref-other", name: "Other" });
    const state = setup(initial);
    const inspector = within(screen.getByRole("complementary"));
    const previous = () => inspector.getByRole("button", { name: "Previous reference image" });
    const next = () => inspector.getByRole("button", { name: "Next reference image" });
    const remove = () => fireEvent.click(inspector.getByRole("button", { name: "Remove reference image" }));
    expect(inspector.getAllByRole("img")).toHaveLength(1);
    expect(inspector.getByRole("img", { name: /^front/ })).toBeInTheDocument();
    expect(previous()).toBeDisabled();
    fireEvent.click(next());
    expect(inspector.getByRole("img", { name: /^side/ })).toBeInTheDocument();
    expect(inspector.queryByRole("img", { name: /^front/ })).not.toBeInTheDocument();
    fireEvent.click(previous());
    expect(inspector.getByText("Image 1 of 3")).toBeInTheDocument();
    fireEvent.click(next());
    fireEvent.click(screen.getByRole("option", { name: /Other 3 images/ }));
    expect(inspector.getByText("Image 1 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Hero 3 images/ }));
    fireEvent.click(next());
    remove();
    expect(inspector.getByText("Image 2 of 2")).toBeInTheDocument();
    expect(inspector.getByRole("img", { name: /^back/ })).toBeInTheDocument();
    expect(next()).toBeDisabled();
    remove();
    expect(inspector.getByText("Image 1 of 1")).toBeInTheDocument();
    expect(previous()).toBeDisabled();
    expect(next()).toBeDisabled();
    remove();
    expect(inspector.queryByRole("group", { name: "Reference images" })).not.toBeInTheDocument();
    const saved = parseProjectConfig(JSON.parse(JSON.stringify(state.latest())));
    expect(saved.references[0]).toMatchObject({ ...initial.references[0], images: [] });
    expect(saved.references[1].images).toHaveLength(3);
    expect(saved.generationJobs).toEqual(initial.generationJobs);
  });

  it.each(["legacy", "attachment"])("removes the %s image from an older reference without restoring it on reload", (target) => {
    const initial = project();
    Object.assign(initial.references[0], { kind: "image", relativePath: "references/legacy.png", sourcePath: null, images: [{ id: "extra", name: "Extra", relativePath: "references/extra.png" }] });
    const state = setup(initial);
    if (target === "attachment") fireEvent.click(screen.getByRole("button", { name: "Next reference image" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove reference image" }));
    const saved = parseProjectConfig(JSON.parse(JSON.stringify(state.latest())));
    expect(saved.references[0]).toMatchObject({ kind: "text", relativePath: null, sourcePath: null, description: initial.references[0].description });
    expect(referenceImages(saved.references[0]).map((image) => image.relativePath)).toEqual([target === "legacy" ? "references/extra.png" : "references/legacy.png"]);
    cleanup();
    const restored = setup(saved);
    fireEvent.click(screen.getByRole("button", { name: "Remove reference image" }));
    expect(referenceImages(parseProjectConfig(restored.latest()).references[0])).toEqual([]);
  });

  it("shows the exact icon regeneration prompt in a debug-only footer dialog", () => {
    const regenerate = vi.fn();
    const state = setup(project(), regenerate);
    expect(screen.queryByRole("button", { name: "Debug icon prompt" })).not.toBeInTheDocument();
    act(() => saveDebugOptionsEnabled(true));
    const button = screen.getByRole("button", { name: "Debug icon prompt" });
    expect(button.closest(".reference-inspector")?.lastElementChild).toBe(button.parentElement);
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Debug icon prompt" });
    expect(dialog.closest("aside")).toBeNull();
    const prompt = within(dialog).getByLabelText("The reference icon generation prompt");
    expect(prompt.textContent).toBe(referenceIconPrompt(state.latest().references[0]));
    expect(prompt).toHaveFocus();
    expect(regenerate).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "a", metaKey: true });
    expect(window.getSelection()?.toString()).toBe(referenceIconPrompt(state.latest().references[0]));
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Debug icon prompt" })).not.toBeInTheDocument();
    fireEvent.click(button);
    act(() => saveDebugOptionsEnabled(false));
    expect(screen.queryByRole("dialog", { name: "Debug icon prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Debug icon prompt" })).not.toBeInTheDocument();
  });

  it("uses the selected reference's latest name, category, subcategory and description", () => {
    saveDebugOptionsEnabled(true);
    const initial = project();
    initial.references.push({ ...initial.references[0], id: "ref-animal", name: "Pet", intendedUse: ["animal"], subcategory: "Pets", description: "A golden retriever." });
    const state = setup(initial);
    fireEvent.click(screen.getByRole("option", { name: /^Pet / }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reference name" }), { target: { value: "Buddy" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "A sleepy golden retriever.\nSoft light." } });
    fireEvent.click(screen.getByRole("button", { name: "Debug icon prompt" }));
    const prompt = screen.getByLabelText("The reference icon generation prompt");
    expect(prompt.textContent).toBe(referenceIconPrompt(state.latest().references[1]));
    expect(prompt.textContent).toContain("animal with its whole body visible");
    expect(prompt.textContent).toContain("Subcategory: Pets");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Debug icon prompt" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Debug icon prompt" })).not.toBeInTheDocument();
  });

  it("does not show icon debugging without a selected reference", () => {
    saveDebugOptionsEnabled(true);
    setup({ ...project(), references: [] });
    expect(screen.queryByRole("button", { name: "Debug icon prompt" })).not.toBeInTheDocument();
  });

  it("requests an icon refresh for the selected reference and disables duplicate requests", () => {
    const regenerate = vi.fn();
    const initial = project();
    setup(initial, regenerate);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate reference icon" }));
    expect(regenerate).toHaveBeenCalledWith("ref-hero");
    cleanup();
    setup(initial, regenerate, new Set(["ref-hero"]));
    expect(screen.getByRole("button", { name: "Regenerate reference icon" })).toBeDisabled();
    cleanup();
    initial.references[0].description = "";
    setup(initial, regenerate);
    expect(screen.getByRole("button", { name: "Regenerate reference icon" })).toBeDisabled();
  });

  it("adds an animal preset from its searchable subcategory", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Animal" }));
    fireEvent.click(within(dialog).getByRole("tab", { name: "Pets" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search reference options" }), { target: { value: "retriever" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Golden retriever/ }));
    expect(state.latest().references[0]).toMatchObject({ name: "Golden retriever", intendedUse: ["animal"], subcategory: "Pets", description: "Golden retriever." });
    expect(comboValue(screen.getByRole("combobox", { name: "Category" }))).toBe("animal");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Golden retriever.");
  });

  it.each([
    ["Character", "character", "Animation"],
    ["Animal", "animal", "Pets"],
    ["Clothes", "clothing", "Tops"],
    ["Accessories", "accessory", "Jewelry"],
    ["Product", "product", "Technology"],
    ["Location", "location", "Urban"],
    ["Style", "style", "Cinematic"],
  ])("creates and saves an editable %s with its subcategory", (label, category, subcategory) => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
    fireEvent.click(within(dialog).getByRole("tab", { name: subcategory }));
    fireEvent.click(within(dialog).getByRole("button", { name: "New" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.latest().references).toHaveLength(2);
    expect(state.latest().references[0]).toMatchObject({ description: "", content: null, intendedUse: [category], subcategory });
    expect(comboValue(screen.getByRole("combobox", { name: "Subcategory" }))).toBe(subcategory);
    fireEvent.change(screen.getByRole("textbox", { name: "Reference name" }), { target: { value: "My reference" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Keep the cool blue colors." } });
    const saved = parseProjectConfig(state.latest());
    cleanup();
    const restored = setup(saved);
    expect(screen.getByRole("textbox", { name: "Reference name" })).toHaveValue("My reference");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Keep the cool blue colors.");
    expect(comboValue(screen.getByRole("combobox", { name: "Category" }))).toBe(category);
    expect(comboValue(screen.getByRole("combobox", { name: "Subcategory" }))).toBe(subcategory);
    choose("Subcategory", "None");
    expect(restored.latest().references[0].subcategory).toBe("");
    const nextCategory = category === "product" ? "style" : "product";
    choose("Category", nextCategory === "style" ? "Style" : "Product");
    expect(restored.latest().references[0]).toMatchObject({ intendedUse: [nextCategory], subcategory: "", description: "Keep the cool blue colors." });
  });

  it("renames the selected reference from the inspector header", () => {
    const state = setup();
    const name = screen.getByRole("textbox", { name: "Reference name" });
    const header = name.closest<HTMLElement>(".ui-item-header");

    expect(name).toHaveValue("Hero");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("button", { name: "Delete reference" })).toHaveClass("icon-button");
    fireEvent.change(name, { target: { value: "Lead traveler" } });

    expect(state.latest().references[0].name).toBe("Lead traveler");
    expect(screen.getByRole("option", { name: /Lead traveler/ })).toBeInTheDocument();
  });

  it("opens the new-reference picker from the command bar", () => {
    const state = setup();
    expect(screen.queryByRole("button", { name: "New definition" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add image" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));

    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    expect(dialog).toBeInTheDocument();
    expect(state.latest().references).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: "Text" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Image" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Character" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "New" }));
    expect(state.latest().references[0]).toMatchObject({ name: "New character", description: "", intendedUse: ["character"] });
  });

  it("keeps legacy uncategorized references editable", () => {
    setup();
    expect(comboValue(screen.getByRole("combobox", { name: "Category" }))).toBe("custom");
    expect(screen.queryByRole("button", { name: "Choose preset" })).not.toBeInTheDocument();
    expect(screen.queryByText("Intended use")).not.toBeInTheDocument();
    expect(screen.queryByText(/Select any that apply/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("A traveler with a weathered red coat.");
  });

  it("chooses one prepared character from the scalable popup", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Character" }));
    const groups = within(dialog).getByRole("tablist", { name: "Character subcategories" });
    expect(within(groups).getByRole("tab", { name: "Film" })).toBeInTheDocument();
    expect(within(groups).getByRole("tab", { name: "Television" })).toBeInTheDocument();
    expect(within(groups).getByRole("tab", { name: "Public figures" })).toBeInTheDocument();
    fireEvent.click(within(groups).getByRole("tab", { name: "Television" }));
    expect(within(dialog).getByRole("button", { name: /Sherlock Holmes · Benedict Cumberbatch/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Sherlock Holmes · Benedict Cumberbatch/ }));

    const reference = state.latest().references[0];
    expect(reference.intendedUse).toEqual(["character"]);
    expect(reference.description).toBe("Sherlock Holmes, Benedict Cumberbatch portrayal.");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue(reference.description);
    expect(comboValue(screen.getByRole("combobox", { name: "Subcategory" }))).toBe("Television");
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Sherlock in a blue coat." } });
    expect(state.latest().references[0]).toMatchObject({ intendedUse: ["character"], subcategory: "Television", description: "Sherlock in a blue coat." });
  });

  it("shows a bundled MiniMax icon for an illustrated character preset", () => {
    REFERENCE_PRESETS.find((preset) => preset.name === "Abby Sciuto")!.icon = "/test-preset.jpg";
    setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Character" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search reference options" }), { target: { value: "Abby Sciuto" } });
    const preset = within(dialog).getByRole("button", { name: /Abby Sciuto/ });
    expect(preset).toHaveClass("reference-preset-card--with-icon");
    expect(preset.querySelector(".reference-preset-icon")).toHaveAttribute("src");
    fireEvent.click(preset);

    // A built-in preset creates its own reference and supplies its artwork.
    const detailIcon = screen.getByAltText("Abby Sciuto reference icon");
    expect(detailIcon).toHaveAttribute("src");
    expect(detailIcon.parentElement).toHaveClass("reference-detail-art--preset");
  });

  it("searches location templates and allows editing their prompt directly", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Location" }));
    const groups = within(dialog).getByRole("tablist", { name: "Location subcategories" });
    fireEvent.click(within(groups).getByRole("tab", { name: "Sci-fi" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search reference options" }), { target: { value: "lunar" } });
    expect(within(dialog).getByRole("button", { name: /Lunar base/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Victorian manor/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "Time of day" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Lunar base/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const settings = screen.getByRole("region", { name: "Location settings" });
    expect(settings.closest("aside")).not.toBeNull();
    chooseOption(within(settings).getByRole("combobox", { name: "Time of day" }), "Night");
    chooseOption(within(settings).getByRole("combobox", { name: "Season" }), "Winter");

    expect(state.latest().references[0]).toMatchObject({
      intendedUse: ["location"],
      description: "Lunar base, at night, in winter.",
      content: "Lunar base, at night, in winter.",
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "A lunar research outpost in winter." } });
    expect(state.latest().references[0].intendedUse).toEqual(["location"]);
    expect(screen.queryByRole("region", { name: "Location settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("A lunar research outpost in winter.");
  });

  it("adds clothes and restores, updates, and clears their color and fabric settings", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const picker = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(picker).getByRole("button", { name: "Clothes" }));
    fireEvent.click(within(picker).getByRole("tab", { name: "Tops" }));
    fireEvent.click(within(picker).getByRole("button", { name: /T-shirt/ }));
    const settings = screen.getByRole("region", { name: "Clothing settings" });
    expect(settings.closest("aside")).not.toBeNull();
    chooseOption(within(settings).getByRole("combobox", { name: "Color" }), "Navy blue");
    chooseOption(within(settings).getByRole("combobox", { name: "Fabric" }), "Cotton");
    const saved = parseProjectConfig(JSON.parse(JSON.stringify(state.latest())));
    expect(saved.references[0]).toMatchObject({ intendedUse: ["clothing"], subcategory: "Tops", description: "T-shirt, in navy blue, made of cotton.", content: "T-shirt, in navy blue, made of cotton." });
    cleanup();
    const restored = setup(saved);
    expect(comboValue(screen.getByRole("combobox", { name: "Color" }))).toBe("navy-blue");
    expect(comboValue(screen.getByRole("combobox", { name: "Fabric" }))).toBe("cotton");
    choose("Color", "Red");
    choose("Fabric", "Linen");
    expect(restored.latest().references[0].description).toBe("T-shirt, in red, made of linen.");
    choose("Color", "None");
    expect(restored.latest().references[0].description).toBe("T-shirt, made of linen.");
    choose("Fabric", "None");
    expect(restored.latest().references[0].description).toBe("T-shirt.");
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "A hand-painted concert shirt." } });
    expect(screen.queryByRole("region", { name: "Clothing settings" })).not.toBeInTheDocument();
    expect(restored.latest().references[0].description).toBe("A hand-painted concert shirt.");
  });

  it("finds wearable accessories by subcategory and search", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const picker = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(picker).getByRole("button", { name: "Accessories" }));
    fireEvent.click(within(picker).getByRole("tab", { name: "Eyewear" }));
    fireEvent.change(within(picker).getByRole("textbox", { name: "Search reference options" }), { target: { value: "aviator" } });
    fireEvent.click(within(picker).getByRole("button", { name: /Aviator sunglasses/ }));
    expect(parseProjectConfig(state.latest()).references[0]).toMatchObject({ intendedUse: ["accessory"], subcategory: "Eyewear", name: "Aviator sunglasses", description: "Aviator sunglasses." });
    expect(screen.queryByRole("region", { name: "Clothing settings" })).not.toBeInTheDocument();
  });

  it("creates locations directly and restores, updates, and clears their saved settings in the inspector", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Location" }));
    expect(within(dialog).queryByText("Time of day")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Weather")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Coastal village/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.latest().references).toHaveLength(2);
    expect(comboValue(screen.getByRole("combobox", { name: "Weather" }))).toBe("");
    chooseOption(screen.getByRole("combobox", { name: "Time of day" }), "Night");
    chooseOption(screen.getByRole("combobox", { name: "Weather" }), "Rain");
    chooseOption(screen.getByRole("combobox", { name: "Season" }), "Winter");
    const saved = parseProjectConfig(state.latest());
    expect(saved.references[0].description).toBe("Coastal village, at night, in rain, in winter.");
    cleanup();
    const restored = setup(saved);
    expect(comboValue(screen.getByRole("combobox", { name: "Time of day" }))).toBe("night");
    expect(comboValue(screen.getByRole("combobox", { name: "Weather" }))).toBe("rain");
    expect(comboValue(screen.getByRole("combobox", { name: "Season" }))).toBe("winter");
    chooseOption(screen.getByRole("combobox", { name: "Weather" }), "None");
    expect(restored.latest().references[0]).toMatchObject({
      description: "Coastal village, at night, in winter.",
      content: "Coastal village, at night, in winter.",
    });
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const picker = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(picker).getByRole("button", { name: "Location" }));
    fireEvent.change(within(picker).getByRole("textbox", { name: "Search reference options" }), { target: { value: "lunar" } });
    fireEvent.click(within(picker).getByRole("button", { name: /Lunar base/ }));
    expect(restored.latest().references[0].description).toBe("Lunar base.");
    expect(restored.latest().references[1].description).toBe("Coastal village, at night, in winter.");
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const newPicker = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(newPicker).getByRole("button", { name: "Location" }));
    fireEvent.click(within(newPicker).getByRole("button", { name: /Coastal village/ }));
    expect(restored.latest().references[0].description).toBe("Coastal village.");
    expect(comboValue(screen.getByRole("combobox", { name: "Time of day" }))).toBe("");
  });

  it("attaches multiple images to a new product without changing its category or prompt", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue([
      { kind: "image", name: "front", relativePath: "references/front.png" },
      { kind: "image", name: "side", relativePath: "references/side.png" },
    ]);
    const state = setup();

    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Product" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "Add file" }));

    await waitFor(() => expect(state.latest().references[0].images).toHaveLength(2));
    expect(invoke).toHaveBeenCalledWith("choose_reference_files", { folderPath: "C:\\\\project" });
    expect(state.latest().references[0]).toMatchObject({
      kind: "text",
      name: "New product",
      description: "",
      intendedUse: ["product"],
      images: [
        { name: "front", relativePath: "references/front.png" },
        { name: "side", relativePath: "references/side.png" },
      ],
    });
    expect(state.latest().references[0]).not.toHaveProperty("relativePath");
  });
});

describe("Reference library views and selection", () => {
  const three = () => {
    const initial = project();
    const base = initial.references[0];
    initial.references = [
      base,
      { ...base, id: "ref-cat", name: "Cat", intendedUse: ["animal"] },
      { ...base, id: "ref-lamp", name: "Lamp", intendedUse: ["product"] },
    ];
    initial.generationJobs[0].referenceIds = ["ref-lamp"];
    return initial;
  };

  it("switches to a sortable Details view and remembers the choice", () => {
    setup(three());
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(localStorage.getItem("slopus.references.view")).toBe("details");
    const grid = screen.getByRole("grid", { name: "References" });
    const names = () => within(grid).getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent);
    expect(within(grid).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Name", "Type", "Contents", "Used by"]);
    expect(names()).toEqual(["Cat", "Hero", "Lamp"]);
    fireEvent.click(within(grid).getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["Lamp", "Hero", "Cat"]);
    fireEvent.click(within(grid).getByRole("button", { name: /Used by/ }));
    expect(names()[2]).toBe("Lamp");
    expect(within(grid).getByText("1 scene")).toBeInTheDocument();
  });

  it("multi-selects with Ctrl and Shift and deletes the selection", () => {
    const state = setup(three());
    fireEvent.click(screen.getByRole("option", { name: /^Hero/ }));
    fireEvent.click(screen.getByRole("option", { name: /^Lamp/ }), { shiftKey: true });
    expect(screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(3);
    fireEvent.click(screen.getByRole("option", { name: /^Cat/ }), { ctrlKey: true });
    expect(screen.getByRole("region", { name: "References status" })).toHaveTextContent("2 selected");
    // The inspector still edits one reference: the last one clicked.
    expect(screen.getByRole("textbox", { name: "Reference name" })).toHaveValue("Cat");
    const lamp = screen.getByRole("option", { name: /^Lamp/ });
    lamp.focus();
    fireEvent.keyDown(lamp, { key: "Delete" });
    expect(state.latest().references.map((reference) => reference.id)).toEqual(["ref-cat"]);
    expect(state.latest().generationJobs[0].referenceIds).toEqual([]);
  });

  it("moves through the library with the arrow keys and renames with F2", async () => {
    setup(three());
    const hero = screen.getByRole("option", { name: /^Hero/ });
    expect(hero).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("option", { name: /^Cat/ })).toHaveAttribute("tabindex", "-1");
    hero.focus();
    fireEvent.keyDown(hero, { key: "ArrowRight" });
    expect(screen.getByRole("option", { name: /^Cat/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("option", { name: /^Cat/ }), { key: "F2" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Reference name" })).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Reference name" })).toHaveValue("Cat");
  });

  it("opens a reference menu that lists the scenes using it", () => {
    const open = vi.fn();
    const initial = three();
    render(<ReferencesView config={initial} folderPath="C:\project" onChange={vi.fn()} onOpenGenerator={open} />);
    fireEvent.contextMenu(screen.getByRole("option", { name: /^Lamp/ }));
    const menu = screen.getByRole("menu", { name: "Lamp actions" });
    expect(within(menu).getByRole("menuitem", { name: /Show in File Explorer/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: `Open ${initial.generationJobs[0].title}` }));
    expect(open).toHaveBeenCalledWith(initial.generationJobs[0].id);
  });

  it("shows the shared empty state when nothing is selected", () => {
    setup({ ...project(), references: [] });
    expect(screen.getByText("Nothing selected")).toBeInTheDocument();
    expect(screen.getByText("Select a reference to see its details.")).toBeInTheDocument();
    expect(screen.getByText("No references yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New reference" })).toBeInTheDocument();
  });
});
