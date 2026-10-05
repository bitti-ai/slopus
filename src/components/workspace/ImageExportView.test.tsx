// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/project-v1-image.json";
import { parseProjectConfig, type ProjectConfig } from "../../lib/project";
import * as persistence from "../../lib/persistence";
import { invoke } from "@tauri-apps/api/core";
import { ImageExportView } from "./ImageExportView";
import { imageGenerationSnapshot } from "../../lib/imageHistory";
import { OTHER_WEIGHT_TEMPLATES } from "../../lib/upscalers";
import { resetExportJobForTests } from "../../lib/exportJob";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => { cleanup(); resetExportJobForTests(); localStorage.clear(); vi.restoreAllMocks(); });

function withOutput(patch: Partial<ProjectConfig["assets"][number]> = {}): ProjectConfig {
  const config = parseProjectConfig(fixture);
  config.assets = [{ id: "out", name: "Out", kind: "image", relativePath: "media/generated/out.png", mimeType: "image/png", createdAt: config.createdAt, ...patch } as ProjectConfig["assets"][number]];
  config.imageScene!.outputAssetId = "out";
  return config;
}

it("lays the page out like the video export: stage, splitter, settings pane with a pinned Export…", () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const { container } = render(<ImageExportView config={withOutput({ width: 2048, height: 1152 })} folderPath="D:/Images" />);
  const body = container.querySelector(".export-body")!;
  expect(Array.from(body.children).map((child) => child.className.split(" ")[0])).toEqual(["export-preview", "ui-splitter", "export-settings"]);
  expect(screen.getByRole("separator", { name: "Resize export settings" })).toBeInTheDocument();
  const settings = screen.getByRole("region", { name: "Export settings" });
  expect(settings.querySelector(".export-settings__scroll")?.firstElementChild).toHaveClass("ui-prop-section");
  expect(within(settings).getByRole("combobox", { name: "Resolution" })).toHaveTextContent("2048 × 1152 (original)");
  const foot = settings.querySelector(".export-settings__foot")!;
  expect(within(foot as HTMLElement).getByRole("button", { name: "Export…" })).toBeEnabled();
  expect(screen.queryByText("Nothing to export yet")).not.toBeInTheDocument();
});

it("refuses to export a draft and says why", () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  render(<ImageExportView config={withOutput({ imageDraft: true })} folderPath="D:/Images" />);
  const button = screen.getByRole("button", { name: "Export…" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("data-tooltip", "This image is still a draft. Generate it before exporting.");
  expect(screen.getByText("The image is a draft")).toBeInTheDocument();
});

it.each(OTHER_WEIGHT_TEMPLATES)("exports with the selected $name model paths", async (template) => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.mocked(invoke).mockImplementation(async (command) => command === "choose_image_export_destination" ? "D:/out.jpg" : 123);
  localStorage.setItem("slopus.other-weights.v1", JSON.stringify(Object.fromEntries(template.files.map((file) => [file.url, `C:/weights/${file.id}`]))));
  localStorage.setItem("slopus.generation-worker.v1", JSON.stringify({ id: "worker", name: "Worker", gpus: [] }));
  render(<ImageExportView config={withOutput({ width: 64, height: 32 })} folderPath="D:/Images" />);
  const selector = screen.getByRole("combobox", { name: "Upscaler" });
  expect(selector).toHaveTextContent("None");
  fireEvent.click(selector);
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "Real-ESRGAN", "SeedVR2"]);
  fireEvent.click(screen.getByRole("option", { name: template.name }));
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_generated_image", expect.objectContaining({
    options: expect.objectContaining({ width: 64, height: 32, upscale: { method: template.id, modelPath: template.id === "seedvr2" ? "" : "C:/weights/model" } }),
  })));
});

it("sends the chosen size, format and JPG quality, and hides quality for PNG", async () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.mocked(invoke).mockImplementation(async (command) => command === "choose_image_export_destination" ? "D:/out.jpg" : 123);
  render(<ImageExportView config={withOutput({ width: 2048, height: 1152 })} folderPath="D:/Images" />);
  fireEvent.change(screen.getByRole("slider", { name: "JPG quality" }), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("combobox", { name: "Resolution" }));
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "2048 × 1152 (original)", "1280 × 720", "1920 × 1080", "2560 × 1440", "3840 × 2160",
  ]);
  fireEvent.click(screen.getByRole("option", { name: "3840 × 2160" }));
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_generated_image", {
    jobId: expect.any(String), destination: "D:/out.jpg",
    folderPath: "D:/Images", relativePath: "media/generated/out.png",
    options: { format: "jpg", width: 3840, height: 2160, quality: 60 },
  }));
  expect(JSON.parse(localStorage.getItem("slopus.image-export.v1")!)).toEqual({ format: "jpg", quality: 60 });
  fireEvent.click(screen.getByRole("combobox", { name: "Format" }));
  fireEvent.click(screen.getByRole("option", { name: /PNG/ }));
  expect(screen.queryByRole("slider", { name: "JPG quality" })).toBeNull();
});

it.each([
  [768, 1376, ["720 × 1280", "1080 × 1920", "1440 × 2560", "2160 × 3840"]],
  [1056, 1024, ["512 × 512", "1024 × 1024", "1080 × 1080", "2048 × 2048", "4096 × 4096"]],
  [832, 1024, ["720 × 900", "1080 × 1350", "1440 × 1800", "2160 × 2700", "3072 × 3840"]],
] as const)("offers the closest presets for a %s × %s image despite different saved and project ratios", (width, height, labels) => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const config = withOutput({ width, height });
  config.assets[0].imageGeneration = { ...imageGenerationSnapshot(config, "", "test"), aspectRatio: "16:9" };
  render(<ImageExportView config={config} folderPath="D:/Images" />);
  fireEvent.click(screen.getByRole("combobox", { name: "Resolution" }));
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([`${width} × ${height} (original)`, ...labels]);
});

it("keeps Original selected across images and omits duplicate presets", () => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const config = withOutput({ width: 1920, height: 1080 });
  config.assets.push({ ...config.assets[0], id: "second", name: "Second", width: 5760, height: 3240 });
  render(<ImageExportView config={config} folderPath="D:/Images" />);
  fireEvent.click(screen.getByRole("combobox", { name: "Resolution" }));
  expect(screen.queryByRole("option", { name: "1920 × 1080" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "1920 × 1080 (original)" }));
  fireEvent.click(screen.getByRole("button", { name: "View Second" }));
  expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveTextContent("5760 × 3240 (original)");
  fireEvent.click(screen.getByRole("combobox", { name: "Resolution" }));
  expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
    "5760 × 3240 (original)", "1280 × 720", "1920 × 1080", "2560 × 1440", "3840 × 2160",
  ]);
});

it("shows the image bar and exports the image picked in it, leaving the Editor's image alone", async () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.mocked(invoke).mockImplementation(async (command) => command === "choose_image_export_destination" ? "D:/out.jpg" : 123);
  const config = withOutput({ width: 2048, height: 1152 });
  config.assets.push({ id: "second", name: "Second", kind: "image", relativePath: "media/generated/second.jpg", mimeType: "image/jpeg", width: 768, height: 1376, createdAt: config.createdAt } as ProjectConfig["assets"][number]);
  render(<ImageExportView config={config} folderPath="D:/Images" />);
  fireEvent.click(screen.getByRole("combobox", { name: "Resolution" }));
  fireEvent.click(screen.getByRole("option", { name: "1920 × 1080" }));
  const bar = screen.getByLabelText("Generated images");
  expect(within(bar).getByRole("button", { name: "View Out" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(bar).getByRole("button", { name: "View Second" }));
  expect(within(bar).getByRole("button", { name: "View Second" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveTextContent("768 × 1376 (original)");
  fireEvent.click(screen.getByRole("combobox", { name: "Resolution" }));
  expect(screen.queryByRole("option", { name: "1920 × 1080" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("option", { name: "1080 × 1920" }));
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_generated_image", expect.objectContaining({
    relativePath: "media/generated/second.jpg", options: { format: "jpg", width: 1080, height: 1920, quality: 90 },
  })));
  expect(config.imageScene!.outputAssetId).toBe("out");
});

it("steps through the image bar with the arrow keys without opening an image", () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const config = withOutput({ width: 2048, height: 1152 });
  for (const name of ["Second", "Third"]) config.assets.push({ id: name, name, kind: "image", relativePath: `media/generated/${name}.jpg`, mimeType: "image/jpeg", width: 1024, height: 576, createdAt: config.createdAt } as ProjectConfig["assets"][number]);
  render(<ImageExportView config={config} folderPath="D:/Images" />);
  const bar = screen.getByLabelText("Generated images");
  const [out, second, third] = ["Out", "Second", "Third"].map((name) => within(bar).getByRole("button", { name: `View ${name}` }));
  bar.focus();
  fireEvent.keyDown(bar, { key: "ArrowRight" });
  expect(out).toHaveFocus();
  fireEvent.keyDown(out, { key: "ArrowRight" });
  expect(second).toHaveFocus();
  fireEvent.keyDown(second, { key: "End" });
  expect(third).toHaveFocus();
  fireEvent.keyDown(third, { key: "ArrowRight" });
  expect(third).toHaveFocus();
  fireEvent.keyDown(third, { key: "ArrowLeft" });
  expect(second).toHaveFocus();
  expect(out).toHaveAttribute("aria-pressed", "true");
});
