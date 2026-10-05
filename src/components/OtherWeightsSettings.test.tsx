// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { OtherWeightsSettings } from "./OtherWeightsSettings";
import { OTHER_WEIGHT_TEMPLATES, otherWeightPaths, upscaleConfig } from "../lib/upscalers";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/persistence", () => ({ isTauri: () => true }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

it("downloads the SeedVR2 model and VAE as one template and remembers both paths", async () => {
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "find_downloaded_weights") return {} as never;
    if (name === "download_weight") return `C:/weights/${(args as { url: string }).url.split("/").at(-1)}` as never;
    return undefined as never;
  });
  expect(() => upscaleConfig("seedvr2")).toThrow("Select a worker");
  render(<OtherWeightsSettings desktop />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("find_downloaded_weights", expect.anything()));
  fireEvent.click(within(screen.getByText("SeedVR2").closest(".ui-settings-card") as HTMLElement).getByRole("button", { name: "Download" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Downloaded" })).toBeDisabled());
  for (const file of OTHER_WEIGHT_TEMPLATES[1].files) expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({ url: file.url }));
  expect(otherWeightPaths()).toEqual({
    [OTHER_WEIGHT_TEMPLATES[1].files[0].url]: "C:/weights/seedvr2_3b_fp16.safetensors",
    [OTHER_WEIGHT_TEMPLATES[1].files[1].url]: "C:/weights/seedvr2_ema_vae_fp16.safetensors",
  });
  expect(upscaleConfig("none")).toBeUndefined();
});
