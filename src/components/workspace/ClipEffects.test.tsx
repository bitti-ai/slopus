// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timelineClipSchema, type TimelineClip } from "../../lib/project";
import { ClipEffects } from "./ClipEffects";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);
const original: TimelineClip = {
  id: "clip", assetId: "asset", trackId: "video", label: "Clip", startMs: 0,
  durationMs: 2000, sourceStartMs: 0, status: "approved",
};
function Harness() {
  const [clip, setClip] = useState(original);
  return <><ClipEffects clip={clip} disabled={false} onChange={(patch) => setClip((current) => timelineClipSchema.parse({ ...current, ...patch }))} /><output data-testid="saved">{JSON.stringify(clip)}</output></>;
}
const saved = () => JSON.parse(screen.getByTestId("saved").textContent!);
const add = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Available effects" })).getByRole("button", { name }));
};
const remove = (name: string) => {
  fireEvent.click(screen.getByRole("button", { name: `${name} options` }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Remove/ }));
};

/* pickFile and readLutFile both go through invoke once the page believes it is
   inside Tauri: pick_file answers with a path, read_lut_file with its text. */
async function inTauri(answers: Record<string, (args: unknown) => unknown>, body: () => Promise<void>) {
  const { invoke } = await import("@tauri-apps/api/core");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => answers[command]?.(args) as never);
  try { await body(); } finally {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
  }
}

const CUBE = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1";

describe("clip effects", () => {
  it("bypasses an effect from its header checkbox, keeping its settings", () => {
    render(<Harness />);
    add("Sharpen");
    add("Look");
    fireEvent.change(screen.getByLabelText("Sharpen amount"), { target: { value: "120" } });
    const sharpenOn = screen.getByRole("checkbox", { name: "Sharpen on" }) as HTMLInputElement;
    expect(sharpenOn.checked).toBe(true);
    // A fresh effect carries no flag at all: the file keeps its old shape.
    expect(saved().sharpen).toEqual({ amount: 120 });
    fireEvent.click(sharpenOn);
    expect(saved().sharpen).toEqual({ amount: 120, enabled: false });
    expect(screen.getByRole("region", { name: "Sharpen effect" }).className).toContain("clip-effect--bypassed");
    // Editing or resetting a bypassed effect leaves it off.
    fireEvent.change(screen.getByLabelText("Sharpen amount"), { target: { value: "80" } });
    expect(saved().sharpen).toEqual({ amount: 80, enabled: false });
    fireEvent.click(screen.getByRole("button", { name: "Reset Sharpen" }));
    expect(saved().sharpen).toEqual({ amount: 50, enabled: false });
    fireEvent.click(sharpenOn);
    expect(saved().sharpen).toEqual({ amount: 50 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Look on" }));
    expect(saved().look).toMatchObject({ enabled: false });
  });

  it("adds, edits and removes effects independently", () => {
    render(<Harness />);
    for (const name of ["Sharpen", "Gaussian blur", "Colour correction", "Vignette"]) add(name);
    fireEvent.change(screen.getByLabelText("Sharpen amount"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Blur radius"), { target: { value: "6.5" } });
    fireEvent.change(screen.getByLabelText("Exposure"), { target: { value: "-1.2" } });
    fireEvent.change(screen.getByLabelText("Saturation"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Vignette amount"), { target: { value: "75" } });
    expect(saved()).toMatchObject({
      sharpen: { amount: 120 }, blur: { radius: 6.5 }, colorCorrection: { exposure: -1.2, saturation: 0 }, vignette: { amount: 75 },
    });
    remove("Gaussian blur");
    expect(saved().blur).toBeUndefined();
    expect(screen.getByLabelText("Sharpen amount")).toBeTruthy();
  });

  it("gives each effect a collapsible header with Reset", () => {
    render(<Harness />);
    add("Vignette");
    fireEvent.change(screen.getByLabelText("Vignette amount"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset Vignette" }));
    expect(saved().vignette).toEqual({ amount: 35 });
    const toggle = screen.getByRole("button", { name: "Vignette" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Vignette amount")).toBeNull();
  });

  it("describes each effect in a tooltip rather than a second line", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
    const item = within(screen.getByRole("group", { name: "Available effects" })).getByRole("button", { name: "Sharpen" });
    expect(item.getAttribute("data-tooltip")).toBe("Enhance fine edges and detail");
  });

  it("imports a LUT through the native Open dialog, and keeps it after a bad replacement", async () => {
    await inTauri({
      pick_file: () => "C:\\Looks\\identity.cube",
      read_lut_file: (args) => ((args as { path: string }).path.endsWith("identity.cube") ? CUBE : "oops"),
    }, async () => {
      render(<Harness />);
      add("3D LUT");
      fireEvent.click(screen.getByRole("button", { name: "Import LUT" }));
      await screen.findByText("identity.cube · 2³");
      const { invoke } = await import("@tauri-apps/api/core");
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("pick_file", { title: "Import LUT", filters: [{ name: "Cube LUT", extensions: ["cube"] }] });
      fireEvent.change(screen.getByLabelText("LUT intensity"), { target: { value: "45" } });
      vi.mocked(invoke).mockImplementation(async (command: string) => (command === "pick_file" ? "C:\\Looks\\bad.cube" : "oops") as never);
      fireEvent.click(screen.getByRole("button", { name: "Replace LUT" }));
      await screen.findByRole("alert");
      expect(saved().lut).toMatchObject({ intensity: 45, table: { name: "identity.cube", size: 2 } });
    });
  });

  it("does not apply an outstanding LUT import to a different clip", async () => {
    let resolve!: (text: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    await inTauri({ pick_file: () => "C:\\Looks\\identity.cube", read_lut_file: () => pending }, async () => {
      const onChange = vi.fn();
      const view = render(<ClipEffects clip={{ ...original, lut: { intensity: 100 } }} disabled={false} onChange={onChange} />);
      fireEvent.click(screen.getByRole("button", { name: "Import LUT" }));
      await screen.findByRole("status");
      view.rerender(<ClipEffects clip={{ ...original, id: "other", lut: { intensity: 100 } }} disabled={false} onChange={onChange} />);
      await act(async () => { resolve("LUT_3D_SIZE 2\n" + "0 0 0\n".repeat(8)); });
      await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it("picks a chroma key colour from a swatch and a hex field", () => {
    render(<Harness />);
    add("Chroma key");
    fireEvent.click(screen.getByRole("button", { name: "Chroma key colour" }));
    fireEvent.change(screen.getByLabelText("Hex"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByLabelText("Chroma key tolerance"), { target: { value: "43" } });
    expect(saved()).toMatchObject({ chromaKey: { color: "#123456", tolerance: 43 } });
    expect(screen.getByLabelText("Hue")).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Saturation and brightness" })).toBeTruthy();
  });

  it("adds only chosen effects, and removes them without changing other effects", () => {
    render(<Harness />);
    expect(screen.queryByRole("heading", { name: "Look" })).toBeNull();
    add("Chroma key");
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
    const picker = screen.getByRole("group", { name: "Available effects" });
    expect(within(picker).queryByRole("button", { name: "Chroma key" })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Look" }));
    fireEvent.change(screen.getByLabelText("Clip opacity"), { target: { value: "65" } });
    remove("Chroma key");
    expect(saved().chromaKey).toBeUndefined();
    expect(saved().look.opacity).toBe(65);
  });

  it("keeps existing effects editable and moves through the picker with the arrow keys", () => {
    render(<ClipEffects clip={{ ...original, transition: { type: "wipe-left", durationMs: 800 } }} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Clip transition" }).textContent).toContain("Wipe from left");
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
    expect(document.activeElement?.textContent).toBe("Look");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Chroma key");
  });

  it("disables effects for locked or nonvisual clips and closes the picker when selection changes", () => {
    const props = { onChange: vi.fn(), clip: original, disabled: false };
    const view = render(<ClipEffects {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
    view.rerender(<ClipEffects {...props} clip={{ ...original, id: "next" }} />);
    expect(screen.queryByRole("group", { name: "Available effects" })).toBeNull();
    view.rerender(<ClipEffects {...props} disabled clip={{ ...original, chromaKey: { color: "#00ff00", tolerance: 20 } }} />);
    expect((screen.getByRole("button", { name: "Add effect" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Chroma key options" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Chroma key tolerance"), { target: { value: "40" } });
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
