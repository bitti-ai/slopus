import { activeGenerationEffects } from "./generationEffects";
import { generationDimensions } from "./export";
import { longShotContinuationInputs, longShotInputs } from "./longShot";
import {
  audioReferenceBlocker, characterReplaceBlocker, poseBlocker, isVideoTransition, videoTransitionBlocker,
  usableAudioReferences, usableVideoReferences, referenceRefmodInputs, compileGenerationJobPrompt,
  danglingReferenceTokens, GENERATION_FRAME_RATE, sceneDurationSeconds, sceneFrameInputs,
  sceneGenerationReferences, sceneGenerationSeed, sceneGenerationSteps, sceneShots, projectItemPath,
  usableReferenceImages, compileScenePromptSegments, type GenerationJob, type ProjectConfig, type ProjectReference, type SceneType,
} from "./project";
import type { SlopfabGenerationRequest } from "./runtime";
import { videoGuidedScene } from "./videoLibrary";
import { generationSigmaShifts, templateSupportsVideo, type GeneratorTemplate } from "./settings";

export function sceneGenerationRequest(job: GenerationJob, config: ProjectConfig, folderPath: string, defaultGenerationSteps: number, template?: GeneratorTemplate): SlopfabGenerationRequest {
  const guided = videoGuidedScene(job, config);
  job = guided.job; config = guided.config;
  // Only the references actually bound to this scene, in list order. The same
  // ordered list drives the <Subject N> / <Picture N> numbering inside the
  // compiled prompt, because slopfab.rs adds reference_paths sequentially — so
  // array index 0 must be the asset the prompt calls <Picture 1>.
  const inputs = { ...sceneFrameInputs(job, config), ...longShotContinuationInputs(job, config)?.request };
  const bound = inputs.references;
  const canvas = generationDimensions(config.settings.resolution, config.settings.aspectRatio);
  const longShot = longShotInputs(job, config);
  return {
    jobId: job.id,
    ...(job.sceneType === "single-shot" ? { singleShot: { endingPrompt: job.endingPrompt?.trim()
      ? compileScenePromptSegments({ shots: [{ id: `${job.id}-ending`, startSeconds: 0, action: job.endingPrompt }], soundscape: job.soundscape, music: job.music }, bound, config.settings.defaultLook).map((segment) => segment.value).join("")
      : compileGenerationJobPrompt(inputs.job, bound, config.settings.defaultLook) } } : {}),
    ...(longShot ? { latentBridge: longShot.bridge } : {}),
    ...(job.sceneType === "extend" || job.sceneType === "bridge" ? { videoTransition: job.sceneType } : {}),
    // Recompiled from current state so edits to a bound reference or a
    // retimed shot reach the engine, rather than sending a prompt frozen at
    // draft-creation time. This is the main prompt shown in the compiled-prompt
    // panel; Single Shot captures its separate ending prompt above.
    prompt: job.sceneType === "animate" ? "" : compileGenerationJobPrompt(inputs.job, bound, config.settings.defaultLook),
    ...(inputs.previousSceneId ? { previousSceneId: inputs.previousSceneId } : {}),
    ...(inputs.continuationRelativePath ? { continuationRelativePath: inputs.continuationRelativePath } : {}),
    ...(inputs.previousSceneId ? { continuationOverlapFrames: inputs.continuationOverlapFrames,
      continuationLockOverlap: inputs.continuationLockOverlap,
      ...(inputs.continuationSourceNoise != null ? { continuationSourceNoise: inputs.continuationSourceNoise } : {}),
      continuationFrom: inputs.continuationFrom, continuationSourceFrames: inputs.continuationSourceFrames } : {}),
    // The scene's own length, not a fixed six seconds.
    frames: Math.round(sceneDurationSeconds(job) * GENERATION_FRAME_RATE),
    steps: sceneGenerationSteps(job, defaultGenerationSteps),
    ...generationSigmaShifts(job, template),
    generationEffects: activeGenerationEffects(job.generationEffects),
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
export function sendBlocker(job: GenerationJob, references: ProjectReference[], config?: ProjectConfig): string | null {
  if (config) {
    const guided = videoGuidedScene(job, config);
    return guided.blocker ?? sendBlocker(guided.job, guided.config.references);
  }
  const shots = sceneShots(job);
  if (job.sceneType === "single-shot") {
    if (sceneDurationSeconds(job) < 2) return "Single Shot needs at least 2 seconds.";
    if (danglingReferenceTokens([{ id: "ending", startSeconds: 0, action: job.endingPrompt ?? "" }], references).length)
      return "A reference in the ending prompt can't be used. Replace it or remove it.";
  }
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
  if (!templateSupportsVideo(template)) return "This model supports image generation only. Select a video generator.";
  if (type === "animate" && template.mode !== "animate") return "Select an Animate generator for this scene.";
  if (type !== "animate" && template.mode === "animate") return "Select a MiniMax prompt generator for this scene.";
  if ((type === "pose" || type === "character-replace" || type === "extend" || type === "bridge") && /fl2v/i.test(template.paths.transformer)) return `Select a References or Singularity generator for ${type === "pose" ? "Pose" : type === "character-replace" ? "Character Replace" : type === "extend" ? "Extend" : "Bridge"}.`;
  return null;
}

