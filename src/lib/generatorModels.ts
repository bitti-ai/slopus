import models from "./generatorModels.json";

export type GeneratorModel = typeof models["minimax-h3"];
// Shared with native request validation; edit the JSON to enable capabilities.
export const GENERATOR_MODELS = Object.entries(models).map(([value, model]) => ({ value, ...model }));
export function generatorModel(modelType?: string): GeneratorModel {
  return models[modelType as keyof typeof models] ?? models["minimax-h3"];
}
