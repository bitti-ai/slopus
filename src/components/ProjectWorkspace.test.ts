// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import { createProjectConfig, parseProjectConfig } from "../lib/project";
import { formatDurationTimecode } from "./ProjectWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { GeneratorView } from "./workspace/GeneratorView";
import { TimelineView } from "./workspace/TimelineView";

afterEach(cleanup);

describe("project workspace timecode", () => {
  it("formats project duration as valid hours, minutes, and seconds", () => {
    expect(formatDurationTimecode(0)).toBe("00:00:00");
    expect(formatDurationTimecode(59)).toBe("00:00:59");
    expect(formatDurationTimecode(60)).toBe("00:01:00");
    expect(formatDurationTimecode(600)).toBe("00:10:00");
  });

  it("surfaces native save failures in the workspace", async () => {
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Portable Launch Film", config: parseProjectConfig(completeFixture) },
      onBack: () => undefined,
      onSave: async () => { throw new Error("The original project file is locked."); },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t save project");
    expect(alert.textContent).toContain("The original project file is locked.");
  });

  it("creates and selects a draft job from Add or generate a scene", async () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "timeline",
      onBack: () => undefined, onSave: async () => undefined,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Add or generate a scene" }));
    await screen.findByRole("heading", { name: "Generator" });
    expect(screen.getByRole("heading", { name: "New scene draft" })).not.toBeNull();
    expect(screen.getAllByText("DRAFT").length).toBeGreaterThan(0);
  });

  it("shows a project-specific empty monitor without unrelated demo preview", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "timeline",
      onBack: () => undefined, onSave: async () => undefined,
    }));
    const monitor = screen.getByTestId("project-empty-monitor");
    expect(monitor.textContent).toContain("Ceramic lamp");
    expect(monitor.textContent).toContain("A quiet product film");
    expect(screen.queryByText("NORTHERN LIGHT")).toBeNull();
  });

  it("does not delete a selected clip from a locked track", () => {
    const config = parseProjectConfig(completeFixture);
    const firstTrackWithClip = config.timeline.tracks.find((track) => track.clips.length > 0)!;
    const locked = { ...config, timeline: { tracks: config.timeline.tracks.map((track) => track.id === firstTrackWithClip.id ? { ...track, locked: true } : track) } };
    const onChange = vi.fn();
    const { container } = render(createElement(TimelineView, { config: locked, onChange, onOpenGenerator: () => undefined }));
    const timeline = container.querySelector(".timeline-view")!;
    fireEvent.keyDown(timeline, { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByTitle("Delete selected clip") as HTMLButtonElement).disabled).toBe(true);
  });

  it("inserts only a completed job with a real output into Story", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "completed", stage: "completed", progress: 1, outputRelativePath: "media/generated/first-scene.mp4" }] });
    const onChange = vi.fn();
    const onOpenTimeline = vi.fn();
    render(createElement(GeneratorView, { config, onChange, onOpenTimeline, selectedJobId: config.generationJobs[0].id }));
    fireEvent.click(screen.getByRole("button", { name: "Insert into Story" }));
    const next = onChange.mock.calls[0][0];
    expect(next.assets[0].relativePath).toBe("media/generated/first-scene.mp4");
    expect(next.timeline.tracks.find((track: { name: string }) => track.name === "Story").clips).toHaveLength(1);
    expect(onOpenTimeline).toHaveBeenCalledOnce();
  });

  it("labels a cancelled preview as cancelled instead of queued", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "cancelled", stage: "failed" }] });
    render(createElement(GeneratorView, { config, onChange: () => undefined, onOpenTimeline: () => undefined }));
    expect(screen.getByText("Generation cancelled")).not.toBeNull();
    expect(screen.queryByText("Waiting in queue")).toBeNull();
  });
});
