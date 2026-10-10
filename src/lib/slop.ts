import { z } from "zod";
import { MAX_GENERATION_STEPS } from "./project";
import { loadLoras, MAX_LORA_STRENGTH, saveLoras, type Lora } from "./loras";
import {
  createGeneratorTemplate, EMPTY_ENGINE_SETTINGS, ENGINE_PATH_FIELDS, generatorPathFields,
  isDownloadUrl, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings,
  type GeneratorTemplate, type GeneratorTemplateSettings,
} from "./settings";

export const MAX_SLOP_BYTES = 4 * 1024 * 1024;
const name = z.string().trim().min(1).max(256);
const url = z.string().trim().max(8192).url().refine((value) => {
  try { const parsed = new URL(value); return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password; }
  catch { return false; }
}, "Use an HTTP or HTTPS download URL without embedded credentials.");
const steps = z.number().int().min(2).max(MAX_GENERATION_STEPS);
const sourceSchema = z.object({ url, gpuModel: z.string().max(256).default(""), minVramGb: z.number().finite().min(0).max(1048576).default(0) }).strict();
const sourcesSchema = z.object({
  transformer: z.array(sourceSchema).min(1).max(64).optional(),
  textEncoder: z.array(sourceSchema).min(1).max(64).optional(),
  tokenizer: z.array(sourceSchema).min(1).max(64).optional(),
  videoVae: z.array(sourceSchema).min(1).max(64).optional(),
  audioVae: z.array(sourceSchema).min(1).max(64).optional(),
}).strict();
const portableLoraSchema = z.object({
  name, url, enabled: z.boolean(), strength: z.number().finite().min(-MAX_LORA_STRENGTH).max(MAX_LORA_STRENGTH),
  stepOverride: steps.optional(), samplingPreset: z.literal("dmad-4step").optional(),
}).strict();
export const portableGeneratorSchema = z.object({
  name, modelType: name, defaultSteps: steps, attention: z.enum(["exact", "flash2", "sage2", "sol"]),
  mode: z.enum(["prompt", "animate"]).default("prompt"), motionCache: z.boolean().default(false),
  sources: sourcesSchema,
  loras: z.array(portableLoraSchema).max(128).default([]),
  additionalSafetensors: z.array(z.object({ name, url, role: z.literal("promptEmbedding").optional() }).strict()).max(128).default([]),
}).strict().superRefine((template, context) => {
  for (const field of generatorPathFields(template)) {
    if (field.required && !template.sources[field.id]?.length) context.addIssue({ code: "custom", path: ["sources", field.id], message: `Add a download URL for ${field.label}.` });
  }
  if (template.mode === "animate" && !template.additionalSafetensors.some((file) => file.role === "promptEmbedding")) {
    context.addIssue({ code: "custom", path: ["additionalSafetensors"], message: "Animate templates need a prompt embedding download URL." });
  }
});
export type PortableGenerator = z.infer<typeof portableGeneratorSchema>;

/** Each entry has its own type and version; future payloads do not require
 * changing the envelope or pretending to be generator settings. */
const envelopeSchema = z.object({
  format: z.literal("slop"), version: z.literal(1),
  items: z.array(z.object({ type: name, version: z.number().int().positive(), data: z.unknown() }).strict()).min(1).max(100),
}).strict();
export interface GeneratorSlop {
  format: "slop"; version: 1;
  items: { type: "generator-template"; version: 1; data: PortableGenerator }[];
}

function validatedGenerator(value: unknown, label: string): PortableGenerator {
  const result = portableGeneratorSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${label}: ${issue.code === "custom" ? "" : `${issue.path.join(".") || "template"}: `}${issue.message}`);
  }
  return result.data;
}

/** Explicit projection is deliberate: machine paths, IDs, API settings and
 * download/preparation state are never serialized into a shared template. */
export function portableGenerator(template: GeneratorTemplate, library = loadLoras()): PortableGenerator {
  const sources: PortableGenerator["sources"] = {};
  for (const field of ENGINE_PATH_FIELDS) {
    const entries = (template.sources?.[field.id] ?? []).map((source) => ({ url: source.url, gpuModel: source.gpuModel, minVramGb: source.minVramGb }));
    const path = template.paths[field.id].trim();
    if (isDownloadUrl(path) && !entries.some((source) => source.url === path)) entries.unshift({ url: path, gpuModel: "", minVramGb: 0 });
    if (path && !isDownloadUrl(path) && !entries.length) throw new Error(`${template.name}: add a download URL for ${field.label} before sharing.`);
    if (entries.length) sources[field.id] = entries;
  }
  const loras = (template.loras ?? []).map((selection) => {
    const lora = library.find(({ id }) => id === selection.loraId);
    if (!lora?.url) throw new Error(`${template.name}: add a download URL for LoRA ${lora?.name ?? selection.loraId} before sharing.`);
    return { name: lora.name, url: lora.url, enabled: selection.enabled, strength: selection.strength,
      ...(lora.stepOverride !== undefined ? { stepOverride: lora.stepOverride } : {}),
      ...(lora.samplingPreset ? { samplingPreset: lora.samplingPreset } : {}) };
  });
  return validatedGenerator({
    name: template.name, modelType: template.modelType, defaultSteps: template.defaultSteps, attention: template.attention,
    mode: template.mode ?? "prompt", motionCache: template.motionCache ?? false, sources, loras,
    additionalSafetensors: (template.additionalSafetensors ?? []).map((file) => ({ name: file.name, url: file.url, ...(file.role ? { role: file.role } : {}) })),
  }, template.name);
}

export function serializeGeneratorSlop(templates: GeneratorTemplate[], library = loadLoras()): string {
  if (!templates.length || templates.length > 100) throw new Error("Choose between 1 and 100 generator templates to export.");
  const document: GeneratorSlop = { format: "slop", version: 1, items: templates.map((template) => ({ type: "generator-template", version: 1, data: portableGenerator(template, library) })) };
  const text = JSON.stringify(document, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > MAX_SLOP_BYTES) throw new Error("The .slop file exceeds 4 MB. Export fewer templates.");
  return text;
}

export function parseGeneratorSlop(text: string): GeneratorSlop {
  if (new TextEncoder().encode(text).byteLength > MAX_SLOP_BYTES) throw new Error("The .slop file exceeds 4 MB.");
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("This .slop file is not valid JSON."); }
  if (raw && typeof raw === "object" && "format" in raw && raw.format === "slop" && "version" in raw && raw.version !== 1) throw new Error("This .slop format version is not supported. Update Slopus to open it.");
  const result = envelopeSchema.safeParse(raw);
  if (!result.success) throw new Error("This is not a valid .slop bundle. Expected format, version and a nonempty items array.");
  return { format: "slop", version: 1, items: result.data.items.map((item, index) => {
    if (item.type !== "generator-template" || item.version !== 1) throw new Error(`Entry ${index + 1}: ${item.type} version ${item.version} is not supported here. No templates were imported.`);
    return { type: "generator-template", version: 1, data: validatedGenerator(item.data, `Entry ${index + 1}`) };
  }) };
}

export function mergeGeneratorSlop(document: GeneratorSlop, current: GeneratorTemplateSettings, library: Lora[]) {
  const loras = [...library];
  const names = new Set(current.templates.map((template) => template.name.toLowerCase()));
  const imported = document.items.map(({ data }) => {
    let title = data.name, suffix = 2;
    while (names.has(title.toLowerCase())) {
      const ending = ` (${suffix++})`;
      title = `${data.name.slice(0, 256 - ending.length)}${ending}`;
    }
    names.add(title.toLowerCase());
    const template = createGeneratorTemplate(title, data.modelType);
    const paths = { ...EMPTY_ENGINE_SETTINGS };
    const usedLoraIds = new Set<string>();
    for (const field of ENGINE_PATH_FIELDS) paths[field.id] = data.sources[field.id]?.[0]?.url ?? "";
    return { ...template, defaultSteps: data.defaultSteps, attention: data.attention, mode: data.mode, motionCache: data.motionCache,
      paths, sources: structuredClone(data.sources),
      additionalSafetensors: data.additionalSafetensors.map((file) => ({ ...file, id: `additional-${crypto.randomUUID()}` })),
      loras: data.loras.map((entry) => {
        let lora = loras.find((existing) => !usedLoraIds.has(existing.id) && existing.url === entry.url && existing.stepOverride === entry.stepOverride && existing.samplingPreset === entry.samplingPreset);
        if (!lora) {
          lora = { id: `lora-${crypto.randomUUID()}`, name: entry.name, path: "", url: entry.url,
            ...(entry.stepOverride !== undefined ? { stepOverride: entry.stepOverride } : {}),
            ...(entry.samplingPreset ? { samplingPreset: entry.samplingPreset } : {}) };
          loras.push(lora);
        }
        usedLoraIds.add(lora.id);
        return { loraId: lora.id, enabled: entry.enabled, strength: entry.strength };
      }),
    } satisfies GeneratorTemplate;
  });
  return { settings: { ...current, templates: [...current.templates, ...imported] }, loras, imported };
}

export function importGeneratorSlop(text: string): GeneratorTemplate[] {
  // Validate the entire bundle before touching either settings store, and read
  // fresh settings after the file dialog so concurrent edits/downloads survive.
  const document = parseGeneratorSlop(text);
  const previousLoras = loadLoras();
  const next = mergeGeneratorSlop(document, loadGeneratorTemplateSettings(), previousLoras);
  const addedLoras = next.loras.length !== previousLoras.length;
  if (addedLoras) saveLoras(next.loras);
  try { saveGeneratorTemplateSettings(next.settings, { strict: true }); }
  catch (error) { if (addedLoras) saveLoras(previousLoras); throw error; }
  return next.imported;
}
