// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig, type ProjectConfig } from "../../lib/project";
import { ReferencesView } from "./ReferencesView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
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

function setup(initial = project()) {
  let latest = initial;
  function Harness() {
    const [config, setConfig] = useState(latest);
    latest = config;
    return <ReferencesView config={config} folderPath="C:\\project" onChange={setConfig} />;
  }
  render(<Harness />);
  return { latest: () => latest };
}

describe("Reference type presets", () => {
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
    expect(within(dialog).getByRole("button", { name: "Text" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Use Text" }));
    expect(state.latest().references[0]).toMatchObject({ name: "New definition", intendedUse: [] });
  });

  it("shows one Type control without the old explanatory copy", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Text" })).toBeInTheDocument();
    expect(screen.queryByText("Intended use")).not.toBeInTheDocument();
    expect(screen.queryByText(/Select any that apply/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("A traveler with a weathered red coat.");
  });

  it("chooses one prepared character from the scalable popup", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a reference type" });
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
    expect(screen.queryByRole("textbox", { name: "Prompt" })).not.toBeInTheDocument();
    expect(screen.getByText("Sherlock Holmes · Benedict Cumberbatch")).toBeInTheDocument();
  });

  it("shows a bundled MiniMax icon for an illustrated character preset", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a reference type" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Character" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search reference options" }), { target: { value: "Abby Sciuto" } });
    const preset = within(dialog).getByRole("button", { name: /Abby Sciuto/ });
    expect(preset).toHaveClass("reference-preset-card--with-icon");
    expect(preset.querySelector(".reference-preset-icon")).toHaveAttribute("src");
    fireEvent.click(preset);

    // Choosing a preset changes the definition, not the user's own reference
    // name. The selected preset still supplies the matching artwork.
    const detailIcon = screen.getByAltText("Hero reference icon");
    expect(detailIcon).toHaveAttribute("src");
    expect(detailIcon.parentElement).toHaveClass("reference-detail-art--preset");
  });

  it("searches location templates and can return to a custom prompt", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a reference type" });
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

    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    const reopened = screen.getByRole("dialog", { name: "Choose a reference type" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Text" }));
    fireEvent.click(within(reopened).getByRole("button", { name: "Use Text" }));

    expect(state.latest().references[0].intendedUse).toEqual([]);
    expect(screen.queryByRole("region", { name: "Location settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Lunar base, at night, in winter.");
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
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    const picker = screen.getByRole("dialog", { name: "Choose a reference type" });
    fireEvent.change(within(picker).getByRole("textbox", { name: "Search reference options" }), { target: { value: "lunar" } });
    fireEvent.click(within(picker).getByRole("button", { name: /Lunar base/ }));
    expect(restored.latest().references[0].description).toBe("Lunar base, at night, in winter.");
    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const newPicker = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(newPicker).getByRole("button", { name: "Location" }));
    fireEvent.click(within(newPicker).getByRole("button", { name: /Coastal village/ }));
    expect(restored.latest().references[0].description).toBe("Coastal village.");
    expect(screen.getByRole("combobox", { name: "Time of day" })).toHaveValue("");
  });

  it("creates one image-only reference with every selected picture attached", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue([
      { name: "front", relativePath: "references/front.png" },
      { name: "side", relativePath: "references/side.png" },
    ]);
    const state = setup();

    fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
    const dialog = screen.getByRole("dialog", { name: "Add a reference" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Image" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose images" }));

    await waitFor(() => expect(state.latest().references).toHaveLength(2));
    expect(invoke).toHaveBeenCalledWith("choose_reference_images", { folderPath: "C:\\\\project" });
    expect(state.latest().references[0]).toMatchObject({
      kind: "text",
      name: "front",
      description: "",
      images: [
        { name: "front", relativePath: "references/front.png" },
        { name: "side", relativePath: "references/side.png" },
      ],
    });
    expect(state.latest().references[0]).not.toHaveProperty("relativePath");
  });
});
