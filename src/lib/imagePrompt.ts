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
  // An inpainting source is also an explicit composition anchor. The caller
  // submits it before the selected reference pictures, even with no subjects.
  const editing = scene.rootType === "image" && Boolean(scene.sourceImage);
  let picture = editing ? 1 : 0;
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
  if (!subjects.length && !editing) return {
    prompt: [`integrated_multimodal_description: [Shot 1] ${visual.style}\n${visual.composition}`, ...audio].join("\n\n"), references,
  };
  const label = (index: number) => `<Subject ${index + 1}>`;
  const definitions = subjects.map((subject, index) => `${label(index)} is ${subject.name}, providing ${subject.role}${subject.source}. ${subject.description}`);
  const retention = subjects.map((subject, index) => `${label(index)} (appears in [Shot 1]): fully_preserved - retain the referenced ${subject.role} of ${subject.name} while following the requested composition and styling.`);
  if (editing) {
    definitions.unshift("<Picture 1> is the original source image and composition anchor for the edited still keyframe in [Shot 1], providing the framing, perspective, environment, lighting and visual style.");
    retention.unshift("<Picture 1> ([Shot 1] edited keyframe): partially_preserved - retain its composition and visual characteristics while changing the requested region. Preserve all pixels outside the edit box, including any previously completed edits.");
  }
  const summary = editing
    ? `[keyframe completion${subjects.length ? " + reference generation" : ""}] The target is a single edited still keyframe based on <Picture 1>. Apply the described change only inside the edit box.${subjects.length ? ` Use ${subjects.map((_, index) => label(index)).join(", ")} for the specified reference attributes.` : ""}`
    : `[reference generation] A single still image uses ${subjects.map((_, index) => label(index)).join(", ")} in the requested composition.`;
  const style = editing ? "The still image retains the visual medium, lighting, palette and perspective of <Picture 1>." : visual.style;
  return { prompt: [
    `subject_definitions:\n${definitions.join("\n")}`,
    `summary:\n${summary}`,
    `retention_analysis:\n${retention.join("\n")}`,
    `detailed_description:\n${style}\n[Shot 1] ${visual.composition}\n${subjects.map((subject, index) => `Use ${label(index)} for ${subject.name}'s ${subject.role}${subject.source}. ${subject.description}`).join("\n")}`,
    ...audio,
  ].join("\n\n"), references };
}
