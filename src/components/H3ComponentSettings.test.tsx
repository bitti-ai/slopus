// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import { loadGeneratorTemplateSettings, saveGeneratorTemplateSettings } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => localStorage.clear());
afterEach(cleanup);
const open = (advanced = true) => {
  render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "MiniMax H3" }));
  if (advanced) fireEvent.click(screen.getByRole("button", { name: "Advanced Options" }));
};
const pick = (label: string, name: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(screen.getByRole("option", { name }));
};

it("opens VAEs and Text Encoders from Advanced Options after LoRAs and preserves generator links", async () => {
  open(false);
  expect(screen.queryByRole("heading", { name: "VAEs" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Text Encoders" })).not.toBeInTheDocument();
  const advanced = screen.getByRole("button", { name: "Advanced Options" });
  for (const heading of screen.getAllByRole("heading").filter((heading) => /LoRAs/i.test(heading.textContent ?? ""))) {
    expect(heading.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  fireEvent.click(advanced);
  expect(screen.getByRole("heading", { level: 1, name: "Advanced Options" })).toHaveFocus();
  const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
  expect(headings.indexOf("VAEs")).toBeLessThan(headings.indexOf("Text Encoders"));
  expect(headings.some((heading) => /LoRAs/i.test(heading ?? ""))).toBe(false);
  expect(screen.queryByRole("button", { name: "Edit First/Last Frame generator" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("button", { name: "Advanced Options" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Advanced Options" }));
  fireEvent.keyDown(screen.getByRole("main", { name: "Settings" }), { key: "Escape" });
  expect(screen.getByRole("button", { name: "Advanced Options" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Advanced Options" }));
  fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "MiniMax H3" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit First/Last Frame generator" }));
  expect(screen.queryByRole("button", { name: "Browse for Text encoder weights" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Browse for Video VAE weights" })).not.toBeInTheDocument();
  pick("Video VAE", "Sol H3 VAE");
  await waitFor(() => expect(loadGeneratorTemplateSettings().templates.find((entry) => entry.id === "minimax-h3-original")?.videoVaeId).toBe("sol-h3-vae"));
  fireEvent.click(screen.getByRole("combobox", { name: "Audio VAE" }));
  expect(screen.queryByRole("option", { name: "Sol H3 VAE" })).not.toBeInTheDocument();
  expect(screen.getByRole("option", { name: "MiniMax H3 Audio VAE" })).toBeInTheDocument();
});

it("creates named audio and video VAEs and persists edits", async () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: "New VAE" }));
  fireEvent.change(screen.getByRole("textbox", { name: "VAE name" }), { target: { value: "My audio decoder" } });
  pick("VAE type", "Audio");
  fireEvent.change(screen.getByRole("textbox", { name: "Weight path or URL" }), { target: { value: "https://example.com/audio.safetensors" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit My audio decoder VAE" })).toBeInTheDocument());
  expect(loadGeneratorTemplateSettings().h3Components!.templates.find((entry) => entry.name === "My audio decoder")).toMatchObject({ type: "audio", path: "https://example.com/audio.safetensors" });
  fireEvent.click(screen.getByRole("button", { name: "Edit My audio decoder VAE" }));
  pick("VAE type", "Video");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(loadGeneratorTemplateSettings().h3Components!.templates.find((entry) => entry.name === "My audio decoder")?.type).toBe("video"));
});

it("selects a default text encoder for every H3 generator and keeps other families unchanged", async () => {
  open();
  const library = loadGeneratorTemplateSettings().h3Components!;
  const previousDefault = library.templates.find((entry) => entry.id === library.defaultTextEncoderId)!;
  expect(screen.queryByRole("combobox", { name: "Default Text Encoder" })).not.toBeInTheDocument();
  expect(screen.queryByText("Default Text Encoder")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: `Set ${previousDefault.name} as default` })).not.toBeInTheDocument();
  const mossBefore = loadGeneratorTemplateSettings().templates.find((entry) => entry.modelType === "moss")!.paths.textEncoder;
  fireEvent.click(screen.getByRole("button", { name: "New text encoder" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Text encoder name" }), { target: { value: "My encoder" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Weight path or URL" }), { target: { value: "D:/encoder.safetensors" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Edit My encoder text encoder" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Set My encoder as default" }));
  await waitFor(() => {
    const settings = loadGeneratorTemplateSettings();
    expect(settings.templates.filter((entry) => entry.modelType === "minimax-h3").every((entry) => entry.paths.textEncoder === "D:/encoder.safetensors")).toBe(true);
    expect(settings.templates.find((entry) => entry.modelType === "moss")?.paths.textEncoder).toBe(mossBefore);
  });
  expect(screen.queryByRole("button", { name: "Set My encoder as default" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: `Set ${previousDefault.name} as default` })).toBeInTheDocument();
});

it("preserves downloaded paths when a template is renamed during a download", async () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: "Edit Sol H3 VAE VAE" }));
  fireEvent.change(screen.getByRole("textbox", { name: "VAE name" }), { target: { value: "Sol decoder" } });
  await act(async () => {
    const settings = loadGeneratorTemplateSettings();
    const sol = settings.h3Components!.templates.find((entry) => entry.id === "sol-h3-vae")!;
    sol.path = "D:/downloaded-sol.safetensors"; sol.sources[0].downloadedPath = sol.path;
    saveGeneratorTemplateSettings(settings);
  });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
  expect(loadGeneratorTemplateSettings().h3Components!.templates.find((entry) => entry.id === "sol-h3-vae")).toMatchObject({ name: "Sol decoder", path: "D:/downloaded-sol.safetensors" });
});
