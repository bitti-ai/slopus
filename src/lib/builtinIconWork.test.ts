// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ReferenceIconWork } from "./referenceIconWork";
import { ProjectSession } from "./projectSession";
import { createProjectConfig } from "./project";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration } from "./runtime";
import { releaseRendered } from "./generatedVideo";
import { hasBuiltinIcon, saveBuiltinIcon } from "./builtinReferenceIcons";
import type { ReferencePreset } from "./reference-presets";

vi.mock("./runtime", () => ({ enqueueSlopfabGeneration: vi.fn(), cancelSlopfabGeneration: vi.fn(), saveReferenceIcon: vi.fn() }));
vi.mock("./generatedVideo", () => ({ releaseRendered: vi.fn(async () => true) }));
vi.mock("./builtinReferenceIcons", () => ({ hasBuiltinIcon: vi.fn(() => false), saveBuiltinIcon: vi.fn(async () => undefined) }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
const presets: ReferencePreset[] = [
  { id: "test-alice", type: "character", name: "Alice", prompt: "Alice in a blue dress.", subcategory: "Stories" },
  { id: "test-forest", type: "location", name: "Forest", prompt: "A green forest.", subcategory: "Nature" },
];
const setup = () => {
  const writer = vi.fn(async () => undefined);
  const session = new ProjectSession({ folderPath: "C:/project", config: createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 }) }, writer);
  const changed = vi.fn();
  const work = new ReferenceIconWork(changed, vi.fn());
  work.enqueueBuiltins(session, presets);
  return { work, session, writer, changed };
};

it("interrupts a built-in icon for video work, retries it, and saves shared artwork without modifying the project", async () => {
  const { work, session, writer } = setup();
  const before = session.getSnapshot().config;
  const first = work.runNext(Promise.resolve(), () => false);
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
  const id = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0].jobId;
  work.yieldToVideo();
  expect(cancelSlopfabGeneration).toHaveBeenCalledWith(id);
  work.event({ jobId: id, state: "cancelled", detail: "Cancelled" });
  await first;
  expect(work.hasRunnable()).toBe(true);
  await work.runNext(Promise.resolve(), () => true);
  expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce();
  const retry = work.runNext(Promise.resolve(), () => false);
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
  const retryId = vi.mocked(enqueueSlopfabGeneration).mock.calls[1][0].jobId;
  expect(retryId).not.toBe(id);
  work.event({ jobId: retryId, state: "framesReady", detail: "Ready" });
  await retry;
  expect(saveBuiltinIcon).toHaveBeenCalledWith("test-alice", retryId);
  expect(releaseRendered).toHaveBeenCalledWith(retryId);
  expect(session.getSnapshot().config).toBe(before);
  expect(writer).not.toHaveBeenCalled();
  expect(work.confirmationCount()).toBe(0);
});

it("skips saved built-ins and deduplicates the shared batch across projects", async () => {
  vi.mocked(hasBuiltinIcon).mockImplementation((id) => id === "test-alice");
  const { work, session } = setup();
  work.enqueueBuiltins(session, presets);
  const pending = work.runNext(Promise.resolve(), () => false);
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
  const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
  expect(request.prompt).toContain("A green forest.");
  work.event({ jobId: request.jobId, state: "framesReady", detail: "Ready" });
  await pending;
  expect(work.hasRunnable()).toBe(false);
  vi.mocked(hasBuiltinIcon).mockReturnValue(false);
});

it("stops the remaining catalog after an engine failure instead of repeating it for every preset", async () => {
  const { work } = setup();
  vi.mocked(enqueueSlopfabGeneration).mockRejectedValueOnce(new Error("Missing model weights"));
  await work.runNext(Promise.resolve(), () => false);
  expect(work.hasRunnable()).toBe(false);
});

it("regenerates existing icons on request and publishes only after the final frame is ready", async () => {
  vi.mocked(hasBuiltinIcon).mockReturnValue(true);
  const { work, session } = setup();
  work.enqueueBuiltins(session, [presets[0]], true);
  work.enqueueBuiltins(session, [presets[0]], true);
  expect(work.pendingBuiltinIds()).toEqual(new Set([presets[0].id]));
  const running = work.runNext(Promise.resolve(), () => false);
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
  const id = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0].jobId;
  work.progressEvent({ jobId: id, step: 10, totalSteps: 20 });
  expect(saveBuiltinIcon).not.toHaveBeenCalled();
  work.event({ jobId: id, state: "framesReady", detail: "Ready" });
  await running;
  expect(saveBuiltinIcon).toHaveBeenCalledWith(presets[0].id, id);
  expect(work.pendingBuiltinIds().size).toBe(0);
  vi.mocked(hasBuiltinIcon).mockReturnValue(false);
});

it("generates all built-ins in category order even when enqueued in reverse order", async () => {
  const { work, session } = setup();
  await work.cancel();
  const categories = ["character", "animal", "product", "location", "style"] as const;
  const reversed = [...categories].reverse().map((type) => ({ id: `ordered-${type}`, name: type, prompt: `A ${type}.`, type, subcategory: "Test" }));
  work.enqueueBuiltins(session, reversed);
  for (const type of categories) {
    const running = work.runNext(Promise.resolve(), () => false);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(categories.indexOf(type) + 1));
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls.at(-1)![0];
    expect(request.prompt).toContain(`A ${type}.`);
    work.event({ jobId: request.jobId, state: "framesReady", detail: "Ready" });
    await running;
  }
  expect(work.hasRunnable()).toBe(false);
});
