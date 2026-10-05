// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { OtherWeightsSettings } from "./OtherWeightsSettings";
import { OTHER_WEIGHT_TEMPLATES, localOtherWeightPaths, otherWeightPaths, refreshOtherWeights, upscaleConfig } from "../lib/upscalers";
import { chooseEnginePath } from "../lib/runtime";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/persistence", () => ({ isTauri: () => true }));
vi.mock("../lib/runtime", () => ({ chooseEnginePath: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

it("downloads the SeedVR2 model and VAE as one template and remembers both paths", async () => {
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "find_downloaded_weights") return {} as never;
    if (name === "download_weight") return `C:/weights/${(args as { url: string }).url.split("/").at(-1)}` as never;
    return undefined as never;
  });
  expect(() => upscaleConfig("seedvr2")).toThrow("Download SeedVR2");
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
  expect(upscaleConfig("seedvr2")).toEqual({ method: "seedvr2", modelPath: "C:/weights/seedvr2_3b_fp16.safetensors", vaePath: "C:/weights/seedvr2_ema_vae_fp16.safetensors" });
});

it.each(OTHER_WEIGHT_TEMPLATES.flatMap((template) => [false, true].map((remote) => ({ template, remote }))))("uses local $template.name files after refreshing downloads (worker: $remote)", async ({ template, remote }) => {
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "find_downloaded_weights") return Object.fromEntries(template.files.map((file) => [file.url, `C:/cache/${file.id}.safetensors`])) as never;
    if (name === "check_weight_files") return Object.fromEntries((args as { paths: string[] }).paths.map((path) => [path, true])) as never;
    return undefined as never;
  });
  if (remote) localStorage.setItem("slopus.generation-worker.v1", JSON.stringify({ id: "worker" }));
  render(<OtherWeightsSettings desktop />);
  fireEvent.click(screen.getByRole("button", { name: `Edit ${template.name} weights` }));
  for (const file of template.files) {
    if (file.id === "model") {
      vi.mocked(chooseEnginePath).mockResolvedValueOnce(`D:/custom/${file.id}.safetensors`);
      fireEvent.click(screen.getByRole("button", { name: `Browse for ${file.name}` }));
      await waitFor(() => expect(screen.getByRole("textbox", { name: `${file.name} path` })).toHaveValue(`D:/custom/${file.id}.safetensors`));
    } else fireEvent.change(screen.getByRole("textbox", { name: `${file.name} path` }), { target: { value: `D:/custom/${file.id}.safetensors` } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await refreshOtherWeights();
  expect(upscaleConfig(template.id)).toEqual({ method: template.id, modelPath: "D:/custom/model.safetensors",
    ...(template.id === "seedvr2" ? { vaePath: "D:/custom/vae.safetensors" } : {}) });
  fireEvent.click(screen.getByRole("button", { name: `Edit ${template.name} weights` }));
  for (const file of template.files) {
    expect(screen.getByRole("textbox", { name: `${file.name} path` })).toHaveValue(`D:/custom/${file.id}.safetensors`);
    fireEvent.change(screen.getByRole("textbox", { name: `${file.name} path` }), { target: { value: "" } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(localOtherWeightPaths()).toEqual({});
  expect(otherWeightPaths()[template.files[0].url]).toBe("C:/cache/model.safetensors");
  if (template.id === "seedvr2") expect(upscaleConfig("seedvr2")).toMatchObject(remote
    ? { modelPath: "", vaePath: undefined } : { modelPath: "C:/cache/model.safetensors", vaePath: "C:/cache/vae.safetensors" });
});

it("allows worker SeedVR2 downloads without local weights but requires both weights locally", () => {
  localStorage.setItem("slopus.generation-worker.v1", JSON.stringify({ id: "worker" }));
  expect(upscaleConfig("seedvr2")).toEqual({ method: "seedvr2", modelPath: "", vaePath: undefined });
  localStorage.removeItem("slopus.generation-worker.v1");
  const [model, vae] = OTHER_WEIGHT_TEMPLATES[1].files;
  localStorage.setItem("slopus.other-weights.v1", JSON.stringify({ [model.url]: "C:/model.safetensors" }));
  expect(() => upscaleConfig("seedvr2")).toThrow("Download SeedVR2");
  localStorage.setItem("slopus.other-weights.v1", JSON.stringify({ [vae.url]: "C:/vae.safetensors" }));
  expect(() => upscaleConfig("seedvr2")).toThrow("Download SeedVR2");
});

it("rejects relative paths and missing files without saving them", async () => {
  vi.mocked(invoke).mockResolvedValue({});
  render(<OtherWeightsSettings desktop />);
  fireEvent.click(screen.getByRole("button", { name: "Edit Real-ESRGAN weights" }));
  const path = screen.getByRole("textbox", { name: "RealESRGAN x4plus path" });
  fireEvent.change(path, { target: { value: "relative.safetensors" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByText("Choose local weight files using their absolute paths.")).toBeInTheDocument();
  fireEvent.change(path, { target: { value: "C:/missing.safetensors" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByText(/Weight file not found/)).toBeInTheDocument());
  expect(localOtherWeightPaths()).toEqual({});
});
