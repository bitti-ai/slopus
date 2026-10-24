import models from "./generatorModels.json";

export type GeneratorModel = (typeof models)[keyof typeof models];
// Shared with native request validation; edit the JSON to enable capabilities.
export const GENERATOR_MODELS = Object.entries(models).map(([value, model]) => ({ value, ...model }));
export function generatorModel(modelType?: string): GeneratorModel {
  return models[modelType as keyof typeof models] ?? models["minimax-h3"];
}

/** Keep authored CFG values per model; unsupported models never submit one. */
export function imageCfgScale(modelType: string, scales?: Record<string, number>): number | undefined {
  const cfg = generatorModel(modelType).cfg;
  return cfg ? scales?.[modelType] ?? cfg.default : undefined;
}
