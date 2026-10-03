// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkersSetting } from "./WorkersSettings";
import type { GenerationWorker, WorkerList } from "../lib/workers";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../lib/persistence", async (original) => ({ ...await original<typeof import("../lib/persistence")>(), isTauri: () => true }));

const worker = (overrides: Partial<GenerationWorker>): GenerationWorker => ({
  key: "aaaaaaaaaaaaaaaa", id: "aaaaaaaaaaaaaaaa", name: "Studio PC", address: "192.168.1.20:47321", online: true, compatible: true,
  discovered: true, manual: false, selected: false, version: "0.2.0", requiresToken: false, hasToken: false,
  gpus: [{ name: "NVIDIA GeForce RTX 5090", memoryBytes: 32 * 1024 ** 3 }],
  runtime: { state: "ready", version: "1.14.0", platform: "CUDA 13", cudaAvailable: true, cudaDeviceNames: [], detail: "" }, error: null, ...overrides,
});

describe("Settings → Workers", () => {
  let list: WorkerList;
  beforeEach(() => {
    localStorage.clear();
    list = { selectedId: null, workers: [
      worker({}),
      worker({ key: "10.0.0.9:47321", id: null, name: "10.0.0.9:47321", address: "10.0.0.9:47321", online: false, discovered: false, manual: true, error: "Not reachable" }),
    ] };
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "select_worker") list = { ...list, selectedId: (args as { id: string | null }).id };
      if (command === "add_worker") list = { ...list, workers: [...list.workers, worker({ key: "bbbbbbbbbbbbbbbb", id: "bbbbbbbbbbbbbbbb", name: "Render box", discovered: false, manual: true })] };
      return list;
    });
  });
  afterEach(cleanup);

  it("lists this computer and found workers, and switches between them", async () => {
    render(<WorkersSetting desktop />);
    expect(await screen.findByText("Studio PC")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.20:47321 · NVIDIA GeForce RTX 5090 (32 GB) · CUDA 13")).toBeInTheDocument();
    expect(screen.getByText("Not reachable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use worker 10.0.0.9:47321" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Use worker Studio PC" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("select_worker", { id: "aaaaaaaaaaaaaaaa" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use worker Studio PC" })).not.toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("slopus.generation-worker.v1")!).id).toBe("aaaaaaaaaaaaaaaa");

    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("select_worker", { id: null }));
    await waitFor(() => expect(localStorage.getItem("slopus.generation-worker.v1")).toBeNull());
  });

  it("adds workers by address and removes manual ones", async () => {
    render(<WorkersSetting desktop />);
    await screen.findByText("Studio PC");
    fireEvent.change(screen.getByRole("textbox", { name: "Worker address" }), { target: { value: "render-box" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("add_worker", { address: "render-box" }));
    expect(await screen.findByText("Render box")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove worker 10.0.0.9:47321" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("remove_worker", { key: "10.0.0.9:47321" }));
  });
});
