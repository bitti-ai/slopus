import { createImageScene, imageScenePromptParts } from "./imageScene";
import { activeReferenceRefmods, referenceDefinition, referenceImages, type ProjectConfig } from "./project";
import { SHOT_TAG_GROUPS } from "./shot-tags";

/** Shared by generation and Debug Prompt. H3's base three-field / reference
 * six-section contracts still apply to a single silent image. */
export function compileImagePrompt(config: ProjectConfig) {
  const scene = config.imageScene ?? createImageScene(config.brief.prompt);
  const references = scene.referenceIds.map((id) => {
    const reference = config.references.find((candidate) => candidate.id === id);
    if (!reference) throw new Error(`Selected image reference '${id}' no longer exists.`);
    if (reference.kind === "video" || reference.kind === "audio") throw new Error("Still images accept image and text references.");
    return reference;
  });
  let picture = 0;
  const subjects = references.flatMap((reference) => {
    const labels = referenceImages(reference).map(() => `<Picture ${++picture}>`);
    const definition = referenceDefinition(reference);
    const refmods = activeReferenceRefmods(reference);
    if (reference.refmods?.length && !refmods.length && !labels.length && !definition) return [];
    const content = definition || reference.name;
    const description = /[.!?。！？]$/.test(content) ? content : `${content}.`;
    const role = reference.intendedUse.includes("character") || reference.intendedUse.includes("animal") ? "identity and appearance" : reference.intendedUse.includes("style") ? "visual style" : "appearance";
    const sources = [...labels, ...(refmods.length ? ["the supplied reference conditioning"] : [])];
    return [{ name: reference.name, role, description, source: sources.length ? ` from ${sources.join(" and ")}` : "" }];
  });
  if (picture > 9) throw new Error("MiniMax H3 supports at most nine reference images per generation.");
  const look = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")?.options.find((option) => option.id === config.settings.defaultLook)?.label;
  const visual = imageScenePromptParts(scene, look);
  if (!visual) return { prompt: "", references };
  const audio = ["overall_soundscape: N/A", "non_diegetic_music: N/A"];
  if (!subjects.length) return {
    prompt: [`integrated_multimodal_description: [Shot 1] ${visual.style}\n${visual.composition}`, ...audio].join("\n\n"), references,
  };
  const label = (index: number) => `<Subject ${index + 1}>`;
  return { prompt: [
    `subject_definitions:\n${subjects.map((subject, index) => `${label(index)} is ${subject.name}, providing ${subject.role}${subject.source}. ${subject.description}`).join("\n")}`,
    `summary:\n[reference generation] A single still image uses ${subjects.map((_, index) => label(index)).join(", ")} in the requested composition.`,
    `retention_analysis:\n${subjects.map((subject, index) => `${label(index)} (appears in [Shot 1]): fully_preserved - retain the referenced ${subject.role} of ${subject.name} while following the requested composition and styling.`).join("\n")}`,
    `detailed_description:\n${visual.style}\n[Shot 1] ${visual.composition}\n${subjects.map((subject, index) => `Use ${label(index)} for ${subject.name}'s ${subject.role}${subject.source}. ${subject.description}`).join("\n")}`,
    ...audio,
  ].join("\n\n"), references };
}
