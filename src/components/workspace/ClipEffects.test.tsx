// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timelineClipSchema, type TimelineClip } from "../../lib/project";
import { DEFAULT_CREATIVE, DEFAULT_WHEELS, parseCube } from "../../lib/effectSettings";
import { ClipEffects } from "./ClipEffects";
import { choose } from "./comboTestUtils";

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
  it("selects backdrop presets, keeps matte levels valid, and bypasses without losing controls", () => {
    render(<Harness />);
    add("Chroma key");
    choose("Chroma key backdrop", "Blue");
    expect(saved().chromaKey).toMatchObject({ backdrop: "blue", color: "#0000ff" });
    expect(screen.queryByRole("slider", { name: "Chroma key tolerance" })).toBeNull();
    fireEvent.change(screen.getByRole("slider", { name: "Chroma key clip black" }), { target: { value: "98" } });
    expect(saved().chromaKey).toMatchObject({ clipBlack: 98, clipWhite: 99 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Fill tiny holes" }));
    expect(saved().chromaKey.fillHoles).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Chroma key on" }));
    expect(saved().chromaKey).toMatchObject({ enabled: false, backdrop: "blue", fillHoles: true });
    expect(screen.getByRole("slider", { name: "Chroma key screen gain" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Chroma key on" }));
    choose("Chroma key backdrop", "Black");
    expect(saved().chromaKey.color).toBe("#000000");
    expect(screen.queryByRole("slider", { name: "Chroma key despill" })).toBeNull();
    choose("Chroma key backdrop", "Custom color");
    expect(screen.getByRole("slider", { name: "Chroma key tolerance" })).toBeTruthy();
  });
  it("disables Paste settings until settings have been copied", () => {
    render(<ClipEffects clip={{ ...original, sharpen: { amount: 50 } }} disabled={false} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Sharpen options" }));
    expect((screen.getByRole("menuitem", { name: "Paste settings" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    { name: "Opacity", patch: { look: { opacity: 65, enabled: false } } },
    { name: "Transition", patch: { transition: { type: "wipe-left", durationMs: 1200 } } },
    { name: "Chroma key", patch: { chromaKey: { color: "#123456", tolerance: 43 } } },
    { name: "Sharpen", patch: { sharpen: { amount: 125 } } },
    { name: "Gaussian blur", patch: { blur: { radius: 8.5 } } },
    { name: "Basic Corrections", patch: { colorCorrection: { exposure: -1.2, brightness: 35, contrast: 20, saturation: 75 } } },
    { name: "Vignette", patch: { vignette: { amount: 75 } } },
    { name: "Creative", patch: { creative: { ...DEFAULT_CREATIVE, look: "Night", intensity: 45 } } },
    { name: "Curves", patch: { curves: { rgb: [[0, 0], [.4, .6], [1, 1]], enabled: false } } },
    { name: "Color Wheels", patch: { colorWheels: { ...DEFAULT_WHEELS, shadows: { x: .2, y: -.4, lightness: 10 } } } },
    { name: "3D LUT", patch: { lut: { intensity: 45, table: parseCube(CUBE, "identity.cube") } } },
  ] satisfies { name: string; patch: Partial<TimelineClip> }[])("copies $name settings to another clip as one independent edit", ({ name, patch }) => {
    const onChange = vi.fn();
    const source = timelineClipSchema.parse({ ...original, ...patch });
    const view = render(<ClipEffects clip={source} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: `${name} options` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    expect(onChange).not.toHaveBeenCalled();
    // Clipboard survives leaving the inspector, including a different clip.
    view.unmount();
    const target = timelineClipSchema.parse({ ...source, id: "target", label: "Target clip", startMs: 3000 });
    render(<ClipEffects clip={target} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: `${name} options` }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste settings" }));
    expect(onChange.mock.calls).toEqual([[patch, undefined]]);
    const applied = timelineClipSchema.parse({ ...target, ...onChange.mock.calls[0][0] });
    expect(applied).toMatchObject({ ...patch, id: "target", label: "Target clip", startMs: 3000 });
    const key = Object.keys(patch)[0] as keyof TimelineClip;
    expect(onChange.mock.calls[0][0][key]).not.toBe(source[key]);
  });

  it("does not paste settings into a different effect type", () => {
    render(<Harness />);
    add("Sharpen");
    add("Gaussian blur");
    fireEvent.click(screen.getByRole("button", { name: "Sharpen options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Gaussian blur options" }));
    const paste = screen.getByRole("menuitem", { name: "Paste settings" }) as HTMLButtonElement;
    expect(paste.disabled).toBe(true);
    fireEvent.click(paste);
    expect(saved().blur).toEqual({ radius: 4 });
  });

  it("keeps LUT snapshots independent of the source and previous pastes", () => {
    const lut = { intensity: 45, table: parseCube(CUBE, "identity.cube") };
    const expected = structuredClone(lut);
    const onChange = vi.fn();
    const view = render(<ClipEffects clip={{ ...original, lut }} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "3D LUT options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy settings" }));
    lut.table.values[0] = 0.9;
    view.rerender(<ClipEffects clip={{ ...original, id: "target", lut: { intensity: 100 } }} disabled={false} onChange={onChange} />);
    for (let index = 0; index < 2; index++) {
      fireEvent.click(screen.getByRole("button", { name: "3D LUT options" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Paste settings" }));
      const pasted = onChange.mock.calls.at(-1)![0].lut;
      expect(pasted).toEqual(expected);
      pasted.table.values[0] = 0.5;
    }
  });

  it("closes the settings menu when the clip changes or becomes locked", () => {
    const clip = { ...original, sharpen: { amount: 50 } };
    const onChange = vi.fn();
    const view = render(<ClipEffects clip={clip} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Sharpen options" }));
    view.rerender(<ClipEffects clip={{ ...clip, id: "target" }} disabled={false} onChange={onChange} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sharpen options" }));
    view.rerender(<ClipEffects clip={{ ...clip, id: "target" }} disabled onChange={onChange} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sharpen options" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("bypasses an effect from its header checkbox, keeping its settings", () => {
    render(<Harness />);
    add("Sharpen");
    add("Opacity");
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Opacity on" }));
    expect(saved().look).toMatchObject({ enabled: false });
  });

  it("adds, edits and removes effects independently", () => {
    render(<Harness />);
    for (const name of ["Sharpen", "Gaussian blur", "Basic Corrections", "Vignette"]) add(name);
    fireEvent.change(screen.getByLabelText("Sharpen amount"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Blur radius"), { target: { value: "6.5" } });
    fireEvent.change(screen.getByLabelText("Exposure"), { target: { value: "-1.2" } });
    expect((screen.getByLabelText("Brightness") as HTMLInputElement).value).toBe("0");
    fireEvent.change(screen.getByLabelText("Brightness"), { target: { value: "-25" } });
    fireEvent.change(screen.getByLabelText("Saturation"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Vignette amount"), { target: { value: "75" } });
    expect(saved()).toMatchObject({
      sharpen: { amount: 120 }, blur: { radius: 6.5 }, colorCorrection: { exposure: -1.2, brightness: -25, saturation: 0 }, vignette: { amount: 75 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset brightness" }));
    expect(saved().colorCorrection).toEqual({ exposure: -1.2, brightness: 0, contrast: 0, saturation: 0 });
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

  it("edits new basic, Creative and vignette controls", () => {
    render(<Harness />);
    for (const name of ["Basic Corrections", "Creative", "Vignette"]) add(name);
    for (const label of ["Temperature", "Tint", "Highlights", "Shadows", "Whites", "Blacks"]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "25" } });
      expect(saved().colorCorrection[label.toLowerCase()]).toBe(25);
    }
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Creative look" }), { key: "End" });
    expect(saved().creative.look).toBe("Night");
    for (const [label, key] of [["Creative intensity", "intensity"], ["Faded film", "fadedFilm"], ["Creative sharpen", "sharpen"], ["Vibrance", "vibrance"]]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "30" } });
      expect(saved().creative[key]).toBe(30);
    }
    for (const key of ["amount", "midpoint", "roundness", "feather"]) {
      fireEvent.change(screen.getByLabelText(`Vignette ${key}`), { target: { value: "20" } });
      expect(saved().vignette[key]).toBe(20);
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "Creative on" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Creative" }));
    expect(saved().creative).toEqual({ ...DEFAULT_CREATIVE, enabled: false });
  });

  it("adds, moves, removes and resets curve points with keyboard and numeric controls", () => {
    render(<Harness />); add("Curves");
    fireEvent.click(screen.getByRole("button", { name: "Add point" }));
    expect(saved().curves.rgb).toEqual([[0, 0], [.5, .5], [1, 1]]);
    fireEvent.change(screen.getByLabelText("Curve point output"), { target: { value: "75" } });
    expect(saved().curves.rgb[1]).toEqual([.5, .75]);
    fireEvent.keyDown(screen.getByRole("slider", { name: "RGB point 2" }), { key: "ArrowLeft", shiftKey: true });
    expect(saved().curves.rgb[1]).toEqual([.4, .75]);
    fireEvent.click(screen.getByRole("button", { name: "Remove point" }));
    expect(saved().curves.rgb).toEqual([[0, 0], [1, 1]]);
    const combo = screen.getByRole("combobox", { name: "Curve channel" });
    for (let i = 0; i < 4; i++) fireEvent.keyDown(combo, { key: "ArrowDown" });
    fireEvent.change(screen.getByLabelText("Curve point output"), { target: { value: "70" } });
    expect(saved().curves.hueVsSat).toEqual([[0, .7], [1, .7]]);
    fireEvent.click(screen.getByRole("button", { name: "Reset curve" }));
    expect(saved().curves.hueVsSat).toEqual([[0, .5], [1, .5]]);
  });

  it("edits each wheel independently and prevents locked wheel and curve changes", () => {
    const view = render(<Harness />); add("Color Wheels");
    for (const name of ["Shadows", "Midtones", "Highlights"]) {
      fireEvent.keyDown(screen.getByRole("slider", { name: `${name} color` }), { key: "ArrowRight", shiftKey: true });
      fireEvent.change(screen.getByLabelText(`${name} lightness`), { target: { value: "-25" } });
      expect(saved().colorWheels[name.toLowerCase()]).toEqual({ x: .1, y: 0, lightness: -25 });
    }
    fireEvent.keyDown(screen.getByRole("slider", { name: "Shadows color" }), { key: "Home" });
    expect(saved().colorWheels.shadows).toEqual({ x: 0, y: 0, lightness: -25 });
    const clip = saved(); view.unmount(); const change = vi.fn();
    render(<ClipEffects clip={{ ...clip, curves: {} }} disabled onChange={change} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Shadows color" }), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("slider", { name: "RGB point 1" }), { key: "ArrowUp" });
    expect(change).not.toHaveBeenCalled();
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
    expect(screen.queryByRole("heading", { name: "Opacity" })).toBeNull();
    add("Chroma key");
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
    const picker = screen.getByRole("group", { name: "Available effects" });
    expect(within(picker).queryByRole("button", { name: "Chroma key" })).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: "Opacity" }));
    fireEvent.change(screen.getByLabelText("Clip opacity"), { target: { value: "65" } });
    remove("Chroma key");
    expect(saved().chromaKey).toBeUndefined();
    expect(saved().look.opacity).toBe(65);
  });

  it("keeps existing effects editable and moves through the picker with the arrow keys", () => {
    render(<ClipEffects clip={{ ...original, transition: { type: "wipe-left", durationMs: 800 } }} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Clip transition" }).textContent).toContain("Wipe from left");
    fireEvent.click(screen.getByRole("button", { name: "Add effect" }));
    expect(document.activeElement?.textContent).toBe("3D LUT");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe("Basic Corrections");
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
