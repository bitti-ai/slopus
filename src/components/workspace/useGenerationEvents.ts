import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { describeDiagnosticError, errorContext, writeDiagnostic } from "../../lib/diagnostics";
import { GenerationTimingEstimator, type CompletedGenerationTiming, type GenerationTimingProgress } from "../../lib/generationTiming";
import { saveGeneratedScene } from "../../lib/generatedVideo";
import { isTauri } from "../../lib/persistence";
import { generationAssetId, type GenerationJob, type ProjectConfig } from "../../lib/project";

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
  output?: CompletedGenerationTiming | null;
}

type ProgressEvent = GenerationTimingProgress;

/** Rendering is most of the wait, so it owns most of the bar; encoding is the
 *  last slice, and it gets its own so a finished render does not sit at 92%
 *  looking stalled while the encoder works. */
const RENDER_CEILING = 0.9;
const ENCODE_FLOOR = 0.9;
const RENDER_PROGRESS_END = RENDER_CEILING - 0.02;

export function useGenerationEvents({ folderPath, onChange, onCompleted, onEstimate }: {
  folderPath: string;
  /** The updater form, always: every write here happens after an await, so the
   *  config this component last saw is not the one to build from. */
  onChange: (update: (current: ProjectConfig) => ProjectConfig) => void;
  /** Called only after the MP4 path, generated asset, and timeline clip state
   *  have all been committed to the in-memory project. The workspace uses this
   *  exact boundary to persist the finished generation without waiting for the
   *  user to click Save. */
  onCompleted?: (jobId: string) => void;
  /** A transient prediction of when rendering (not file encoding) will finish,
   *  based on vidfab's elapsed time and completed steps. It is deliberately
   *  kept out of ProjectConfig: an estimate is live UI telemetry, not project
   *  data worth saving. */
  onEstimate?: (jobId: string, completionAt: number | null) => void;
}) {
  /* Held in refs so the subscription is made ONCE. It has to be: re-subscribing
     on every progress tick would drop events in the gap, and these events are
     the only record that a render happened at all. */
  const write = useRef(onChange);
  write.current = onChange;
  const completed = useRef(onCompleted);
  completed.current = onCompleted;
  const estimate = useRef(onEstimate);
  estimate.current = onEstimate;
  const folder = useRef(folderPath);
  folder.current = folderPath;
  /** Scenes already being encoded, so a repeated event — or a remount in
   *  StrictMode — cannot start a second encode of the same frames. */
  const saving = useRef(new Set<string>());
  const timingEstimator = useRef<GenerationTimingEstimator | null>(null);
  if (timingEstimator.current === null) timingEstimator.current = new GenerationTimingEstimator();

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const updateJob = (jobId: string, updates: Partial<GenerationJob>) => {
      write.current((current) => ({
        ...current,
        generationJobs: current.generationJobs.map((job) => (job.id === jobId ? { ...job, ...updates, updatedAt: new Date().toISOString() } : job)),
      }));
    };
    const updateProgress = (jobId: string, progress: number, stage: GenerationJob["stage"]) => {
      write.current((current) => ({
        ...current,
        generationJobs: current.generationJobs.map((job) => {
          if (job.id !== jobId || job.status === "ready" || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job;
          return {
            ...job,
            status: "generating",
            stage,
            // vidfab stages do not share one counter. A later stage can report
            // a smaller local percentage, but overall progress cannot regress.
            progress: Math.max(job.progress, progress),
            updatedAt: new Date().toISOString(),
          };
        }),
      }));
    };
    const clearEstimate = (jobId: string) => {
      timingEstimator.current?.clear(jobId);
      estimate.current?.(jobId, null);
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
      writeDiagnostic("info", "generation", "encoding.started", "Encoding rendered frames into a project video.", { jobId });
      updateJob(jobId, { status: "ready", stage: "encoding", progress: ENCODE_FLOOR, error: null });
      try {
        const saved = await saveGeneratedScene({
          folderPath: folder.current,
          jobId,
          onProgress: (encoded, total) => {
            if (total > 0) updateJob(jobId, { progress: Math.min(0.99, ENCODE_FLOOR + (encoded / total) * (1 - ENCODE_FLOOR)) });
          },
        });
        const completedAt = new Date().toISOString();
        const assetId = generationAssetId(jobId);
        write.current((current) => ({
          ...current,
          generationJobs: current.generationJobs.map((job) => job.id === jobId ? {
            ...job,
            status: "completed",
            stage: "completed",
            progress: 1,
            outputRelativePath: saved.relativePath,
            // A note means something was left out of the file — the file exists
            // and the scene is finished, so this is not a failure, but it is not
            // silence either.
            error: saved.note,
            updatedAt: completedAt,
          } : job),
          assets: current.assets.map((asset) => asset.id === assetId ? {
            ...asset,
            kind: "generated",
            relativePath: saved.relativePath,
            sourcePath: null,
            mimeType: "video/mp4",
            hasAudio: saved.hasAudio ?? asset.hasAudio ?? null,
          } : asset),
          timeline: {
            tracks: current.timeline.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => clip.assetId === assetId ? { ...clip, status: "generated" } : clip),
            })),
          },
        }));
        writeDiagnostic(saved.note ? "warn" : "info", "generation", "encoding.completed", saved.note ?? "Rendered scene was encoded and written.", {
          jobId, bytes: saved.bytes, relativePath: saved.relativePath, hasAudio: saved.hasAudio ?? null,
        });
        completed.current?.(jobId);
      } catch (reason) {
        /* The render happened and the file did not. Failed is the honest state:
           there is nothing to insert into the timeline, and the only way to get
           this scene is to run it again. */
        const detail = describeDiagnosticError(reason);
        writeDiagnostic("error", "generation", "encoding.failed", detail, { jobId, ...errorContext(reason) });
        updateJob(jobId, {
          status: "failed",
          stage: "failed",
          error: `The scene rendered but could not be saved as a video file. ${detail}`,
        });
      } finally {
        saving.current.delete(jobId);
      }
    };

    const subscriptions = Promise.all([
      listen<ProgressEvent>("vidfab-progress", ({ payload }) => {
        if (disposed) return;
        const progress = payload.totalSteps > 0
          ? Math.min(RENDER_PROGRESS_END, 0.12 + (Math.max(0, payload.step) / payload.totalSteps) * (RENDER_CEILING - 0.14))
          : payload.stage === "delivering" ? RENDER_PROGRESS_END : 0.08;
        estimate.current?.(payload.jobId, timingEstimator.current?.update(payload) ?? null);
        updateProgress(
          payload.jobId,
          progress,
          payload.stage === "starting" || payload.stage === "transformerLoad" ? "preparing" : "generating",
        );
      }),
      listen<JobEvent>("vidfab-job", ({ payload }) => {
        if (disposed) return;
        writeDiagnostic(payload.state === "failed" ? "error" : payload.state === "cancelled" ? "warn" : "info", "generation", "native_event.received", payload.detail || `Generation state changed to ${payload.state}.`, {
          jobId: payload.jobId, state: payload.state,
        });
        if (payload.state === "framesReady") {
          if (payload.output) {
            timingEstimator.current?.record(payload.output);
            writeDiagnostic("info", "generation", "timing.calibrated", "Generation timing calibration was updated.", {
              jobId: payload.jobId,
              secondsConditioning: payload.output.secondsConditioning,
              secondsDenoise: payload.output.secondsDenoise,
              secondsVideoDecode: payload.output.secondsVideoDecode,
              secondsAudioDecode: payload.output.secondsAudioDecode,
              secondsTotal: payload.output.secondsTotal,
              stepsComputed: payload.output.stepsComputed,
              stepsSkipped: payload.output.stepsSkipped,
            });
          }
          clearEstimate(payload.jobId);
          void save(payload.jobId);
          return;
        }
        clearEstimate(payload.jobId);
        updateJob(payload.jobId, payload.state === "failed"
          ? { status: "failed", stage: "failed", error: payload.detail }
          : payload.state === "cancelled"
            ? { status: "cancelled", stage: "failed", error: payload.detail }
            : { status: "queued", stage: "queued" });
      }),
    ]);
    void subscriptions.catch((reason) => {
      writeDiagnostic("error", "generation", "event_subscription.failed", describeDiagnosticError(reason), errorContext(reason));
    });
    return () => {
      disposed = true;
      void subscriptions.then((unlisten) => unlisten.forEach((stop) => stop()));
    };
  }, []);
}
