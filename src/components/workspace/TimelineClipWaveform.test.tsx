// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { audioWaveformSegment, loadAudioWaveform } from "../../lib/audioWaveform";
import { type ProjectAsset, type TimelineClip } from "../../lib/project";
import { TimelineClipWaveform } from "./TimelineClipWaveform";

vi.mock("../../lib/audioWaveform", () => ({
  audioWaveformSegment: vi.fn(),
  loadAudioWaveform: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("draws each waveform sample as a vertical stroke without an envelope outline", async () => {
  vi.mocked(loadAudioWaveform).mockResolvedValue({ durationSeconds: 1, levels: new Float32Array([1]) });
  vi.mocked(audioWaveformSegment).mockReturnValue([1, 0.5, 0]);
  const { container } = render(<TimelineClipWaveform
    folderPath="C:\\Project"
    asset={{ id: "asset-audio", name: "Voice", kind: "audio" } as ProjectAsset}
    clip={{ id: "clip-audio", assetId: "asset-audio", trackId: "track-a1", startMs: 0, durationMs: 1_000, sourceStartMs: 0 } as TimelineClip}
  />);

  await waitFor(() => expect(container.querySelector(".clip-audio-visualization__samples")).not.toBeNull());
  const path = container.querySelector(".clip-audio-visualization__samples");
  expect(container.querySelector("polyline")).toBeNull();
  expect(path?.getAttribute("d")).toBe("M0.00,7.00V93.00 M500.00,28.50V71.50 M1000.00,50.00V50.00");
});
