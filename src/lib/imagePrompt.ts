import { createImageScene, imageScenePrompt } from "./imageScene";
import { referenceDefinition, referenceImages, type ProjectConfig } from "./project";
import { SHOT_TAG_GROUPS } from "./shot-tags";

/** Shared by the generation request and its debug preview. */
export function compileImagePrompt(config: ProjectConfig) {
  const scene = config.imageScene ?? createImageScene(config.brief.prompt);
  const references = scene.referenceIds.map((id) => {
    const reference = config.references.find((candidate) => candidate.id === id);
    if (!reference) throw new Error(`Selected image reference '${id}' no longer exists.`);
    if (reference.kind === "video" || reference.kind === "audio") throw new Error("Still images accept image and text references.");
    return reference;
  });
  let picture = 0;
  const referencePrompts = references.map((reference) => {
    const labels = referenceImages(reference).map(() => `<Picture ${++picture}>`);
    const definition = referenceDefinition(reference);
    const content = definition || reference.name;
    const description = /[.!?。！？]$/.test(content) ? content : `${content}.`;
    return labels.length
      ? `Use ${labels.join(", ")} as visual guidance for ${reference.name}. ${description}`
      : `Additional visual guidance: ${description}`;
  });
  if (picture > 9) throw new Error("MiniMax H3 supports at most nine reference images per generation.");
  const look = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")?.options.find((option) => option.id === config.settings.defaultLook)?.label;
  return {
    prompt: [imageScenePrompt(scene, look), ...(referencePrompts.length ? [`Visual references for this still image:\n${referencePrompts.join("\n")}`] : [])].filter(Boolean).join("\n\n"),
    references,
  };
}
