// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectConfig, parseProjectConfig, type ProjectConfig } from "../../lib/project";
import { ReferencesView } from "./ReferencesView";

afterEach(cleanup);

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

function setup() {
  let latest = project();
  function Harness() {
    const [config, setConfig] = useState(latest);
    latest = config;
    return <ReferencesView config={config} folderPath="C:\\project" onChange={setConfig} />;
  }
  render(<Harness />);
  return { latest: () => latest };
}

describe("Reference type presets", () => {
  it("opens the type picker immediately for a new definition", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "New definition" }));

    const dialog = screen.getByRole("dialog", { name: "Choose a reference type" });
    expect(dialog).toBeInTheDocument();
    expect(state.latest().references[0]).toMatchObject({ name: "New definition", intendedUse: [] });
    expect(within(dialog).getByRole("button", { name: "Custom" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows one Type control without the old explanatory copy", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Type" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Custom" })).toBeInTheDocument();
    expect(screen.queryByText("Intended use")).not.toBeInTheDocument();
    expect(screen.queryByText(/Select any that apply/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("A traveler with a weathered red coat.");
  });

  it("chooses one prepared character from the scalable popup", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
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

  it("searches location templates and can return to a custom prompt", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const dialog = screen.getByRole("dialog", { name: "Choose a reference type" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Location" }));
    const groups = within(dialog).getByRole("group", { name: "Location subcategories" });
    fireEvent.click(within(groups).getByRole("button", { name: "Sci-fi" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search reference options" }), { target: { value: "lunar" } });
    expect(within(dialog).getByRole("button", { name: /Lunar research base/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Victorian manor/ })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /Lunar research base/ }));

    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    const reopened = screen.getByRole("dialog", { name: "Choose a reference type" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Custom" }));
    fireEvent.click(within(reopened).getByRole("button", { name: "Use Custom" }));

    expect(state.latest().references[0].intendedUse).toEqual([]);
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("White lunar base under harsh sunlight.");
  });
});
