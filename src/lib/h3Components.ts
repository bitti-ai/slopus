import type { EnginePathId, GeneratorTemplate, WeightSource } from "./settings";

export type H3ComponentType = "video" | "audio" | "textEncoder";
export interface H3ComponentTemplate {
  id: string;
  name: string;
  type: H3ComponentType;
  path: string;
  sources: WeightSource[];
  tokenizer?: string;
  tokenizerUrl?: string;
}
export interface H3Components {
  templates: H3ComponentTemplate[];
  defaultTextEncoderId: string;
}

const root = "https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/";
export const H3_VIDEO_VAE_ID = "h3-video-vae";
export const H3_AUDIO_VAE_ID = "h3-audio-vae";
export const H3_FAST_VIDEO_VAE_ID = "h3-fast-video-vae";
export const H3_TEXT_ENCODER_ID = "h3-text-encoder";
export const SOL_H3_VAE_URL = "https://huggingface.co/Efficient-Large-Model/Sol-H3-VAE/resolve/main/sol_h3_vae.safetensors";
const isUrl = (path: string) => /^https?:\/\//i.test(path.trim());
export function initialH3Components(): H3Components {
  return { defaultTextEncoderId: H3_TEXT_ENCODER_ID, templates: [
    { id: H3_VIDEO_VAE_ID, name: "MiniMax H3 Video VAE", type: "video", path: root + "vae/minimax_h3_video_vae_fp16.safetensors" },
    { id: "sol-h3-vae", name: "Sol H3 VAE", type: "video", path: SOL_H3_VAE_URL },
    { id: H3_FAST_VIDEO_VAE_ID, name: "MiniMax H3 Video VAE INT8", type: "video", path: root + "vae/minimax_h3_video_vae_int8_convrot.safetensors" },
    { id: H3_AUDIO_VAE_ID, name: "MiniMax H3 Audio VAE", type: "audio", path: root + "vae/minimax_h3_audio_vae_fp32.safetensors" },
    { id: H3_TEXT_ENCODER_ID, name: "Qwen3 VL 32B MiniMax H3", type: "textEncoder", path: root + "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" },
  ].map((entry) => ({ ...entry, type: entry.type as H3ComponentType, sources: [{ url: entry.path, gpuModel: "", minVramGb: 0 }] })) };
}

function normalizeComponents(value: unknown): H3Components {
  if (!value || typeof value !== "object" || !Array.isArray((value as H3Components).templates)) return initialH3Components();
  const raw = value as H3Components;
  const ids = new Set<string>();
  const templates = raw.templates.flatMap((entry): H3ComponentTemplate[] => {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || !["video", "audio", "textEncoder"].includes(entry.type)) return [];
    ids.add(entry.id);
    const path = typeof entry.path === "string" ? entry.path : "";
    const sources = Array.isArray(entry.sources) ? entry.sources.flatMap((source): WeightSource[] => {
      if (!source || typeof source.url !== "string" || !isUrl(source.url)) return [];
      return [{ url: source.url.trim(), gpuModel: typeof source.gpuModel === "string" ? source.gpuModel : "",
        minVramGb: Number.isFinite(source.minVramGb) ? Math.max(0, source.minVramGb) : 0,
        ...(typeof source.downloadedPath === "string" && !isUrl(source.downloadedPath) ? { downloadedPath: source.downloadedPath } : {}) }];
    }) : [];
    if (isUrl(path) && !sources.some(({ url }) => url === path.trim())) sources.unshift({ url: path.trim(), gpuModel: "", minVramGb: 0 });
    return [{ id: entry.id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name : "Untitled template", type: entry.type,
      path, sources, ...(typeof entry.tokenizer === "string" ? { tokenizer: entry.tokenizer } : {}),
      ...(typeof entry.tokenizerUrl === "string" && isUrl(entry.tokenizerUrl) ? { tokenizerUrl: entry.tokenizerUrl }
        : typeof entry.tokenizer === "string" && isUrl(entry.tokenizer) ? { tokenizerUrl: entry.tokenizer } : {}) }];
  });
  return { templates, defaultTextEncoderId: templates.find((entry) => entry.id === raw.defaultTextEncoderId && entry.type === "textEncoder")?.id
    ?? templates.find((entry) => entry.type === "textEncoder")?.id ?? "" };
}

export function h3ComponentForField(template: GeneratorTemplate, field: EnginePathId, library: H3Components): H3ComponentTemplate | undefined {
  if (template.modelType !== "minimax-h3") return undefined;
  const type = field === "videoVae" ? "video" : field === "audioVae" ? "audio" : field === "textEncoder" || field === "tokenizer" ? "textEncoder" : undefined;
  const id = field === "videoVae" ? template.videoVaeId : field === "audioVae" ? template.audioVaeId : library.defaultTextEncoderId;
  return library.templates.find((entry) => entry.id === id && entry.type === type);
}

/** Keep resolved paths for native/worker consumers, but shared templates own them. */
export function resolveH3Components(template: GeneratorTemplate, library: H3Components): GeneratorTemplate {
  if (template.modelType !== "minimax-h3") return template;
  const paths = { ...template.paths }, sources = { ...template.sources };
  for (const field of ["videoVae", "audioVae", "textEncoder", "tokenizer"] as const) {
    const component = h3ComponentForField(template, field, library);
    paths[field] = field === "tokenizer" ? component?.tokenizer ?? "" : component?.path ?? "";
    const tokenizerUrl = component?.tokenizerUrl ?? (isUrl(paths[field]) ? paths[field] : undefined);
    const entries = field === "tokenizer" ? (tokenizerUrl ? [{ url: tokenizerUrl, gpuModel: "", minVramGb: 0,
      ...(paths[field] && !isUrl(paths[field]) ? { downloadedPath: paths[field] } : {}) }] : []) : component?.sources ?? [];
    if (entries.length) sources[field] = entries;
    else delete sources[field];
  }
  return { ...template, paths, sources };
}

/** Migrate old per-generator files once, including local files and GPU variants. */
export function normalizeH3Library(templates: GeneratorTemplate[], value: unknown, defaultGeneratorId: string) {
  const library = normalizeComponents(value);
  const migrating = !value;
  const canonical = (path: string) => path.trim().replace("/blob/", "/resolve/").replaceAll("\\", "/");
  const migrate = (template: GeneratorTemplate, field: "videoVae" | "audioVae" | "textEncoder") => {
    const type = field === "videoVae" ? "video" : field === "audioVae" ? "audio" : "textEncoder";
    const path = template.paths[field];
    const sources = template.sources?.[field] ?? [];
    if (!path && !sources.length) return field === "videoVae" ? H3_VIDEO_VAE_ID : field === "audioVae" ? H3_AUDIO_VAE_ID : H3_TEXT_ENCODER_ID;
    const sourceKey = (entries: WeightSource[]) => JSON.stringify(entries.map(({ url, gpuModel, minVramGb }) => ({ url: canonical(url), gpuModel, minVramGb })));
    let entry = library.templates.find((entry) => entry.type === type && (
      canonical(entry.path) === canonical(path) || sources.some((source) => source.downloadedPath === path && entry.sources.some((a) => canonical(a.url) === canonical(source.url)))
      || isUrl(path) && entry.sources.some((a) => canonical(a.url) === canonical(path))
    ) && (sourceKey(entry.sources) === sourceKey(sources)) && (
      !path || isUrl(path) || isUrl(entry.path) || canonical(entry.path) === canonical(path)
    ) && (field !== "textEncoder" || (entry.tokenizer ?? "") === template.paths.tokenizer));
    if (!entry) {
      const baseId = `${template.id}-${field}`;
      let id = baseId, suffix = 2;
      while (library.templates.some((entry) => entry.id === id)) id = `${baseId}-${suffix++}`;
      entry = { id, name: `${template.name} ${type === "textEncoder" ? "Text Encoder" : type === "video" ? "Video VAE" : "Audio VAE"}`,
        type, path, sources, ...(field === "textEncoder" ? { tokenizer: template.paths.tokenizer,
          tokenizerUrl: isUrl(template.paths.tokenizer) ? template.paths.tokenizer : template.sources?.tokenizer?.find((source) => source.downloadedPath === template.paths.tokenizer)?.url } : {}) };
      library.templates.push(entry);
    } else {
      if (path && !isUrl(path) && (!entry.path || isUrl(entry.path))) entry.path = path;
      for (const source of sources) {
        const existing = entry.sources.find((item) => canonical(item.url) === canonical(source.url));
        if (!existing) entry.sources.push(source);
        else if (source.downloadedPath && !existing.downloadedPath) existing.downloadedPath = source.downloadedPath;
      }
    }
    return entry.id;
  };
  const migratedEncoders: string[] = [];
  const linked = templates.map((template) => {
    if (template.modelType !== "minimax-h3") return template;
    const next = { ...template };
    for (const field of ["videoVae", "audioVae"] as const) {
      const key = field === "videoVae" ? "videoVaeId" : "audioVaeId";
      if (next[key] === undefined) next[key] = migrate(template, field);
    }
    if (migrating && template.mode !== "animate" && (template.paths.textEncoder || template.sources?.textEncoder?.length)) {
      const id = migrate(template, "textEncoder");
      migratedEncoders.push(id);
      if (template.id === defaultGeneratorId) library.defaultTextEncoderId = id;
    }
    return next;
  });
  // Prefer an existing local encoder on first migration if the former default had none.
  if (migrating && !templates.find((entry) => entry.id === defaultGeneratorId)?.paths.textEncoder) {
    library.defaultTextEncoderId = library.templates.find((entry) => migratedEncoders.includes(entry.id) && entry.path && !isUrl(entry.path))?.id
      ?? migratedEncoders[0] ?? library.defaultTextEncoderId;
  }
  return { h3Components: library, templates: linked.map((template) => resolveH3Components(template, library)) };
}
