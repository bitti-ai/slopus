// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { loadReferenceIconAutomation, referenceIconGenerator, saveReferenceIconAutomation, saveReferenceIconGeneratorId, subscribeReferenceIconAutomation } from "./referenceIconSettings";
import { createGeneratorTemplate } from "./settings";

beforeEach(() => localStorage.clear());

it("falls back to an available still generator when the icon choice disappears", () => {
  const available = createGeneratorTemplate("Available"), animate = { ...createGeneratorTemplate("Animate"), mode: "animate" as const };
  const pending = createGeneratorTemplate("Download");
  pending.paths.transformer = "https://example.com/weights.safetensors";
  const settings = { templates: [animate, pending, available], defaultTemplateId: animate.id };
  saveReferenceIconGeneratorId("removed");
  expect(referenceIconGenerator(settings)?.id).toBe(available.id);
  expect(referenceIconGenerator({ ...settings, templates: [animate, pending] })).toBeUndefined();
});

it("defaults to confirmation and ignores invalid stored choices", () => {
  expect(loadReferenceIconAutomation()).toBe("ask");
  localStorage.setItem("slopus.reference-icon-automation.v1", "unexpected");
  expect(loadReferenceIconAutomation()).toBe("ask");
});

it("persists choices and notifies subscribers until disconnected", () => {
  const listener = vi.fn();
  const stop = subscribeReferenceIconAutomation(listener);
  saveReferenceIconAutomation("enabled");
  expect(loadReferenceIconAutomation()).toBe("enabled");
  expect(listener).toHaveBeenCalledTimes(1);
  saveReferenceIconAutomation("disabled");
  expect(loadReferenceIconAutomation()).toBe("disabled");
  window.dispatchEvent(new StorageEvent("storage", { key: "slopus.reference-icon-automation.v1" }));
  expect(listener).toHaveBeenCalledTimes(3);
  stop();
  saveReferenceIconAutomation("ask");
  expect(listener).toHaveBeenCalledTimes(3);
});

it("honors a disabled choice for the session when storage cannot be written", () => {
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
  try {
    saveReferenceIconAutomation("disabled");
    expect(loadReferenceIconAutomation()).toBe("disabled");
  } finally {
    write.mockRestore();
    saveReferenceIconAutomation("ask");
  }
});
