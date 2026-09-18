// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { timelineClipSchema, type TimelineClip } from "../../lib/project";
import { ClipEffects } from "./ClipEffects";

afterEach(cleanup);
const original: TimelineClip = {
  id: "clip", assetId: "asset", trackId: "video", label: "Clip", startMs: 0,
  durationMs: 2000, sourceStartMs: 0, status: "approved",
};
function Harness() {
  const [clip, setClip] = useState(original);
  return <><ClipEffects clip={clip} disabled={false} onChange={(patch) => setClip((current) => timelineClipSchema.parse({ ...current, ...patch }))} /><output data-testid="saved">{JSON.stringify(clip)}</output></>;
}

describe("clip effects", () => {
  it("adds, edits and removes the new effects independently", () => {
    render(<Harness />);
    for (const name of [/Sharpen Enhance/, /Gaussian Blur Soften/, /Color Correction Adjust/, /Vignette Darken/]) {
      fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
      fireEvent.click(screen.getByRole("button", { name }));
    }
    fireEvent.change(screen.getByLabelText("Sharpen amount"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("Blur radius"), { target: { value: "6.5" } });
    fireEvent.change(screen.getByLabelText("Exposure"), { target: { value: "-1.2" } });
    fireEvent.change(screen.getByLabelText("Saturation"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Vignette amount"), { target: { value: "75" } });
    expect(JSON.parse(screen.getByTestId("saved").textContent!)).toMatchObject({
      sharpen: { amount: 120 }, blur: { radius: 6.5 }, colorCorrection: { exposure: -1.2, saturation: 0 }, vignette: { amount: 75 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove Gaussian Blur effect" }));
    expect(JSON.parse(screen.getByTestId("saved").textContent!).blur).toBeUndefined();
    expect(screen.getByLabelText("Sharpen amount")).toBeTruthy();
  });

  it("imports a LUT, adjusts its strength, and preserves it after an invalid replacement", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
    fireEvent.click(screen.getByRole("button", { name: /3D LUT Apply/ }));
    const cube = "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1";
    fireEvent.change(screen.getByLabelText("Import cube LUT"), { target: { files: [{ name: "identity.cube", size: cube.length, text: async () => cube }] } });
    await screen.findByText("identity.cube · 2³");
    fireEvent.change(screen.getByLabelText("LUT intensity"), { target: { value: "45" } });
    fireEvent.change(screen.getByLabelText("Import cube LUT"), { target: { files: [{ name: "bad.cube", size: 4, text: async () => "oops" }] } });
    await screen.findByRole("alert");
    expect(JSON.parse(screen.getByTestId("saved").textContent!).lut).toMatchObject({ intensity: 45, table: { name: "identity.cube", size: 2 } });
  });

  it("does not apply an outstanding LUT import to a different clip", async () => {
    let resolve!: (text: string) => void;
    const pending = new Promise<string>((done) => { resolve = done; });
    const onChange = vi.fn();
    const view = render(<ClipEffects clip={{ ...original, lut: { intensity: 100 } }} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Import cube LUT"), { target: { files: [{ name: "identity.cube", size: 50, text: () => pending }] } });
    view.rerender(<ClipEffects clip={{ ...original, id: "other", lut: { intensity: 100 } }} disabled={false} onChange={onChange} />);
    resolve("LUT_3D_SIZE 2\n" + "0 0 0\n".repeat(8));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds only chosen effects, persists edits, and removes them without changing other effects", () => {
    render(<Harness />);
    expect(screen.queryByRole("heading", { name: "Look" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Transition" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
    fireEvent.click(screen.getByRole("button", { name: /Chroma Key Make/ }));
    fireEvent.change(screen.getByLabelText("Chroma Key color"), { target: { value: "#123456" } });
    fireEvent.change(screen.getByLabelText("Chroma Key tolerance"), { target: { value: "43" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
    const picker = screen.getByRole("group", { name: "Available effects" });
    expect(within(picker).queryByText("Chroma Key")).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: /Look Opacity/ }));
    fireEvent.change(screen.getByLabelText("Clip opacity"), { target: { value: "65" } });
    expect(JSON.parse(screen.getByTestId("saved").textContent!)).toMatchObject({ chromaKey: { color: "#123456", tolerance: 43 }, look: { opacity: 65 } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Chroma Key effect" }));
    const saved = JSON.parse(screen.getByTestId("saved").textContent!);
    expect(saved.chromaKey).toBeUndefined();
    expect(saved.look.opacity).toBe(65);
    fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
    expect(screen.getByRole("button", { name: /Chroma Key Make/ })).toBeTruthy();
  });

  it("keeps existing effects editable and closes the keyboard picker with Escape", () => {
    render(<ClipEffects clip={{ ...original, transition: { type: "wipe-left", durationMs: 800 } }} disabled={false} onChange={vi.fn()} />);
    expect((screen.getByLabelText("Clip transition") as HTMLSelectElement).value).toBe("wipe-left");
    fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
    expect(document.activeElement?.textContent).toContain("Look");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Chroma Key");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Available effects" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add Effect" }));
  });

  it("disables effects for locked or nonvisual clips and closes the picker when selection changes", () => {
    const props = { onChange: vi.fn(), clip: original, disabled: false };
    const view = render(<ClipEffects {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Effect" }));
    view.rerender(<ClipEffects {...props} clip={{ ...original, id: "next" }} />);
    expect(screen.queryByRole("group", { name: "Available effects" })).toBeNull();
    view.rerender(<ClipEffects {...props} disabled clip={{ ...original, chromaKey: { color: "#00ff00", tolerance: 20 } }} />);
    expect((screen.getByRole("button", { name: "Add Effect" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove Chroma Key effect" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Chroma Key tolerance"), { target: { value: "40" } });
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
