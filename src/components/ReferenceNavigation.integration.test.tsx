// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectConfig } from "../lib/project";
import { ProjectWorkspace } from "./ProjectWorkspace";

afterEach(cleanup);

it("shows only titles in Used by and opens the selected generation", () => {
  const config = createProjectConfig({ name: "Reference navigation", prompt: "A scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  config.references = [{ id: "hero", kind: "text", name: "Hero", description: "", intendedUse: ["character"], createdAt: config.createdAt }];
  const first = { ...config.generationJobs[0], id: "first", title: "First scene", referenceIds: [] };
  const target = { ...first, id: "target", title: "The forest encounter", referenceIds: ["hero"], status: "failed" as const, stage: "failed" as const };
  config.generationJobs = [first, target];
  const { container } = render(<ProjectWorkspace project={{ config, folderPath: "C:/Reference navigation" }} initialView="references" onBack={vi.fn()} onSave={async () => undefined} />);
  const usage = container.querySelector(".reference-used-by")! as HTMLElement;
  const row = within(usage).getByRole("button", { name: "The forest encounter" });
  expect(row).toHaveTextContent(/^The forest encounter$/);
  expect(within(usage).queryByText(/failed/i)).not.toBeInTheDocument();
  expect(within(usage).queryByRole("button", { name: "First scene" })).not.toBeInTheDocument();
  fireEvent.click(row);
  expect(screen.queryByRole("textbox", { name: "Reference name" })).not.toBeInTheDocument();
  expect(container.querySelector<HTMLInputElement>(".job-title__name")?.value).toBe("The forest encounter");
  expect(screen.getByRole("region", { name: "This scene" })).toBeInTheDocument();
});
