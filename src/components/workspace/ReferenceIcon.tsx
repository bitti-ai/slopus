import type { ReactNode } from "react";
import { referenceImages, type ProjectReference } from "../../lib/project";
import { hasPresetIcon, selectedReferencePreset } from "../../lib/reference-presets";
import { PresetIcon } from "./PresetIcon";
import { ReferenceImage } from "./ReferenceImage";

/** The art that stands for a still reference, in the References library's
 *  order: a refmod's generated icon, its first picture, a generated icon,
 *  its preset's icon — or `fallback` (a glyph) when it has none. */
export function ReferenceIcon({ reference, folderPath, fallback = null }: { reference: ProjectReference; folderPath: string; fallback?: ReactNode }) {
  const cover = referenceImages(reference)[0];
  const preset = selectedReferencePreset(reference);
  const icon = reference.refmods?.length && reference.iconRelativePath
    ? <ReferenceImage folderPath={folderPath} relativePath={reference.iconRelativePath} alt="" />
    : cover ? <ReferenceImage folderPath={folderPath} relativePath={cover.relativePath} sourcePath={cover.sourcePath} alt="" />
    : reference.iconRelativePath ? <ReferenceImage folderPath={folderPath} relativePath={reference.iconRelativePath} alt="" />
    : hasPresetIcon(preset) ? <PresetIcon preset={preset!} />
    : null;
  return icon ?? fallback;
}
