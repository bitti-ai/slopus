// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig, type ProjectConfig } from "../../lib/project";
import { ReferencesView } from "./ReferencesView";
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
  it("shows the exact icon regeneration prompt in a debug-only footer dialog", () => {
    const regenerate = vi.fn();
    const state = setup(project(), regenerate);
    expect(screen.queryByRole("button", { name: "Debug Icon Prompt" })).not.toBeInTheDocument();
    act(() => saveDebugOptionsEnabled(true));
    const button = screen.getByRole("button", { name: "Debug Icon Prompt" });
    expect(button.closest(".reference-inspector")?.lastElementChild).toBe(button.parentElement);
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Debug Icon Prompt" });
    expect(dialog.closest("aside")).toBeNull();
    expect(within(dialog).getByLabelText("The reference icon generation prompt").textContent).toBe(referenceIconPrompt(state.latest().references[0]));
    expect(within(dialog).getByRole("button", { name: "Close debug icon prompt" })).toHaveFocus();
    expect(regenerate).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(within(dialog).getByLabelText("The reference icon generation prompt")).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Debug Icon Prompt" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    act(() => saveDebugOptionsEnabled(false));
    expect(screen.queryByRole("dialog", { name: "Debug Icon Prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Debug Icon Prompt" })).not.toBeInTheDocument();
  });

  it("uses the selected reference's latest name, category, subcategory and description", () => {
    saveDebugOptionsEnabled(true);
    const initial = project();
    initial.references.push({ ...initial.references[0], id: "ref-animal", name: "Pet", intendedUse: ["animal"], subcategory: "Pets", description: "A golden retriever." });
    const state = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: /Pet A golden retriever/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reference name" }), { target: { value: "Buddy" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "A sleepy golden retriever.\nSoft light." } });
    fireEvent.click(screen.getByRole("button", { name: "Debug Icon Prompt" }));
    const prompt = screen.getByLabelText("The reference icon generation prompt");
    expect(prompt.textContent).toBe(referenceIconPrompt(state.latest().references[1]));
    expect(prompt.textContent).toContain("animal with its whole body visible");
    expect(prompt.textContent).toContain("Subcategory: Pets");
    fireEvent.click(screen.getByRole("button", { name: "Close debug icon prompt" }));
    expect(screen.queryByRole("dialog", { name: "Debug Icon Prompt" })).not.toBeInTheDocument();
  });

  it("does not show icon debugging without a selected reference", () => {
    saveDebugOptionsEnabled(true);
    setup({ ...project(), references: [] });
    expect(screen.queryByRole("button", { name: "Debug Icon Prompt" })).not.toBeInTheDocument();
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
    fireEvent.click(within(dialog).getByRole("button", { name: "Pets" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search reference options" }), { target: { value: "retriever" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Golden retriever/ }));
    expect(state.latest().references[0]).toMatchObject({ name: "Golden retriever", intendedUse: ["animal"], subcategory: "Pets", description: "Golden retriever." });
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("animal");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Golden retriever.");
  });

  it.each([
    ["Character", "character", "Animation"],
    ["Animal", "animal", "Pets"],
    ["Product", "product", "Technology"],
    ["Location", "location", "Urban"],
    ["Style", "style", "Cinematic"],
  ])("creates and saves an editable %s with its subcategory", (label, category, subcategory) => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: label }));
    fireEvent.click(within(dialog).getByRole("button", { name: subcategory }));
    fireEvent.click(within(dialog).getByRole("button", { name: "New" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.latest().references).toHaveLength(2);
    expect(state.latest().references[0]).toMatchObject({ description: "", content: null, intendedUse: [category], subcategory });
    expect(screen.getByRole("combobox", { name: "Subcategory" })).toHaveValue(subcategory);
    fireEvent.change(screen.getByRole("textbox", { name: "Reference name" }), { target: { value: "My reference" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Keep the cool blue colors." } });
    const saved = parseProjectConfig(state.latest());
    cleanup();
    const restored = setup(saved);
    expect(screen.getByRole("textbox", { name: "Reference name" })).toHaveValue("My reference");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Keep the cool blue colors.");
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue(category);
    expect(screen.getByRole("combobox", { name: "Subcategory" })).toHaveValue(subcategory);
    fireEvent.change(screen.getByRole("combobox", { name: "Subcategory" }), { target: { value: "" } });
    expect(restored.latest().references[0].subcategory).toBe("");
    const nextCategory = category === "product" ? "style" : "product";
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: nextCategory } });
    expect(restored.latest().references[0]).toMatchObject({ intendedUse: [nextCategory], subcategory: "", description: "Keep the cool blue colors." });
  });

  it("renames the selected reference from the inspector header", () => {
    const state = setup();
    const name = screen.getByRole("textbox", { name: "Reference name" });
    const header = name.closest("header");

    expect(name).toHaveValue("Hero");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("button", { name: "Remove reference" })).toHaveClass("inspector-remove-button");
    fireEvent.change(name, { target: { value: "Lead traveler" } });

    expect(state.latest().references[0].name).toBe("Lead traveler");
    expect(screen.getByRole("button", { name: /Lead traveler/ })).toBeInTheDocument();
  });

  it("opens the new-reference picker from the add card", () => {
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
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("custom");
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
    const groups = within(dialog).getByRole("group", { name: "Character subcategories" });
    expect(within(groups).getByRole("button", { name: "Film" })).toBeInTheDocument();
    expect(within(groups).getByRole("button", { name: "Television" })).toBeInTheDocument();
    expect(within(groups).getByRole("button", { name: "Public figures" })).toBeInTheDocument();
    fireEvent.click(within(groups).getByRole("button", { name: "Television" }));
    expect(within(dialog).getByRole("button", { name: /Sherlock Holmes · Benedict Cumberbatch/ })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Sherlock Holmes · Benedict Cumberbatch/ }));

    const reference = state.latest().references[0];
    expect(reference.intendedUse).toEqual(["character"]);
    expect(reference.description).toBe("Sherlock Holmes, Benedict Cumberbatch portrayal.");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue(reference.description);
    expect(screen.getByRole("combobox", { name: "Subcategory" })).toHaveValue("Television");
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
    const groups = within(dialog).getByRole("group", { name: "Location subcategories" });
    fireEvent.click(within(groups).getByRole("button", { name: "Sci-fi" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search reference options" }), { target: { value: "lunar" } });
    expect(within(dialog).getByRole("button", { name: /Lunar base/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Victorian manor/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: "Time of day" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Lunar base/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const settings = screen.getByRole("region", { name: "Location settings" });
    expect(settings.closest("aside")).not.toBeNull();
    fireEvent.change(within(settings).getByRole("combobox", { name: "Time of day" }), { target: { value: "night" } });
    fireEvent.change(within(settings).getByRole("combobox", { name: "Season" }), { target: { value: "winter" } });

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
    expect(screen.getByRole("combobox", { name: "Weather" })).toHaveValue("");
    fireEvent.change(screen.getByRole("combobox", { name: "Time of day" }), { target: { value: "night" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Weather" }), { target: { value: "rain" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Season" }), { target: { value: "winter" } });
    const saved = parseProjectConfig(state.latest());
    expect(saved.references[0].description).toBe("Coastal village, at night, in rain, in winter.");
    cleanup();
    const restored = setup(saved);
    expect(screen.getByRole("combobox", { name: "Time of day" })).toHaveValue("night");
    expect(screen.getByRole("combobox", { name: "Weather" })).toHaveValue("rain");
    expect(screen.getByRole("combobox", { name: "Season" })).toHaveValue("winter");
    fireEvent.change(screen.getByRole("combobox", { name: "Weather" }), { target: { value: "" } });
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
    expect(screen.getByRole("combobox", { name: "Time of day" })).toHaveValue("");
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
