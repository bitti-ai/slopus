import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { saveGeneratedScene } from "../../lib/generatedVideo";
import { isTauri } from "../../lib/persistence";
import type { GenerationJob, ProjectConfig } from "../../lib/project";

/* Everything the video engine says about a scene, and what to do about it.
 *
 * This lives in the WORKSPACE rather than in the Generator, and that is the
 * point: a render takes minutes, and the natural thing to do while it runs is
 * to go and work on the timeline. When these listeners were mounted by the
 * Generator, doing that unmounted them — progress stopped landing, and the
 * event announcing a finished render arrived at nobody. Now the whole project
 * screen carries them, so a scene that finishes while the user is somewhere
 * else is still recorded and still saved.
 *
 * Saving is the second half. vidfab produces pictures and frees them; a finished
 * render is a few hundred megabytes waiting in Rust's memory that nothing else
 * will claim. As soon as the engine says the frames are ready, this encodes
 * them (see lib/generatedVideo.ts) and writes the .mp4 into the project. */

/** The event the queue emits when a scene's state changes. */
interface JobEvent {
  jobId: string;
  state: "queued" | "framesReady" | "failed" | "cancelled" | string;
  detail: string;
}

interface ProgressEvent {
  jobId: string;
  stage: string;
  step: number;
  totalSteps: number;
}

/** Rendering is most of the wait, so it owns most of the bar; encoding is the
 *  last slice, and it gets its own so a finished render does not sit at 92%
 *  looking stalled while the encoder works. */
const RENDER_CEILING = 0.9;
const ENCODE_FLOOR = 0.9;

export function useGenerationEvents({ folderPath, onChange }: {
  folderPath: string;
  /** The updater form, always: every write here happens after an await, so the
   *  config this component last saw is not the one to build from. */
  onChange: (update: (current: ProjectConfig) => ProjectConfig) => void;
}) {
  /* Held in refs so the subscription is made ONCE. It has to be: re-subscribing
     on every progress tick would drop events in the gap, and these events are
     the only record that a render happened at all. */
  const write = useRef(onChange);
  write.current = onChange;
  const folder = useRef(folderPath);
  folder.current = folderPath;
  /** Scenes already being encoded, so a repeated event — or a remount in
   *  StrictMode — cannot start a second encode of the same frames. */
  const saving = useRef(new Set<string>());

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const updateJob = (jobId: string, updates: Partial<GenerationJob>) => {
      write.current((current) => ({
        ...current,
        generationJobs: current.generationJobs.map((job) => (job.id === jobId ? { ...job, ...updates, updatedAt: new Date().toISOString() } : job)),
      }));
    };

    /** Encode the frames the engine just finished, and write the file.
     *
     *  This deliberately keeps going after `disposed`: the project screen can
     *  unmount while an encode is in flight, and stopping there would leave the
     *  frames in memory and the scene with nothing to show for the render. The
     *  writes it makes are updaters against whatever config is current, and the
     *  Rust side is told to let the frames go either way. */
    const save = async (jobId: string) => {
      if (saving.current.has(jobId)) return;
      saving.current.add(jobId);
      updateJob(jobId, { status: "ready", stage: "encoding", progress: ENCODE_FLOOR, error: null });
      try {
        const saved = await saveGeneratedScene({
          folderPath: folder.current,
          jobId,
          onProgress: (encoded, total) => {
            if (total > 0) updateJob(jobId, { progress: Math.min(0.99, ENCODE_FLOOR + (encoded / total) * (1 - ENCODE_FLOOR)) });
          },
        });
        updateJob(jobId, {
          status: "completed",
          stage: "completed",
          progress: 1,
          outputRelativePath: saved.relativePath,
          // A note means something was left out of the file — the file exists
          // and the scene is finished, so this is not a failure, but it is not
          // silence either.
          error: saved.note,
        });
      } catch (reason) {
        /* The render happened and the file did not. Failed is the honest state:
           there is nothing to insert into the timeline, and the only way to get
           this scene is to run it again. */
        updateJob(jobId, {
          status: "failed",
          stage: "failed",
          error: `The scene rendered but could not be saved as a video file. ${reason instanceof Error ? reason.message : String(reason)}`,
        });
      } finally {
        saving.current.delete(jobId);
      }
    };

    const subscriptions = Promise.all([
      listen<ProgressEvent>("vidfab-progress", ({ payload }) => {
        if (disposed) return;
        const progress = payload.totalSteps > 0
          ? Math.min(RENDER_CEILING - 0.02, 0.12 + (Math.max(0, payload.step) / payload.totalSteps) * (RENDER_CEILING - 0.14))
          : payload.stage === "delivering" ? RENDER_CEILING - 0.02 : 0.08;
        updateJob(payload.jobId, {
          status: "generating",
          stage: payload.stage === "starting" || payload.stage === "transformerLoad" ? "preparing" : "generating",
          progress,
        });
      }),
      listen<JobEvent>("vidfab-job", ({ payload }) => {
        if (disposed) return;
        if (payload.state === "framesReady") {
          void save(payload.jobId);
          return;
        }
        updateJob(payload.jobId, payload.state === "failed"
          ? { status: "failed", stage: "failed", error: payload.detail }
          : payload.state === "cancelled"
            ? { status: "cancelled", stage: "failed", error: payload.detail }
            : { status: "queued", stage: "queued" });
      }),
    ]);
    return () => {
      disposed = true;
      void subscriptions.then((unlisten) => unlisten.forEach((stop) => stop()));
    };
  }, []);
}
