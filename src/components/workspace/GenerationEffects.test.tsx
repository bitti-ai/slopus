// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationEffects } from "./GenerationEffects";
import { activeGenerationEffects, type GenerationEffects as Settings } from "../../lib/generationEffects";
import fixture from "../../../fixtures/generation-effects.json";

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
  const number = screen.getByRole("spinbutton", { name: "Color strength value" });
  fireEvent.change(number, { target: { value: "0.76" } });
  expect(saved().color.strength).toBe(0.76);
  expect(screen.getByRole("slider", { name: "Color strength" })).toHaveValue("0.76");
  fireEvent.change(number, { target: { value: "3" } });
  fireEvent.blur(number);
  expect(saved().color.strength).toBe(2);
  fireEvent.change(number, { target: { value: "1.2" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable Color steering" }));
  expect(saved().color.strength).toBe(1.2);
  expect(activeGenerationEffects(saved())).toBeUndefined();
  expect(screen.getByRole("slider", { name: "Color strength" })).toBeDisabled();
  expect(number).toBeDisabled();
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

it("configures both LCS Drift controls and imports portable learned calibration", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
  fireEvent.click(screen.getByRole("button", { name: "LCS Drift" }));
  expect(screen.getByRole("slider", { name: "Drift strength" })).toBeDisabled();
  fireEvent.change(screen.getByRole("slider", { name: "Highlight strength" }), { target: { value: "0.3" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Highlight threshold value" }), { target: { value: "0.78" } });
  expect(saved().drift).toMatchObject({ highlightStrength: 0.3, highlightKnee: 0.78 });
  const bytes = Uint8Array.from(atob(fixture.drift.calibration.data), (c) => c.charCodeAt(0));
  const file = new File([bytes], "test-drift.safetensors");
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  fireEvent.change(screen.getByLabelText("LCS drift calibration"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByRole("slider", { name: "Drift strength" })).not.toBeDisabled());
  fireEvent.change(screen.getByRole("slider", { name: "Drift strength" }), { target: { value: "0.5" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Maximum correction value" }), { target: { value: "2" } });
  expect(saved().drift).toMatchObject({ strength: 0.5, max: 2, calibration: fixture.drift.calibration });
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable LCS Drift" }));
  expect(activeGenerationEffects(saved())).toBeUndefined();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable LCS Drift" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove drift calibration" }));
  expect(saved().drift.calibration).toBeUndefined();
  expect(saved().drift.strength).toBe(0);
  expect(activeGenerationEffects(saved())?.drift?.highlightStrength).toBe(0.3);
  fireEvent.click(screen.getByRole("button", { name: "Reset LCS Drift" }));
  expect(saved().drift).toEqual({ strength: 0, max: 1, highlightStrength: 0.5, highlightKnee: 0.8 });
  fireEvent.click(screen.getByRole("button", { name: "Remove LCS Drift" }));
  expect(saved()).toBeNull();
});

it("reports an invalid drift calibration without enabling learned correction", async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
  fireEvent.click(screen.getByRole("button", { name: "LCS Drift" }));
  const file = new File(["invalid"], "wrong.safetensors");
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(7) });
  fireEvent.change(screen.getByLabelText("LCS drift calibration"), { target: { files: [file] } });
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(saved().drift.calibration).toBeUndefined();
  expect(screen.getByRole("slider", { name: "Drift strength" })).toBeDisabled();
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
