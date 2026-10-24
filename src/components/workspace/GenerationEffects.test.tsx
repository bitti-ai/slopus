// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationEffects } from "./GenerationEffects";
import { activeGenerationEffects, type GenerationEffects as Settings } from "../../lib/generationEffects";

afterEach(() => { cleanup(); localStorage.clear(); });
function Harness() {
  const [settings, set] = useState<Settings>();
  return <><GenerationEffects value={settings} supported onChange={set} /><output data-testid="settings">{JSON.stringify(settings)}</output></>;
}
const saved = () => JSON.parse(screen.getByTestId("settings").textContent || "null");
it("adds, edits, bypasses, resets and removes generation effects", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
  fireEvent.click(screen.getByRole("button", { name: "Color steering" }));
  fireEvent.change(screen.getByRole("slider", { name: "Color strength" }), { target: { value: "1.2" } });
  expect(saved().color.strength).toBe(1.2);
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable Color steering" }));
  expect(saved().color.strength).toBe(1.2);
  expect(activeGenerationEffects(saved())).toBeUndefined();
  expect(screen.getByRole("slider", { name: "Color strength" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reset Color steering" }));
  expect(saved().color.strength).toBe(0.35);
  fireEvent.click(screen.getByRole("checkbox", { name: "Limit to a region" }));
  fireEvent.change(screen.getByLabelText("Effect region width"), { target: { value: "50" } });
  fireEvent.change(screen.getByLabelText("Effect region x"), { target: { value: "25" } });
  expect(saved().region).toMatchObject({ x: 25, width: 50 });
  fireEvent.click(screen.getByRole("button", { name: "Remove Color steering" }));
  expect(saved()).toBeNull();
});
it("blocks unsupported models but allows bypassing or removing existing effects", () => {
  const change = vi.fn();
  render(<GenerationEffects supported={false} value={{ sharpness: { strength: 0.5 } }} onChange={change} />);
  expect(screen.getByRole("button", { name: "Add effect" })).toBeDisabled();
  expect(screen.getByRole("slider", { name: "Sharpness" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable Sharpness" }));
  expect(change).toHaveBeenLastCalledWith({ sharpness: { strength: 0.5, enabled: false } });
  fireEvent.click(screen.getByRole("button", { name: "Remove Sharpness" }));
  expect(change).toHaveBeenLastCalledWith(undefined);
});

it("edits the selected video scene from its right panel", async () => {
  const { SceneInspector } = await import("./SceneEditor");
  const { createProjectConfig, sceneShots } = await import("../../lib/project");
  const config = createProjectConfig({ name: "Effects", prompt: "Apple", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 5 });
  const job = config.generationJobs[0];
  const change = vi.fn();
  render(<SceneInspector job={job} shots={sceneShots(job)} references={[]} defaultSteps={20} disabled={false} importAvailable={false} importError={null} onAddStartFrame={vi.fn()} onAddEndFrame={vi.fn()} onChange={change} onShots={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
  fireEvent.click(screen.getByRole("button", { name: "Color stabilization" }));
  expect(change).toHaveBeenLastCalledWith({ generationEffects: { anchor: { mode: "self", strength: 0.25 } } });
});
