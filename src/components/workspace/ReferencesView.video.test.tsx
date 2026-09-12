// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig } from "../../lib/project";
import { inspectReferenceVideo } from "../../lib/referenceVideo";
import { ReferencesView } from "./ReferencesView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/referenceVideo", () => ({ inspectReferenceVideo: vi.fn() }));
vi.mock("./ReferenceVideo", () => ({ ReferenceVideo: () => <div>Video preview</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it("imports a video, edits its saved trim and soundtrack, then removes its attachment", async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(invoke).mockResolvedValue("C:/motion.mp4");
  vi.mocked(inspectReferenceVideo).mockResolvedValue({ durationSeconds: 10, includeAudio: true });
  let latest = createProjectConfig({ name: "Video", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 20 });
  function Harness() {
    const [config, setConfig] = useState(latest); latest = config;
    return <ReferencesView folderPath="C:/project" config={config} onChange={setConfig} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Import video" }));
  await screen.findByText("Video preview");
  expect(invoke).toHaveBeenCalledWith("choose_reference_video", { folderPath: "C:/project" });
  fireEvent.change(screen.getByLabelText("Clip start (seconds)"), { target: { value: "2" } });
  fireEvent.blur(screen.getByLabelText("Clip start (seconds)"));
  fireEvent.change(screen.getByLabelText("Clip duration (seconds)"), { target: { value: "4" } });
  fireEvent.blur(screen.getByLabelText("Clip duration (seconds)"));
  fireEvent.click(screen.getByLabelText("Include sound"));
  expect(parseProjectConfig(JSON.parse(JSON.stringify(latest))).references[0]).toMatchObject({
    kind: "video", sourcePath: "C:/motion.mp4", video: { startSeconds: 2, durationSeconds: 4, includeAudio: false },
  });
  fireEvent.click(screen.getByRole("button", { name: "Remove video" }));
  await waitFor(() => expect(latest.references[0].kind).toBe("text"));
  expect(latest.references[0].video).toBeUndefined();
  expect(latest.references[0].sourcePath).toBeNull();
});
