// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig } from "../../lib/project";
import { inspectReferenceVideo } from "../../lib/referenceVideo";
import { ReferencesView } from "./ReferencesView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/referenceVideo", () => ({ inspectReferenceVideo: vi.fn() }));
vi.mock("./ReferenceVideo", () => ({ ReferenceVideo: () => <div>Video preview</div> }));
vi.mock("./MediaThumbnail", () => ({ MediaThumbnail: ({ asset, posterTimeSeconds }: { asset: { sourcePath: string; name: string }; posterTimeSeconds: number }) => <img alt={`Frame from ${asset.name}`} src={`test:${asset.sourcePath}:${posterTimeSeconds}`} /> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it("attaches mixed files through Add file and renders an icon with an enabled refmod", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(invoke).mockResolvedValue([
    { kind: "image", name: "photo", relativePath: "references/photo.png" },
    { kind: "video", name: "motion", sourcePath: "D:/motion.mp4" },
    { kind: "refmod", name: "person.safetensors", sourcePath: "D:/person.safetensors" },
  ]);
  vi.mocked(inspectReferenceVideo).mockResolvedValue({ durationSeconds: 4, includeAudio: false });
  const renderIcon = vi.fn();
  let latest = createProjectConfig({ name: "Mixed", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  latest.references = [{ id: "ref", name: "Uncategorized", description: "", kind: "text", intendedUse: [], createdAt: latest.createdAt }];
  function Harness() {
    const [config, setConfig] = useState(latest); latest = config;
    return <ReferencesView folderPath="C:/mixed" config={config} onChange={setConfig} onRegenerateIcon={renderIcon} />;
  }
  render(<Harness />);
  expect(screen.queryByRole("button", { name: "Add images" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add video" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add file" }));
  await screen.findByRole("heading", { name: "Refmods" });
  const icon = screen.getByRole("button", { name: "Regenerate reference icon" });
  expect(icon.closest(".reference-detail-art")).not.toBeNull();
  expect(icon).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Render icon with refmod" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Prompt")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add file" })).toBeDisabled();
  vi.mocked(invoke).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Add file" }));
  expect(invoke).not.toHaveBeenCalled();
  expect(parseProjectConfig(latest).references[0]).toMatchObject({ kind: "video", sourcePath: "D:/motion.mp4", images: [{ relativePath: "references/photo.png" }], refmods: [{ sourcePath: "D:/person.safetensors", strength: 1, copies: 1 }] });
  fireEvent.change(screen.getByLabelText("person.safetensors strength"), { target: { value: "0.7" } });
  fireEvent.change(screen.getByLabelText("person.safetensors copies"), { target: { value: "2" } });
  fireEvent.click(icon);
  expect(renderIcon).toHaveBeenCalledWith("ref");
  expect(latest.references[0].refmods![0]).toMatchObject({ strength: 0.7, copies: 2 });
  fireEvent.change(screen.getByLabelText("person.safetensors strength"), { target: { value: "0" } });
  expect(icon).toBeDisabled();
  expect(screen.getByLabelText("Prompt")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Add file" })).toBeDisabled();
  const removeRefmods = screen.getByRole("button", { name: "Remove refmods" });
  expect(removeRefmods.closest("header")).toContainElement(screen.getByRole("heading", { name: "Refmods" }));
  expect(removeRefmods).toHaveTextContent("");
  fireEvent.click(removeRefmods);
  expect(latest.references[0].refmods).toEqual([]);
  expect(latest.references[0].images).toHaveLength(1);
  expect(latest.references[0].kind).toBe("video");
  expect(screen.getByLabelText("Prompt")).toBeEnabled();
  expect(screen.getByRole("button", { name: "Add file" })).toBeEnabled();
});

it("shows an existing refmod icon only in the normal inspector slot and clears it on removal", () => {
  const config = createProjectConfig({ name: "Refmod", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  const filename = `${"long-refmod-filename-".repeat(12)}.safetensors`;
  config.references = [{ id: "ref", name: "Person", kind: "text", description: "Existing description", intendedUse: [], createdAt: config.createdAt,
    iconRelativePath: "references/icons/person.png", refmods: [{ id: "mod", name: filename, sourcePath: `D:/${filename}`, strength: 1, copies: 1 }] }];
  const onChange = vi.fn();
  const { container } = render(<ReferencesView folderPath="C:/project" config={config} onChange={onChange} onRegenerateIcon={vi.fn()} pendingIconIds={new Set(["ref"])} />);
  expect(container.querySelector(".reference-detail-art .reference-detail-preset-icon")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Refmod attachments" })).queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByTitle(filename)).toHaveTextContent(filename);
  expect(screen.getByRole("button", { name: "Regenerate reference icon" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove refmods" }));
  expect(onChange.mock.calls[0][0].references[0]).toMatchObject({ description: "Existing description", refmods: [], iconRelativePath: undefined });
});

it("imports a video, edits its saved trim and soundtrack, then removes its attachment", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(invoke).mockResolvedValue([{ kind: "video", name: "motion.mp4", sourcePath: "C:/motion.mp4" }]);
  vi.mocked(inspectReferenceVideo).mockResolvedValue({ durationSeconds: 10, includeAudio: true });
  let latest = createProjectConfig({ name: "Video", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 20 });
  function Harness() {
    const [config, setConfig] = useState(latest); latest = config;
    return <ReferencesView folderPath="C:/project" config={config} onChange={setConfig} />;
  }
  render(<Harness />);
  expect(screen.queryByRole("button", { name: "Import video" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
  const picker = screen.getByRole("dialog", { name: "Add a reference" });
  fireEvent.click(within(picker).getByRole("button", { name: "Other" }));
  expect(within(picker).queryByRole("textbox")).not.toBeInTheDocument();
  expect(within(picker).queryByRole("group")).not.toBeInTheDocument();
  expect(within(picker).queryByText("No options match that search.")).not.toBeInTheDocument();
  fireEvent.click(within(picker).getByRole("button", { name: "New" }));
  expect(latest.references[0]).toMatchObject({ name: "Uncategorized", kind: "text", intendedUse: [] });
  fireEvent.click(screen.getByRole("button", { name: "Add file" }));
  await screen.findByText("Video preview");
  expect(invoke).toHaveBeenCalledWith("choose_reference_files", { folderPath: "C:/project" });
  expect(screen.getByRole("img", { name: "Frame from Uncategorized" })).toHaveAttribute("src", "test:C:/motion.mp4:0");
  fireEvent.change(screen.getByLabelText("Clip start (seconds)"), { target: { value: "2" } });
  fireEvent.blur(screen.getByLabelText("Clip start (seconds)"));
  fireEvent.change(screen.getByLabelText("Clip duration (seconds)"), { target: { value: "4" } });
  fireEvent.blur(screen.getByLabelText("Clip duration (seconds)"));
  fireEvent.click(screen.getByLabelText("Include sound"));
  expect(parseProjectConfig(JSON.parse(JSON.stringify(latest))).references[0]).toMatchObject({
    name: "Uncategorized", intendedUse: [], kind: "video", sourcePath: "C:/motion.mp4", video: { startSeconds: 2, durationSeconds: 4, includeAudio: false },
  });
  expect(screen.getByRole("img", { name: "Frame from Uncategorized" })).toHaveAttribute("src", "test:C:/motion.mp4:0");
  vi.mocked(invoke).mockResolvedValueOnce([{ kind: "video", name: "replacement.mp4", sourcePath: "C:/replacement.mp4" }]);
  fireEvent.click(screen.getByRole("button", { name: "Add file" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Frame from Uncategorized" })).toHaveAttribute("src", "test:C:/replacement.mp4:0"));
  fireEvent.click(screen.getByRole("button", { name: "Remove video" }));
  await waitFor(() => expect(latest.references[0].kind).toBe("text"));
  expect(latest.references[0].video).toBeUndefined();
  expect(latest.references[0].sourcePath).toBeNull();
  expect(screen.queryByRole("img", { name: "Frame from Uncategorized" })).not.toBeInTheDocument();
});
