// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoraLibrary } from "./LoraSettings";
import { DMAD_LORA, PIKA_REF2VA_LORA, effectiveLoras, loadLoras, saveLoras } from "../lib/loras";

const { queued } = vi.hoisted(() => ({ queued: [] }));
vi.mock("../lib/weightDownloads", () => ({ getWeightDownloadState: () => null, getQueuedWeightDownloads: () => queued,
  subscribeWeightDownloads: () => () => {}, refreshDownloadedLoras: async () => {}, weightDownloadProgress: () => 0 }));
afterEach(() => { cleanup(); localStorage.clear(); });

it("toggles globals, blocks incompatible recipes and drags the effective application order", () => {
  saveLoras([{ ...DMAD_LORA, path: "D:/dmad" }, { id: "style", name: "Style", path: "D:/style" }]);
  render(<LoraLibrary modelType="minimax-h3" onAdd={vi.fn()} onEdit={vi.fn()} />);
  fireEvent.click(screen.getByRole("switch", { name: `Use ${DMAD_LORA.name} globally` }));
  expect(loadLoras().find((lora) => lora.id === DMAD_LORA.id)?.globallyEnabled).toBe(true);
  expect(screen.getByRole("switch", { name: `Use ${PIKA_REF2VA_LORA.name} globally` })).toBeDisabled();
  fireEvent.click(screen.getByRole("switch", { name: "Use Style globally" }));
  const source = screen.getByRole("button", { name: "Edit Style LoRA" }).closest('[role="listitem"]')!;
  const target = screen.getByRole("button", { name: `Edit ${DMAD_LORA.name} LoRA` }).closest('[role="listitem"]')!;
  const dataTransfer = { setData: vi.fn(), effectAllowed: "" };
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
  expect(effectiveLoras().map((entry) => entry.loraId)).toEqual(["style", DMAD_LORA.id]);
});
