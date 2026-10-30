// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SceneLoras } from "./SceneLoras";
import { saveLoras, DMAD_LORA, PIKA_REF2VA_LORA, type TemplateLora } from "../../lib/loras";
import { createGeneratorTemplate } from "../../lib/settings";

afterEach(() => { cleanup(); localStorage.clear(); });
function Harness() {
  const [value, setValue] = useState<TemplateLora[]>();
  return <><SceneLoras template={{ ...createGeneratorTemplate(), loras: [{ loraId: "template", enabled: true, strength: 0.5 }] }} value={value} onChange={setValue} />
    <output data-testid="overrides">{JSON.stringify(value ?? [])}</output></>;
}
const saved = () => JSON.parse(screen.getByTestId("overrides").textContent!);

it("shows global LoRAs read only and adds, bypasses, edits and removes scene overrides", () => {
  saveLoras([{ id: "global", name: "Global", path: "D:/global", globallyEnabled: true, globalStrength: 0.8 },
    { id: "template", name: "Template", path: "D:/template" }, { id: "style", name: "Style", path: "D:/style" }]);
  render(<Harness />);
  expect(screen.getByRole("checkbox", { name: "Enable scene LoRA Global" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Enable scene LoRA Global" })).toBeDisabled();
  expect(screen.getByRole("spinbutton", { name: "Global scene strength" })).toBeDisabled();
  expect(screen.getByRole("spinbutton", { name: "Global scene strength" })).toHaveValue(0.8);
  expect(screen.getByText("Global · Read only")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "Enable scene LoRA Template" }));
  expect(saved()).toEqual([{ loraId: "template", enabled: false, strength: 0.5 }]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Template override" }));
  expect(screen.getByRole("checkbox", { name: "Enable scene LoRA Template" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Add LoRA" }));
  fireEvent.click(screen.getByRole("button", { name: "Style" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Style scene strength" }), { target: { value: "0.6" } });
  expect(saved()).toEqual([{ loraId: "style", enabled: true, strength: 0.6 }]);
  fireEvent.click(screen.getByRole("button", { name: "Remove Style override" }));
  expect(saved()).toEqual([]);
});

it("disables adding recipes incompatible with global LoRAs", () => {
  saveLoras([{ ...DMAD_LORA, path: "D:/dmad", globallyEnabled: true }]);
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Add LoRA" }));
  expect(screen.getByRole("button", { name: PIKA_REF2VA_LORA.name })).toBeDisabled();
});
