// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectRecord } from "../lib/project";
import { WorkQueue } from "../lib/workQueue";
import { ProjectWorkspace } from "./ProjectWorkspace";

afterEach(cleanup);
const setup = (writer = vi.fn(async (_record: ProjectRecord) => undefined)) => {
  const config = createProjectConfig({ name: "My project", prompt: "A scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  config.references = [{ id: "hero", name: "Saved hero", description: "", kind: "text", intendedUse: ["character"], createdAt: config.createdAt }];
  const project = { config, folderPath: "C:/My project" };
  const queue = new WorkQueue(writer);
  const onBack = vi.fn();
  render(<ProjectWorkspace project={project} workQueue={queue} initialView="references" onBack={onBack} onSave={async () => undefined} />);
  return { queue, project, session: queue.project(project), writer, onBack };
};
const changeName = () => fireEvent.change(screen.getByRole("textbox", { name: "Reference name" }), { target: { value: "Unsaved hero" } });
const back = () => fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));

it("returns immediately when the project has no unsaved changes", () => {
  const { onBack } = setup();
  back();
  expect(onBack).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("offers back, save or discard and waits for saving before leaving", async () => {
  let finish!: () => void;
  const writer = vi.fn((_record: ProjectRecord) => new Promise<void>((resolve) => { finish = resolve; }));
  const { onBack, session } = setup(writer);
  changeName(); back();
  const dialog = screen.getByRole("alertdialog", { name: "Save changes?" });
  expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["Back", "Discard changes", "Save changes"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(writer).toHaveBeenCalledOnce());
  expect(within(dialog).getByRole("button", { name: "Back" })).toBeDisabled();
  expect(onBack).not.toHaveBeenCalled();
  expect(writer.mock.calls[0][0].config.references[0].name).toBe("Unsaved hero");
  await act(async () => finish());
  expect(onBack).toHaveBeenCalledOnce();
  expect(session.getSnapshot().dirty).toBe(false);
});

it.each(["Back", "Escape"])("returns to editing via %s without saving or discarding changes", (action) => {
  const { onBack, session, writer } = setup();
  changeName(); back();
  const dialog = screen.getByRole("alertdialog", { name: "Save changes?" });
  if (action === "Back") fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  else fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Reference name" })).toHaveValue("Unsaved hero");
  expect(session.getSnapshot().dirty).toBe(true);
  expect(writer).not.toHaveBeenCalled();
  expect(onBack).not.toHaveBeenCalled();
  back();
  expect(screen.getByRole("alertdialog", { name: "Save changes?" })).toBeInTheDocument();
});

it("discards unsaved changes from the retained session so reopening restores saved values", async () => {
  const { onBack, session, writer, queue, project } = setup();
  changeName(); back();
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
  expect(writer).not.toHaveBeenCalled();
  expect(session.getSnapshot().dirty).toBe(false);
  expect(queue.project(project).getSnapshot().config.references[0].name).toBe("Saved hero");
});

it("keeps changes and reports a save failure before allowing another save attempt", async () => {
  const writer = vi.fn(async (_record: ProjectRecord) => undefined).mockRejectedValueOnce(new Error("Disk locked"));
  const { onBack, session } = setup(writer);
  changeName(); back();
  const dialog = screen.getByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Disk locked");
  expect(onBack).not.toHaveBeenCalled();
  expect(session.getSnapshot().dirty).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
});
