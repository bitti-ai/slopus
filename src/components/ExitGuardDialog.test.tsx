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
  it("goes straight back when nothing is generating", () => {
    const onBack = vi.fn();
    workspace(withJobs(["draft", "completed", "failed", "cancelled"]), onBack);
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks first mid-generation, and stays put until the answer comes", () => {
    const onBack = vi.fn();
    workspace(withJobs(["generating", "queued"]), onBack);
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));

    const dialog = screen.getByRole("alertdialog");
    expect(onBack).not.toHaveBeenCalled();
    // It says what is running and what confirming costs — both checkable
    // claims about this codebase, not a vague warning.
    expect(dialog.textContent).toContain("1 shot is rendering now and 1 shot is waiting in the queue.");
    expect(dialog.textContent).toContain("No video file is written until a shot finishes");
    expect(dialog.textContent).toContain("can’t pick one back up");
  });

  it("puts the user back exactly where they were when they cancel", () => {
    const onBack = vi.fn();
    workspace(withJobs(["generating"]), onBack);
    const back = screen.getByRole("button", { name: "Back to project library" });
    // jsdom does not move focus on a click the way a browser does, and the
    // whole point of this test is where focus goes back TO.
    back.focus();
    fireEvent.click(back);
    fireEvent.click(screen.getByRole("button", { name: "Keep generating" }));

    expect(onBack).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // Still in the project, on the same view, with the same shot generating.
    expect(screen.getByRole("heading", { name: "Timeline", level: 2 })).toBeTruthy();
    // And focus is back on the control that opened the question.
    expect(document.activeElement).toBe(back);
  });

  it("closes on Escape without leaving", () => {
    const onBack = vi.fn();
    workspace(withJobs(["queued"]), onBack);
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("leaves once, and only once, when the answer is yes", () => {
    const onBack = vi.fn();
    workspace(withJobs(["generating"]), onBack);
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop and leave" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("reports what is generating to the app around it, and reports nothing once it unmounts", async () => {
    const reported: string[][] = [];
    const { unmount } = render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config: withJobs(["generating", "queued", "draft"]) },
      initialView: "timeline",
      onBack: () => undefined,
      onSave: async () => undefined,
      onOngoingGenerationsChange: (jobs) => reported.push(jobs.map((job) => job.id)),
    }));
    await waitFor(() => expect(reported.length).toBeGreaterThan(0));
    // The draft is not ongoing — a shot nobody has started costs nothing to
    // walk away from.
    expect(reported.at(-1)).toEqual(["job-0", "job-1"]);
    unmount();
    expect(reported.at(-1)).toEqual([]);
  });
});

describe("the dialog on its own", () => {
  const jobs = [
    { id: "a", title: "Macro model details", running: true },
    { id: "b", title: "Hands sketching elevation", running: false },
  ];

  it("keeps Tab inside itself and starts on the answer that changes nothing", () => {
    render(createElement(ExitGuardDialog, { jobs, destination: "quit", onConfirm: () => undefined, onCancel: () => undefined }));
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
    const { container } = render(createElement(ExitGuardDialog, { jobs, destination: "quit", onConfirm: () => undefined, onCancel: () => undefined }));
    const rows = Array.from(container.querySelectorAll(".exit-guard__jobs li")).map((row) => row.textContent);
    expect(rows).toEqual(["Macro model detailsRendering now", "Hands sketching elevationWaiting to render"]);
  });

  it("says the window is what ends the run when that is the exit", () => {
    render(createElement(ExitGuardDialog, { jobs, destination: "quit", onConfirm: () => undefined, onCancel: () => undefined }));
    expect(screen.getByRole("alertdialog").textContent).toContain("The video engine runs inside Slopus, so closing the window stops them.");
  });
});
