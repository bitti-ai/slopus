// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createProjectConfig } from "./project";
import { defaultExportSettings, buildExportPlan } from "./export";
import { runExport, writeExportFile, type ExportProgress, type ExportResult } from "./exportPipeline";
import { cancelExportJob, clearFinishedExports, getExportJobs, resetExportJobForTests, startExportJob, startImageExportJob } from "./exportJob";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./nativeShell", () => ({ setTaskbarProgress: vi.fn(async () => undefined) }));
vi.mock("./exportPipeline", async (original) => ({ ...await original<typeof import("./exportPipeline")>(), runExport: vi.fn(), writeExportFile: vi.fn(async () => 42) }));
beforeEach(() => { resetExportJobForTests(); vi.clearAllMocks(); vi.mocked(invoke).mockResolvedValue(24); });

const image = (destination = "D:/image.png") => ({ folderPath: "D:/Project", projectName: "Project", relativePath: "media/generated/image.png", destination, options: { format: "png" as const } });
const result = { bytes: new Uint8Array(42), audioProblems: [], audioShortfalls: [] } as unknown as ExportResult;
const video = () => {
  const config = createProjectConfig({ name: "Movie", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 5 });
  const settings = defaultExportSettings(config);
  return { folderPath: "D:/Movie", config, settings, plan: buildExportPlan(config, settings), bitrate: 1000, destination: "D:/movie.mp4" };
};

it("queues image and video exports together, snapshots settings, and retains their results", async () => {
  let finish!: (result: ExportResult) => void;
  vi.mocked(runExport).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const options = video();
  const first = startExportJob(options);
  const second = startImageExportJob(image());
  options.config.name = "Edited while exporting";
  expect(getExportJobs().map((job) => job.status)).toEqual(["running", "queued"]);
  expect(runExport).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ name: "Movie" }) }));
  expect(invoke).not.toHaveBeenCalled();
  finish(result);
  await Promise.all([first, second]);
  expect(writeExportFile).toHaveBeenCalledWith("D:/movie.mp4", result.bytes);
  expect(invoke).toHaveBeenCalledWith("export_generated_image", expect.objectContaining({ destination: "D:/image.png", jobId: expect.any(String) }));
  expect(getExportJobs().map((job) => [job.kind, job.status])).toEqual([["video", "completed"], ["image", "completed"]]);
  clearFinishedExports(); expect(getExportJobs()).toEqual([]);
});

it("cancels waiting exports without starting them and continues after a running export fails", async () => {
  let fail!: (reason: Error) => void;
  vi.mocked(runExport).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const first = startExportJob(video());
  const cancelled = startImageExportJob(image("D:/cancelled.png"));
  const next = startImageExportJob(image("D:/next.png"));
  cancelExportJob(getExportJobs()[1].id);
  await cancelled;
  fail(new Error("Encoder unavailable"));
  await Promise.all([first, next]);
  expect(getExportJobs().map((job) => job.status)).toEqual(["failed", "cancelled", "completed"]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("export_generated_image", expect.objectContaining({ destination: "D:/next.png" }));
});

it("follows image progress outside its view and cancels the native export", async () => {
  let progress!: (event: { payload: ExportProgress & { jobId: string } }) => void;
  vi.mocked(listen).mockImplementation((async (_event, callback) => { progress = callback as typeof progress; return () => undefined; }) as typeof listen);
  let reject!: (reason: Error) => void;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "export_generated_image") return new Promise((_resolve, no) => { reject = no; });
    if (command === "cancel_image_export") reject(new Error("Export cancelled."));
  });
  const done = startImageExportJob(image());
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("export_generated_image", expect.anything()));
  const id = getExportJobs()[0].id!;
  progress({ payload: { jobId: id, phase: "rendering", framesDone: 0, frameCount: 1, detail: "Upscaling on worker" } });
  expect(getExportJobs()[0].progress?.detail).toBe("Upscaling on worker");
  cancelExportJob(id); await done;
  expect(invoke).toHaveBeenCalledWith("cancel_image_export", { jobId: id });
  expect(getExportJobs()[0]).toMatchObject({ status: "cancelled", cancelling: false });
});
