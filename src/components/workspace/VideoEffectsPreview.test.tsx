// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoEffectsPreview, type GpuEffects } from "../../lib/videoEffectsGpu";
import { VideoEffectsPreview } from "./VideoEffectsPreview";

vi.mock("../../lib/videoEffectsGpu", () => ({ createVideoEffectsPreview: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

function Harness({ effects, playing = false, onError = vi.fn() }: { effects: GpuEffects; playing?: boolean; onError?: (message: string) => void }) {
  const image = useRef<HTMLImageElement>(null);
  return <><img ref={image} src="blob:picture" alt="Source" /><VideoEffectsPreview source={image} sourceUrl="blob:picture" effects={effects} playing={playing} onError={onError} /></>;
}

describe("GPU effects preview lifecycle", () => {
  it("reuses the prepared renderer when playback starts and stops", async () => {
    const renderer = { draw: vi.fn(), dispose: vi.fn() };
    vi.mocked(createVideoEffectsPreview).mockResolvedValue(renderer);
    let nextId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const view = render(<Harness effects={{ blur: { radius: 4 } }} />);
    await act(async () => undefined);
    expect(frames.size).toBe(0);
    view.rerender(<Harness effects={{ blur: { radius: 4 } }} playing />);
    expect(frames.size).toBe(1);
    view.rerender(<Harness effects={{ blur: { radius: 4 } }} />);
    expect(frames.size).toBe(0);
    expect(createVideoEffectsPreview).toHaveBeenCalledTimes(1);
    expect(renderer.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("redraws paused media after seeking and editing without recreating GPU resources", async () => {
    const renderer = { draw: vi.fn(), dispose: vi.fn() };
    vi.mocked(createVideoEffectsPreview).mockResolvedValue(renderer);
    const view = render(<Harness effects={{ blur: { radius: 4 } }} />);
    await act(async () => {});
    expect(renderer.draw).toHaveBeenCalledWith(screen.getByAltText("Source"), { blur: { radius: 4 } });
    renderer.draw.mockClear();
    fireEvent.seeked(screen.getByAltText("Source"));
    expect(renderer.draw).toHaveBeenCalledTimes(1);
    view.rerender(<Harness effects={{ blur: { radius: 8 } }} />);
    expect(renderer.draw).toHaveBeenLastCalledWith(screen.getByAltText("Source"), { blur: { radius: 8 } });
    expect(createVideoEffectsPreview).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a renderer that finishes initializing after the clip is removed", async () => {
    const renderer = { draw: vi.fn(), dispose: vi.fn() };
    let resolve!: (value: typeof renderer) => void;
    vi.mocked(createVideoEffectsPreview).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<Harness effects={{ sharpen: { amount: 50 } }} />);
    view.unmount();
    await act(async () => resolve(renderer));
    expect(renderer.draw).not.toHaveBeenCalled();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("reports GPU startup and draw failures", async () => {
    const onError = vi.fn();
    vi.mocked(createVideoEffectsPreview).mockRejectedValue(new Error("No GPU adapter"));
    const view = render(<Harness effects={{ vignette: { amount: 50 } }} onError={onError} />);
    await act(async () => {});
    expect(onError).toHaveBeenCalledWith("Error: No GPU adapter");
    view.unmount();
    const renderer = { draw: vi.fn(() => { throw new Error("Device lost"); }), dispose: vi.fn() };
    vi.mocked(createVideoEffectsPreview).mockResolvedValue(renderer);
    render(<Harness effects={{ sharpen: { amount: 50 } }} onError={onError} />);
    await act(async () => {});
    expect(onError).toHaveBeenCalledWith("Error: Device lost");
  });
});
