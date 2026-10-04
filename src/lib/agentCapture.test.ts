import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cancelAgentCaptures, listenForAgentCaptures } from "./agentCapture";
import { captureTimelineFrame } from "./timelineCapture";
import { createProjectConfig, type ProjectRecord } from "./project";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./timelineCapture", () => ({ captureTimelineFrame: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("scopes captures to the turn snapshot and stops listening at completion", async () => {
  let receive: (event: { payload: { requestId: string; captureId: string; at: number } }) => void = () => {};
  const unlisten = vi.fn();
  vi.mocked(listen).mockImplementation(async (_event, handler) => { receive = handler as typeof receive; return unlisten; });
  const config = createProjectConfig({ name: "Before", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  const record = { config, folderPath: "D:/Project" } as ProjectRecord;
  const frame = { pngBase64: "png", timeMs: 1000, width: 1, height: 1 };
  vi.mocked(captureTimelineFrame).mockResolvedValue(frame);
  const dispose = await listenForAgentCaptures(record, "turn");
  record.config.name = "User edited this";
  receive({ payload: { requestId: "other", captureId: "a", at: 1 } });
  expect(captureTimelineFrame).not.toHaveBeenCalled();
  receive({ payload: { requestId: "turn", captureId: "a", at: 1 } });
  receive({ payload: { requestId: "turn", captureId: "a", at: 1 } });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("complete_agent_capture", { requestId: "turn", captureId: "a", frame }));
  expect(captureTimelineFrame).toHaveBeenCalledOnce();
  expect(vi.mocked(captureTimelineFrame).mock.calls[0][0].name).toBe("Before");
  cancelAgentCaptures("turn");
  receive({ payload: { requestId: "turn", captureId: "b", at: 2 } });
  expect(captureTimelineFrame).toHaveBeenCalledOnce();
  dispose();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("aborts an in-flight renderer and suppresses late replies when the turn stops", async () => {
  let receive: (event: { payload: { requestId: string; captureId: string; at: number } }) => void = () => {};
  vi.mocked(listen).mockImplementation(async (_event, handler) => { receive = handler as typeof receive; return vi.fn(); });
  const config = createProjectConfig({ name: "Capture", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  let signal: AbortSignal | undefined;
  let finish: () => void = () => {};
  vi.mocked(captureTimelineFrame).mockImplementation((_config, _path, _at, captureSignal) => {
    signal = captureSignal;
    return new Promise((resolve) => { finish = () => resolve({ pngBase64: "png", timeMs: 0, width: 1, height: 1 }); });
  });
  const dispose = await listenForAgentCaptures({ config, folderPath: "D:/Project" } as ProjectRecord, "cancel");
  receive({ payload: { requestId: "cancel", captureId: "a", at: 0 } });
  await vi.waitFor(() => expect(signal).toBeDefined());
  cancelAgentCaptures("cancel");
  expect(signal!.aborted).toBe(true);
  finish();
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalled();
  dispose();
});

it("returns renderer failures to the agent instead of hanging the turn", async () => {
  let receive: (event: { payload: { requestId: string; captureId: string; at: number } }) => void = () => {};
  vi.mocked(listen).mockImplementation(async (_event, handler) => { receive = handler as typeof receive; return vi.fn(); });
  const config = createProjectConfig({ name: "Capture", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  vi.mocked(captureTimelineFrame).mockRejectedValue(new Error("Missing source media"));
  const dispose = await listenForAgentCaptures({ config, folderPath: "D:/Project" } as ProjectRecord, "failure");
  receive({ payload: { requestId: "failure", captureId: "b", at: 0 } });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("complete_agent_capture", {
    requestId: "failure", captureId: "b", error: "Missing source media",
  }));
  dispose();
});
