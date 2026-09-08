// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { loadReferenceIconAutomation, saveReferenceIconAutomation, subscribeReferenceIconAutomation } from "./referenceIconSettings";

beforeEach(() => localStorage.clear());

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
