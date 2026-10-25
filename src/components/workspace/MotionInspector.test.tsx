// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MotionInspector } from "./MotionInspector";
import { emptyMotion, motionNodeSchema, type Motion } from "../../lib/motion";

afterEach(() => { cleanup(); localStorage.clear(); });
it("edits named elements and parameters without changing source until Apply", () => {
  let latest: Motion;
  function Harness() {
    const [motion, change] = useState(() => ({ ...emptyMotion(), nodes: [motionNodeSchema.parse({ id: "title", name: "Title", kind: "text", text: "Hello" })],
      parameters: [{ id: "speed", label: "Speed", type: "number" as const, value: 2, min: 0, max: 10 }] } as Motion));
    latest = motion;
    return <MotionInspector motion={motion} selectedId="title" onChange={change} />;
  }
  render(<Harness />);
  expect(screen.queryByRole("button", { name: "Title" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Render as reference video" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Parameters" }).compareDocumentPosition(screen.getByRole("button", { name: "Elements Title" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("button", { name: "JavaScript" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.change(screen.getByLabelText("Element text"), { target: { value: "Edited" } });
  fireEvent.change(screen.getByLabelText("Element Offset X"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "4" } });
  expect(latest!.overrides.title).toMatchObject({ text: "Edited", offset: [25, 0, 0] });
  expect(latest!.nodes[0].text).toBe("Hello");
  expect(latest!.parameters[0].value).toBe(4);
  const source = "export function update({nodes,time}) { nodes[0].position[0] += time; }";
  fireEvent.click(screen.getByRole("button", { name: "JavaScript" }));
  fireEvent.change(screen.getByLabelText("Motion JavaScript source"), { target: { value: source } });
  expect(latest!.source).not.toBe(source);
  fireEvent.click(screen.getByRole("button", { name: "Apply source" }));
  expect(latest!.source).toBe(source);
});
