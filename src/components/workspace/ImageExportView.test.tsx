// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/project-v1-image.json";
import { parseProjectConfig, type ProjectConfig } from "../../lib/project";
import * as persistence from "../../lib/persistence";
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
  expect(within(settings).getByText("2048 × 1152 px")).toBeInTheDocument();
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
