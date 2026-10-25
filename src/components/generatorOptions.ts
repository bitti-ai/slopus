import { GENERATOR_MODELS } from "../lib/generatorModels";
import type { GeneratorTemplate } from "../lib/settings";
import type { ComboGroup, ComboOption } from "./ui/ComboBox";

/** Group already-filtered choices so each picker keeps its compatibility rules. */
export function generatorOptions(templates: readonly GeneratorTemplate[], details: (template: GeneratorTemplate) => Partial<ComboOption> = () => ({})): ComboGroup[] {
  const groups = new Map<string, ComboOption[]>();
  for (const template of templates) {
    const options = groups.get(template.modelType) ?? [];
    options.push({ ...details(template), value: template.id, label: template.name });
    groups.set(template.modelType, options);
  }
  const order = [...new Set([...GENERATOR_MODELS.map(model => model.value), ...groups.keys()])];
  return order.flatMap(model => {
    const options = groups.get(model);
    return options ? [{ label: GENERATOR_MODELS.find(item => item.value === model)?.label ?? model, options }] : [];
  });
}
