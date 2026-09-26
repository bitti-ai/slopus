import { describe, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectConfig } from "./project";
import { ProjectSession } from "./projectSession";

const session = () => new ProjectSession(
  { folderPath: "C:/undo", config: createProjectConfig({ name: "Undo", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 }) },
  vi.fn(async () => undefined),
);
const rename = (name: string) => (current: ProjectConfig) => ({ ...current, name });

describe("project undo", () => {
  it("undoes and redoes edits, and marks the project dirty", () => {
    const project = session();
    expect(project.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false });
    project.edit(rename("One"), "a");
    project.edit(rename("Two"), "b");
    expect(project.getSnapshot()).toMatchObject({ canUndo: true, canRedo: false, dirty: true });
    expect(project.undo()).toBe(true);
    expect(project.getSnapshot().config.name).toBe("One");
    expect(project.undo()).toBe(true);
    expect(project.getSnapshot().config.name).toBe("Undo");
    expect(project.undo()).toBe(false);
    expect(project.getSnapshot()).toMatchObject({ canUndo: false, canRedo: true });
    project.redo();
    expect(project.getSnapshot().config.name).toBe("One");
  });

  it("coalesces rapid edits with the same key into one step", () => {
    const project = session();
    project.edit(rename("T"));
    project.edit(rename("Ti"));
    project.edit(rename("Title"));
    project.undo();
    expect(project.getSnapshot().config.name).toBe("Undo");
  });

  it("never records background updates, and keeps them through undo and redo", () => {
    const project = session();
    const jobId = project.getSnapshot().config.generationJobs[0].id;
    project.edit(rename("Edited"), "name");
    project.update((current) => ({
      ...current,
      generationJobs: current.generationJobs.map((job) => job.id === jobId ? { ...job, status: "completed" as const, outputRelativePath: "media/generated/a.mp4" } : job),
    }));
    project.undo();
    const undone = project.getSnapshot().config;
    expect(undone.name).toBe("Undo");
    expect(undone.generationJobs[0]).toMatchObject({ status: "completed", outputRelativePath: "media/generated/a.mp4" });
    expect(project.undo()).toBe(false);
    project.redo();
    expect(project.getSnapshot().config.name).toBe("Edited");
    expect(project.getSnapshot().config.generationJobs[0].status).toBe("completed");
  });

  it("clears the history when the changes are discarded", async () => {
    const project = session();
    project.edit(rename("Edited"));
    await project.discard();
    expect(project.getSnapshot()).toMatchObject({ canUndo: false, dirty: false });
    expect(project.getSnapshot().config.name).toBe("Undo");
  });
});
