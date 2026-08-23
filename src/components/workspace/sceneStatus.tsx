import { AlertCircle, Ban, Check, Clock3, LoaderCircle, RefreshCw } from "lucide-react";
import { sceneDurationSeconds, sceneShots, type GenerationJob } from "../../lib/project";

/* What a scene's status is CALLED, in one place.
 *
 * The board, the scene line and the inspector all say where a scene is, and
 * three copies of the same switch is how two of them end up disagreeing — a
 * card reading "cancelled" beside a badge still reading "in queue" is exactly
 * the bug this file exists to make impossible. */

export type JobStatus = GenerationJob["status"];
export type SceneIndicatorStatus = JobStatus | "changed";

export const STATUS_BADGE: Record<SceneIndicatorStatus, string> = {
  draft: "DRAFT",
  queued: "IN QUEUE",
  generating: "RENDERING",
  ready: "SAVING",
  completed: "FINISHED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  changed: "CHANGED",
};

export const STATUS_WORD: Record<JobStatus, string> = {
  draft: "Saved as a draft",
  queued: "Waiting to render",
  generating: "Rendering now",
  ready: "Saving the video file",
  completed: "Finished",
  failed: "Stopped by an error",
  cancelled: "Stopped by you",
};

/* Encoding turns the same spinner as rendering: it is the app working, not the
   app waiting, and a tick beside "saving" would say it was already done. */
export const statusIcon = (status: SceneIndicatorStatus, size = 16) =>
  status === "generating" || status === "ready" ? <LoaderCircle size={size} />
    : status === "completed" ? <Check size={size} />
      : status === "failed" ? <AlertCircle size={size} />
        : status === "cancelled" ? <Ban size={size} />
          : status === "changed" ? <RefreshCw size={size} />
          : <Clock3 size={size} />;

/** The shape of a scene — how long it runs and how many shots it is cut into. */
export const sceneShape = (job: GenerationJob) => {
  const shots = sceneShots(job).length;
  return `${sceneDurationSeconds(job).toFixed(1)}s · ${shots === 1 ? "1 shot" : `${shots} shots`}`;
};

/** One line about where a scene is, for the line that separates it from the
 *  next one. */
export const sceneLine = (job: GenerationJob) => {
  switch (job.status) {
    case "generating": return `Rendering · ${Math.round(job.progress * 100)}% · ${sceneShape(job)}`;
    case "queued": return `Waiting its turn · ${sceneShape(job)}`;
    case "draft": return `Draft — ${sceneShape(job)}`;
    case "ready": return `Saving the video file · ${Math.round(job.progress * 100)}%`;
    case "completed": return job.outputRelativePath ? `Ready to use · ${sceneShape(job)}` : "Finished with no file";
    case "failed": return "Didn’t finish";
    case "cancelled": return "Cancelled";
  }
};

export const progressTitle = (job: GenerationJob) => {
  switch (job.status) {
    case "generating": return `${Math.round(job.progress * 100)}% rendered`;
    case "queued": return "Waiting to start";
    case "draft": return "Draft saved";
    case "ready": return "Saving the video file";
    case "completed": return job.outputRelativePath ? "Ready for your edit" : "Finished with no file";
    case "failed": return "Didn’t finish";
    case "cancelled": return "Generation stopped";
  }
};

export const stageCopy = (job: GenerationJob) => {
  switch (job.status) {
    case "generating": return "The video engine is building the motion and the sound.";
    case "queued": return "Waiting for the scene ahead of it to finish.";
    case "draft": return "Saved with your project. Nothing has been rendered yet.";
    case "ready": return "The pictures are rendered. They are being encoded into a video file in your project folder.";
    case "completed": return job.outputRelativePath ? "Saved in your project and ready to drop into the timeline." : "This run ended without saving a video file.";
    case "failed": return "The run stopped before it finished. You can try it again.";
    case "cancelled": return "You stopped this one. You can run it again.";
  }
};
