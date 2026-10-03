import { invoke } from "@tauri-apps/api/core";
import { isAudioReference, isVideoReference, projectItemPath, referenceImages, type ProjectConfig, type ProjectReference } from "./project";
import type { SlopfabGenerationRequest } from "./runtime";

export interface RefmodExportTarget { outputPath: string; name: string; description: string }

const MAX_REFMOD_IMAGES = 9;
const hasFile = (reference: ProjectReference) => Boolean(reference.sourcePath || reference.relativePath);

/** Why a reference cannot be exported as a refmod, or null when it can. */
export function refmodExportBlocker(reference: ProjectReference): string | null {
  if (reference.refmods?.length) return "This reference already uses refmods.";
  const images = referenceImages(reference).length;
  if (images > MAX_REFMOD_IMAGES) return "Refmod export supports up to nine images.";
  if (!images && !(isVideoReference(reference) && hasFile(reference)) && !isAudioReference(reference)) {
    return "Add an image, video or sound to export a refmod.";
  }
  return null;
}

/** The reference's own media in SlopFab's order: images, then its clip or sound. */
export function refmodExportRequest(folderPath: string, reference: ProjectReference, jobId: string): SlopfabGenerationRequest {
  const file = { name: reference.name, relativePath: reference.relativePath, sourcePath: reference.sourcePath };
  return {
    jobId, prompt: "", frames: 0, steps: 0, seed: 0, canvasWidth: 0, canvasHeight: 0,
    referencePaths: referenceImages(reference).map((image) => projectItemPath(folderPath, image)!),
    ...(isVideoReference(reference) && hasFile(reference) ? { referenceVideos: [{
      ...file, startSeconds: reference.video?.startSeconds ?? 0, durationSeconds: reference.video?.durationSeconds ?? 2, includeAudio: reference.video?.includeAudio ?? true,
    }] } : {}),
    ...(isAudioReference(reference) ? { referenceAudios: [{
      ...file, startSeconds: reference.audio?.startSeconds ?? 0, durationSeconds: reference.audio?.durationSeconds ?? 15,
    }] } : {}),
  };
}

/** Asks where to save the refmod. Null when the user cancels. */
export const chooseRefmodExportPath = (name: string) => invoke<string | null>("choose_refmod_export_path", { name });

export const exportReferenceRefmod = (request: SlopfabGenerationRequest, config: ProjectConfig, target: RefmodExportTarget) =>
  invoke<void>("export_reference_refmod", { request, config, ...target });
