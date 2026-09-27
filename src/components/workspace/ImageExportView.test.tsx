// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/project-v1-image.json";
import { parseProjectConfig, type ProjectConfig } from "../../lib/project";
import * as persistence from "../../lib/persistence";
import { invoke } from "@tauri-apps/api/core";
import { ImageExportView } from "./ImageExportView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

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

it("sends the chosen size, format and JPG quality, and hides quality for PNG", async () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.mocked(invoke).mockResolvedValue(true);
  render(<ImageExportView config={withOutput({ width: 2048, height: 1152 })} folderPath="D:/Images" />);
  fireEvent.change(screen.getByRole("slider", { name: "JPG quality" }), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_generated_image", {
    folderPath: "D:/Images", relativePath: "media/generated/out.png",
    options: { format: "jpg", width: 2048, height: 1152, quality: 60 },
  }));
  expect(JSON.parse(localStorage.getItem("slopus.image-export.v1")!)).toEqual({ format: "jpg", quality: 60 });
  fireEvent.click(screen.getByRole("combobox", { name: "Format" }));
  fireEvent.click(screen.getByRole("option", { name: /PNG/ }));
  expect(screen.queryByRole("slider", { name: "JPG quality" })).toBeNull();
});

it("shows the image bar and exports the image picked in it, leaving the Editor's image alone", async () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.mocked(invoke).mockResolvedValue(true);
  const config = withOutput({ width: 2048, height: 1152 });
  config.assets.push({ id: "second", name: "Second", kind: "image", relativePath: "media/generated/second.jpg", mimeType: "image/jpeg", width: 1024, height: 576, createdAt: config.createdAt } as ProjectConfig["assets"][number]);
  render(<ImageExportView config={config} folderPath="D:/Images" />);
  const bar = screen.getByLabelText("Generated images");
  expect(within(bar).getByRole("button", { name: "View Out" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(within(bar).getByRole("button", { name: "View Second" }));
  expect(within(bar).getByRole("button", { name: "View Second" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveTextContent("1024 × 576 (original)");
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_generated_image", expect.objectContaining({ relativePath: "media/generated/second.jpg" })));
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
