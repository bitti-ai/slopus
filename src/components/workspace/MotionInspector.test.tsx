// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MotionInspector } from "./MotionInspector";
import { emptyMotion, motionNodeSchema, type Motion } from "../../lib/motion";

afterEach(cleanup);
it("edits named elements and parameters without changing source until Apply", () => {
  let latest: Motion;
  const bake = vi.fn();
  function Harness() {
    const [motion, change] = useState(() => ({ ...emptyMotion(), nodes: [motionNodeSchema.parse({ id: "title", name: "Title", kind: "text", text: "Hello" })],
      parameters: [{ id: "speed", label: "Speed", type: "number" as const, value: 2, min: 0, max: 10 }] } as Motion));
    latest = motion;
    return <MotionInspector motion={motion} selectedId="title" onSelect={() => {}} onChange={change} onRenderReference={bake} />;
  }
  render(<Harness />);
  fireEvent.change(screen.getByLabelText("Element text"), { target: { value: "Edited" } });
  fireEvent.change(screen.getByLabelText("Element Offset X"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "4" } });
  expect(latest!.overrides.title).toMatchObject({ text: "Edited", offset: [25, 0, 0] });
  expect(latest!.nodes[0].text).toBe("Hello");
  expect(latest!.parameters[0].value).toBe(4);
  const source = "export function update({nodes,time}) { nodes[0].position[0] += time; }";
  fireEvent.change(screen.getByLabelText("Motion JavaScript source"), { target: { value: source } });
  expect(latest!.source).not.toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Apply source" }));
  expect(latest!.source).toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Render as reference video" }));
  expect(bake).toHaveBeenCalledOnce();
});
