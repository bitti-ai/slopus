// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectReference } from "../../lib/project";
import type { ReferenceMediaType } from "../../lib/referenceSelection";
import { ReferenceSelector } from "./ReferenceSelector";
import { PromptTextField } from "./PromptTextField";

afterEach(cleanup);
const base = { description: "", intendedUse: [], createdAt: "2026-01-01T00:00:00.000Z" };
const references: ProjectReference[] = [
  { ...base, id: "image", name: "Image", kind: "image", relativePath: "references/image.png" },
  { ...base, id: "audio", name: "Audio", kind: "audio", sourcePath: "D:/voice.wav" },
  { ...base, id: "text", name: "Text", kind: "text", description: "A description" },
];

it.each<{ accept: ReferenceMediaType[]; expected: string[] }>([
  { accept: ["image"], expected: ["None", "Image"] },
  { accept: ["audio"], expected: ["None", "Audio"] },
  { accept: ["image", "audio"], expected: ["None", "Image", "Audio"] },
])("offers only $accept payloads in a standalone selection", ({ accept, expected }) => {
  render(<ReferenceSelector aria-label="Frame" value="" references={references} accept={accept} folderPath="D:/Project" onChange={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Frame" }));
  const choices = within(screen.getByRole("dialog", { name: "Frame" })).getAllByRole("button");
  expect(choices).toHaveLength(expected.length);
  choices.forEach((button, index) => expect(button).toHaveAccessibleName(new RegExp(`^${expected[index]}`)));
});

it("searches, selects, clears and restores focus, while preserving an unavailable saved value", () => {
  const images: ProjectReference[] = Array.from({ length: 8 }, (_, index) => ({ ...references[0], id: `image-${index}`, name: `Photo ${index}` }));
  function Harness() {
    const [value, setValue] = useState("audio");
    return <ReferenceSelector aria-label="Frame" value={value} references={[...images, references[1]]} accept={["image"]} folderPath="D:/Project" onChange={setValue} />;
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Frame" });
  expect(trigger).toHaveTextContent("Audio");
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Frame" })).toHaveTextContent("can’t be used");
  const search = screen.getByRole("textbox", { name: "Find a reference" });
  expect(search).toHaveFocus();
  fireEvent.change(search, { target: { value: "Photo 5" } });
  const match = screen.getByRole("button", { name: /Photo 5/ });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(match).toHaveFocus();
  fireEvent.click(match);
  expect(trigger).toHaveTextContent("Photo 5");
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "None" }));
  expect(trigger).toHaveTextContent("None");
  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("shares the same media filter with smart-chip insertion", () => {
  const onChange = vi.fn();
  render(<PromptTextField aria-label="Prompt" value="" onChange={onChange} accept={["audio"]} references={[
    { id: "image", name: "Image", mediaTypes: ["image"] }, { id: "audio", name: "Voice", mediaTypes: ["audio"] },
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "Reference" }));
  expect(screen.queryByRole("button", { name: "Image" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Voice" }));
  expect(onChange).toHaveBeenCalledWith("@[ref:audio]");
});

it("cannot open a disabled selector", () => {
  render(<ReferenceSelector aria-label="Frame" value="" references={references} accept={["image"]} folderPath="D:/Project" onChange={vi.fn()} disabled />);
  fireEvent.click(screen.getByRole("button", { name: "Frame" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
