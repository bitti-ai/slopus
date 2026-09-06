// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, type GenerationJob, type ProjectConfig } from "../lib/project";
import { ExitGuardDialog, summary } from "./ExitGuardDialog";
import { isGenerationOngoing, ProjectWorkspace } from "./ProjectWorkspace";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

const base = () => createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });

/** A project with `statuses.length` extra shots, one per status. */
function withJobs(statuses: GenerationJob["status"][]): ProjectConfig {
  const config = base();
  const now = new Date().toISOString();
  const jobs: GenerationJob[] = statuses.map((status, index) => ({
    id: `job-${index}`, title: `Shot ${index + 1}`, prompt: "a slow push across the launch pad",
    status, stage: status === "generating" ? "generating" : "queued", progress: 0,
    providerId: "minimax-h3", creativeBrief: "a slow push across the launch pad",
    referenceIds: [], createdAt: now, updatedAt: now,
  }));
  return { ...config, generationJobs: [...jobs, ...config.generationJobs] };
}

const workspace = (config: ProjectConfig, onBack: () => void) =>
  render(createElement(ProjectWorkspace, { project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "timeline", onBack, onSave: async () => undefined }));

describe("the one definition of an ongoing generation", () => {
  it("is every status with something still to lose, and nothing else", () => {
    const statuses: GenerationJob["status"][] = ["draft", "queued", "generating", "ready", "completed", "failed", "cancelled"];
    const ongoing = statuses.filter((status) => isGenerationOngoing({ status } as GenerationJob));
    /* "ready" is in the list because it does not mean finished: the pictures
       exist and the file does not yet — the app is encoding them into the
       project folder. Leaving then costs the whole render, exactly as leaving
       mid-render does. "completed" is the one that means there is a file. */
    expect(ongoing).toEqual(["queued", "generating", "ready"]);
  });

  it("counts what is happening without rounding a queued shot up into a rendering one", () => {
    expect(summary(1, 0)).toBe("1 shot is rendering now.");
    expect(summary(0, 2)).toBe("2 shots are waiting in the queue.");
    expect(summary(1, 3)).toBe("1 shot is rendering now and 3 shots are waiting in the queue.");
  });
});

describe("leaving a project", () => {
  it("returns to the library without a generation warning", () => {
    const onBack = vi.fn();
    workspace(withJobs(["generating", "queued", "ready"]), onBack);
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("the dialog on its own", () => {
  const jobs = [
    { id: "a", title: "Macro model details", running: true },
    { id: "b", title: "Hands sketching elevation", running: false },
  ];

  it("keeps Tab inside itself and starts on the answer that changes nothing", () => {
    render(createElement(ExitGuardDialog, { jobs, onConfirm: () => undefined, onCancel: () => undefined }));
    const keep = screen.getByRole("button", { name: "Keep generating" });
    const stop = screen.getByRole("button", { name: "Stop and close" });
    expect(document.activeElement).toBe(keep);

    // Forward from the last stop wraps to the first; the browser handles the
    // step in between, so what is under test is the wrap.
    stop.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(keep);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(stop);
  });

  it("names the shots at stake and says which are only queued", () => {
    const { container } = render(createElement(ExitGuardDialog, { jobs, onConfirm: () => undefined, onCancel: () => undefined }));
    const rows = Array.from(container.querySelectorAll(".exit-guard__jobs li")).map((row) => row.textContent);
    expect(rows).toEqual(["Macro model detailsRendering now", "Hands sketching elevationWaiting to render"]);
  });

  it("says the window is what ends the run when that is the exit", () => {
    render(createElement(ExitGuardDialog, { jobs, onConfirm: () => undefined, onCancel: () => undefined }));
    expect(screen.getByRole("alertdialog").textContent).toContain("The video engine runs inside Slopus, so closing the window stops them.");
  });
});
