import { invoke } from "@tauri-apps/api/core";
import { loadLoras, saveLoras, type Lora } from "./loras";
import { loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, type GeneratorTemplate, type GeneratorTemplateSettings } from "./settings";

export interface GeneratorContext { settings: GeneratorTemplateSettings; loras: Lora[] }
export type GeneratorPatch = Partial<Pick<GeneratorTemplate, "name" | "modelType" | "editingModel" | "defaultSteps" | "attention" | "mode" | "motionCache" | "loras">>
  & { paths?: Partial<GeneratorTemplate["paths"]> };
export type GeneratorCommand =
  | { op: "generator.add" | "generator.set"; id: string; settings: GeneratorPatch; makeDefault?: boolean }
  | { op: "generator.lora.add"; id: string; name: string; path: string; stepOverride?: number };

export function generatorContext(): GeneratorContext {
  return { settings: loadGeneratorTemplateSettings(), loras: loadLoras() };
}

/** Validate before persisting. Rebase if downloads or settings changed during IPC. */
export async function executeGeneratorCommands(commands: GeneratorCommand[]): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const context = generatorContext();
    const next = await invoke<GeneratorContext>("prepare_generator_commands", { context, commands });
    if (JSON.stringify(generatorContext()) !== JSON.stringify(context)) continue;
    // Legacy path commands remain supported after H3 dependencies moved to shared templates.
    for (const command of commands) {
      if (command.op !== "generator.add" && command.op !== "generator.set") continue;
      const template = next.settings.templates.find((entry) => entry.id === command.id);
      const paths = command.settings.paths;
      if (template?.modelType !== "minimax-h3" || !paths) continue;
      if (paths.videoVae !== undefined) delete template.videoVaeId;
      if (paths.audioVae !== undefined) delete template.audioVaeId;
      const library = next.settings.h3Components;
      if (library && (paths.textEncoder !== undefined || paths.tokenizer !== undefined)) {
        const encoder = library.templates.find((entry) => entry.id === library.defaultTextEncoderId);
        if (encoder) {
          if (paths.textEncoder !== undefined) {
            encoder.path = paths.textEncoder;
            encoder.sources = /^https?:\/\//i.test(encoder.path) ? [{ url: encoder.path, gpuModel: "", minVramGb: 0 }] : [];
          }
          if (paths.tokenizer !== undefined) {
            encoder.tokenizer = paths.tokenizer;
            encoder.tokenizerUrl = /^https?:\/\//i.test(paths.tokenizer) ? paths.tokenizer : undefined;
          }
        }
      }
    }
    const lorasChanged = JSON.stringify(next.loras) !== JSON.stringify(context.loras);
    if (lorasChanged) saveLoras(next.loras);
    try { saveGeneratorTemplateSettings(next.settings, { strict: true }); }
    catch (error) {
      if (lorasChanged) saveLoras(context.loras);
      throw error;
    }
    return;
  }
  throw new Error("Generator settings kept changing while the agent applied its edits. Please try again.");
}
