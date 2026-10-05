// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { OtherWeightsSettings } from "./OtherWeightsSettings";
import { OTHER_WEIGHT_TEMPLATES, upscaleConfig } from "../lib/upscalers";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/persistence", () => ({ isTauri: () => true }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

it("downloads the SeedVR2 model and VAE as one template and resolves both export paths", async () => {
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "find_downloaded_weights") return {} as never;
    if (name === "download_weight") return `C:/weights/${(args as { url: string }).url.split("/").at(-1)}` as never;
    return undefined as never;
  });
  expect(() => upscaleConfig("seedvr2")).toThrow("Other weights");
  render(<OtherWeightsSettings desktop />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("find_downloaded_weights", expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "Download SeedVR2" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Downloaded" })).toBeDisabled());
  for (const file of OTHER_WEIGHT_TEMPLATES[1].files) expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({ url: file.url }));
  expect(upscaleConfig("seedvr2")).toEqual({ method: "seedvr2", modelPath: "C:/weights/seedvr2_3b_int8_convrot.safetensors", vaePath: "C:/weights/seedvr2_ema_vae_fp16.safetensors" });
  expect(upscaleConfig("none")).toBeUndefined();
});
