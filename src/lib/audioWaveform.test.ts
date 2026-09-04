import { describe, expect, it } from "vitest";
import { audioWaveformSegment, createAudioWaveformOverview } from "./audioWaveform";

describe("audio waveform", () => {
  it("keeps quiet passages visible on a logarithmic envelope", () => {
    const samples = new Float32Array(400);
    samples.fill(1, 0, 100);
    samples.fill(0.01, 100, 200);
    samples.fill(0, 200, 300);
    samples.fill(0.1, 300, 400);
    const overview = createAudioWaveformOverview({
      duration: 4,
      length: samples.length,
      numberOfChannels: 1,
      getChannelData: () => samples,
    }, 4);

    const levels = audioWaveformSegment(overview, 0, 4, 4);
    expect(levels[0]).toBeCloseTo(1);
    expect(levels[1]).toBeGreaterThan(0.3);
    expect(levels[1]).toBeLessThan(levels[3]);
    expect(levels[2]).toBe(0);
    expect(levels[3]).toBeGreaterThan(0.6);
  });

  it("selects only the source range represented by a trimmed clip", () => {
    const overview = { durationSeconds: 4, levels: new Float32Array([1, 0, 0.5, 0]) };
    expect(audioWaveformSegment(overview, 2, 1, 2)).toEqual([1, 1]);
  });
});
