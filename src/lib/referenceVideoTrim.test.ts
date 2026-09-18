import { describe, expect, it } from "vitest";
import { editReferenceVideoTrim, initialReferenceVideoTrim, normalizeReferenceVideoTrim } from "./referenceVideoTrim";

describe("video reference selection", () => {
  it("starts with the first 15 seconds of a long source and the whole of a shorter source", () => {
    expect(initialReferenceVideoTrim(7200)).toEqual({ startSeconds: 0, durationSeconds: 15 });
    expect(initialReferenceVideoTrim(7.25)).toEqual({ startSeconds: 0, durationSeconds: 7.25 });
    expect(() => initialReferenceVideoTrim(1.9)).toThrow("at least 2");
  });
  it("moves a selection without changing its length or exceeding the source", () => {
    const original = initialReferenceVideoTrim(120);
    expect(editReferenceVideoTrim(original, 120, "move", 60)).toEqual({ startSeconds: 60, durationSeconds: 15 });
    expect(editReferenceVideoTrim(original, 120, "move", 119)).toEqual({ startSeconds: 105, durationSeconds: 15 });
    expect(editReferenceVideoTrim(original, 120, "move", -1).startSeconds).toBe(0);
  });
  it("resizes either edge while retaining the opposite edge and the 2–15 second bounds", () => {
    const original = { startSeconds: 30, durationSeconds: 10 };
    expect(editReferenceVideoTrim(original, 120, "start", 35)).toEqual({ startSeconds: 35, durationSeconds: 5 });
    expect(editReferenceVideoTrim(original, 120, "start", 0)).toEqual({ startSeconds: 25, durationSeconds: 15 });
    expect(editReferenceVideoTrim(original, 120, "end", 31)).toEqual({ startSeconds: 30, durationSeconds: 2 });
    expect(editReferenceVideoTrim(original, 120, "end", 90)).toEqual({ startSeconds: 30, durationSeconds: 15 });
    expect(editReferenceVideoTrim({ startSeconds: 117, durationSeconds: 3 }, 120, "duration", 15).durationSeconds).toBe(3);
  });
  it("clamps older saved selections after a source is replaced by a shorter video", () => {
    expect(normalizeReferenceVideoTrim({ startSeconds: 50, durationSeconds: 15 }, 8)).toEqual({ startSeconds: 0, durationSeconds: 8 });
  });
  it("keeps fractional edits within schema bounds", () => {
    for (let i = 0; i < 200; i++) {
      const trim = editReferenceVideoTrim({ startSeconds: i / 10, durationSeconds: 15 }, 60, "start", 0);
      expect(trim.durationSeconds).toBeGreaterThanOrEqual(2);
      expect(trim.durationSeconds).toBeLessThanOrEqual(15);
      expect(trim.startSeconds + trim.durationSeconds).toBeLessThanOrEqual(60);
    }
  });
});
