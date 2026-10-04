import { activeReferenceRefmods, isAudioReference, isReferenceDescribed, isVideoReference, referenceImages, type ProjectReference } from "./project";

export type ReferenceMediaType = "image" | "audio" | "video" | "text" | "refmod";

/** Match payloads, not just the reference's kind: text references can carry
 * images, and videos in Frames mode supply stills instead of a video clip. */
export function referenceMediaTypes(reference: ProjectReference): ReferenceMediaType[] {
  const types: ReferenceMediaType[] = [];
  if (referenceImages(reference).length) types.push("image");
  if (isAudioReference(reference)) types.push("audio");
  if (isVideoReference(reference) && (reference.relativePath || reference.sourcePath)) types.push("video");
  if (isReferenceDescribed(reference)) types.push("text");
  if (activeReferenceRefmods(reference).length) types.push("refmod");
  return types;
}

/** Any accepted payload is sufficient; an omitted filter offers everything. */
export function filterReferenceOptions<T extends { mediaTypes?: readonly ReferenceMediaType[] }>(references: readonly T[], accept?: readonly ReferenceMediaType[]): T[] {
  return references.filter((reference) => !accept || reference.mediaTypes?.some((type) => accept.includes(type)));
}

export function selectReferences(references: readonly ProjectReference[], accept: readonly ReferenceMediaType[]): ProjectReference[] {
  return references.filter((reference) => referenceMediaTypes(reference).some((type) => accept.includes(type)));
}
