import { generationDimensions } from "./export";
import {
  audioReferenceBlocker, characterReplaceBlocker, poseBlocker, isVideoTransition, videoTransitionBlocker,
  usableAudioReferences, usableVideoReferences, referenceRefmodInputs, compileGenerationJobPrompt,
  danglingReferenceTokens, GENERATION_FRAME_RATE, sceneDurationSeconds, sceneFrameInputs,
  sceneGenerationReferences, sceneGenerationSeed, sceneGenerationSteps, sceneShots, projectItemPath,
  usableReferenceImages, type GenerationJob, type ProjectConfig, type ProjectReference, type SceneType,
} from "./project";
import type { SlopfabGenerationRequest } from "./runtime";
import type { GeneratorTemplate } from "./settings";

export function sceneGenerationRequest(job: GenerationJob, config: ProjectConfig, folderPath: string, defaultGenerationSteps: number): SlopfabGenerationRequest {
  // Only the references actually bound to this scene, in list order. The same
  // ordered list drives the <Subject N> / <Picture N> numbering inside the
  // compiled prompt, because slopfab.rs adds reference_paths sequentially — so
  // array index 0 must be the asset the prompt calls <Picture 1>.
  const inputs = sceneFrameInputs(job, config);
  const bound = inputs.references;
  const canvas = generationDimensions(config.settings.resolution, config.settings.aspectRatio);
  return {
    jobId: job.id,
    ...(job.sceneType === "extend" || job.sceneType === "bridge" ? { videoTransition: job.sceneType } : {}),
    // Recompiled from current state so edits to a bound reference or a
    // retimed shot reach the engine, rather than sending a prompt frozen at
    // draft-creation time. This is the ONE string slopfab is given, and it is
    // the same string the compiled-prompt panel shows.
    prompt: (job.sceneType ?? "first-last-frame") === "animate" ? "" : compileGenerationJobPrompt(inputs.job, bound, config.settings.defaultLook),
    ...(inputs.previousSceneId ? { previousSceneId: inputs.previousSceneId } : {}),
    ...(inputs.continuationRelativePath ? { continuationRelativePath: inputs.continuationRelativePath } : {}),
    ...(inputs.previousSceneId ? { continuationOverlapFrames: inputs.continuationOverlapFrames,
      continuationLockOverlap: inputs.continuationLockOverlap,
      continuationFrom: inputs.continuationFrom, continuationSourceFrames: inputs.continuationSourceFrames } : {}),
    // The scene's own length, not a fixed six seconds.
    frames: Math.round(sceneDurationSeconds(job) * GENERATION_FRAME_RATE),
    steps: sceneGenerationSteps(job, defaultGenerationSteps),
    ...(job.audioSteps != null ? { audioSteps: job.audioSteps } : {}),
    ...(job.latentUpscale ? { latentUpscale: true } : {}),
    seed: sceneGenerationSeed(job),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    referencePaths: usableReferenceImages(bound)
      .map((image) => projectItemPath(folderPath, image) ?? "")
      .filter((path) => path.length > 0),
    refmods: referenceRefmodInputs(folderPath, bound),
    referenceVideos: usableVideoReferences(bound).map((reference) => ({
      name: reference.name, relativePath: reference.relativePath, sourcePath: reference.sourcePath,
      startSeconds: reference.video?.startSeconds ?? 0,
      durationSeconds: reference.video?.durationSeconds ?? 2,
      includeAudio: isVideoTransition(job) ? false : reference.video?.includeAudio ?? true,
    })),
    referenceAudios: usableAudioReferences(bound).map((reference) => ({
      name: reference.name, relativePath: reference.relativePath, sourcePath: reference.sourcePath,
      startSeconds: reference.audio?.startSeconds ?? 0,
      durationSeconds: reference.audio?.durationSeconds ?? 15,
    })),
  };
}

/** Validate the inputs required by the selected generator before submission. */
export function sendBlocker(job: GenerationJob, references: ProjectReference[]): string | null {
  const shots = sceneShots(job);
  const animate = job.sceneType === "animate";
  const characterReplace = job.sceneType === "character-replace";
  if (job.sceneType === "pose") {
    const blocker = poseBlocker(job, references);
    if (blocker) return blocker;
  }
  if (isVideoTransition(job)) {
    const blocker = videoTransitionBlocker(job, references);
    if (blocker) return blocker;
  }
  if (characterReplace) {
    const blocker = characterReplaceBlocker(job, references);
    if (blocker) return blocker;
  }
  if (animate) {
    const bound = sceneGenerationReferences(job, references);
    if (usableVideoReferences(bound).length !== 1) return "Choose one reference video.";
    if (usableReferenceImages(bound).length !== 1) return "Choose one repainted frame.";
    if (job.usePreviousSceneLastFrame || bound.some((reference) => reference.refmods?.some((refmod) => refmod.strength > 0))) {
      return "Animate can’t continue a scene or use refmods.";
    }
    if (usableAudioReferences(bound).length) return "Animate can’t use sound references.";
  } else {
    const blocker = audioReferenceBlocker(job, sceneGenerationReferences(job, references));
    if (blocker) return blocker;
  }
  if (!animate && !characterReplace && shots.every((shot) => shot.action.trim().length === 0 && !(shot.speech ?? "").trim())) {
    return "Write a description or speech in at least one shot.";
  }
  if (sceneDurationSeconds(job) <= 0) {
    return "Give the scene a length.";
  }
  const dangling = danglingReferenceTokens(shots, references);
  if (!animate && !characterReplace && dangling.length > 0) {
    return "A reference in a shot can’t be used. Replace it or remove it from the line.";
  }
  return null;
}

export function templateSceneBlocker(type: SceneType, template: GeneratorTemplate): string | null {
  if (type === "animate" && template.mode !== "animate") return "Select an Animate generator for this scene.";
  if (type !== "animate" && template.mode === "animate") return "Select a MiniMax prompt generator for this scene.";
  if ((type === "pose" || type === "character-replace" || type === "extend" || type === "bridge") && /fl2v/i.test(template.paths.transformer)) return `Select a References or Singularity generator for ${type === "pose" ? "Pose" : type === "character-replace" ? "Character Replace" : type === "extend" ? "Extend" : "Bridge"}.`;
  return null;
}

