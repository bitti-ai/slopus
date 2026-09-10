/* Machine-level settings.
 *
 * The video engine and its weights are a property of THIS computer, not of a
 * project: a project folder copied from another machine carries paths that do
 * not exist here. They therefore live in localStorage rather than in
 * slopus.json, and are merged into `providerSettings.slopfab` only
 * on the way into a Tauri command — never on the way into a saved config.
 * Keep it that way: writing them into a project file would put one machine's
 * disk layout into a file the user is invited to move, copy, and share.
 *
 * The option names below are the contract with `Configuration::from_settings`
 * in src-tauri/src/slopfab.rs. Renaming one here without renaming it there
 * silently drops that path.
 */
import { DEFAULT_GENERATION_STEPS, MAX_GENERATION_STEPS, type ProjectConfig, type ProviderSetting } from "./project";
// Type-only: erased at build time, so this does not close a cycle with runtime.ts.
import type { ProviderId } from "./runtime";

/* Light/dark appearance is machine-level for the same reason and lives in
 * ./theme.ts, which is separate only because index.html has to read the same
 * value from a classic script before the bundle exists. */

export type EnginePathId = "transformer" | "textEncoder" | "tokenizer" | "videoVae" | "audioVae";

export interface EnginePathField {
  id: EnginePathId;
  label: string;
  /** What this file is, in the user's terms — not in the model's. */
  hint: string;
  /** A directory picker rather than a file picker. */
  directory: boolean;
  /** File extensions offered by the picker; empty means "any file". */
  extensions: string[];
  /** Generation cannot run without it. */
  required: boolean;
}

/* No entry for the engine library itself: it ships beside Slopus.exe and is
   loaded from there, so there was never a path worth asking anyone for — only
   one that could be set wrong. Weights are different: they are large, they are
   downloaded separately, and they live wherever the user put them. */
export const ENGINE_PATH_FIELDS: EnginePathField[] = [
  { id: "transformer", label: "Transformer weights", hint: "The main model that turns your description into moving pictures.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
  { id: "textEncoder", label: "Text encoder weights", hint: "Reads your prompt so the transformer can act on it.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
  { id: "videoVae", label: "Video VAE weights", hint: "Turns the model's internal picture into real video frames.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
  { id: "audioVae", label: "Audio VAE weights", hint: "Turns the model's internal sound into real audio.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
  { id: "tokenizer", label: "Tokenizer", hint: "Splits your prompt into pieces the text encoder understands. Usually a folder.", directory: true, extensions: [], required: false },
];

export type EngineSettings = Record<EnginePathId, string>;

export const EMPTY_ENGINE_SETTINGS: EngineSettings = {
  transformer: "", textEncoder: "", tokenizer: "", videoVae: "", audioVae: "",
};

const ENGINE_KEY = "slopus.engine-paths.v1";
const GENERATOR_TEMPLATES_KEY = "slopus.generator-templates.v1";
const LEGACY_ENGINE_KEY = "polstudio.engine-paths.v1";
const LEGACY_GENERATOR_TEMPLATES_KEY = "polstudio.generator-templates.v1";

function migratedStorageItem(key: string, legacyKey: string): string | null {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) localStorage.setItem(key, legacy);
  return legacy;
}

export interface GeneratorTemplate {
  id: string;
  name: string;
  defaultSteps: number;
  attention: AttentionMode;
  paths: EngineSettings;
}

export type AttentionMode = "exact" | "flash2" | "sage2";
export type InferenceBackend = "cuda" | "vulkan";
const INFERENCE_BACKEND_KEY = "slopus.inference-backend.v1";

export function loadInferenceBackend(): InferenceBackend {
  try {
    return localStorage.getItem(INFERENCE_BACKEND_KEY) === "vulkan" ? "vulkan" : "cuda";
  } catch {
    return "cuda";
  }
}

export function saveInferenceBackend(backend: InferenceBackend): void {
  try {
    localStorage.setItem(INFERENCE_BACKEND_KEY, backend);
  } catch {
    /* Keep the current settings screen usable if storage is unavailable. */
  }
}

export interface GeneratorTemplateSettings {
  templates: GeneratorTemplate[];
  defaultTemplateId: string;
}

const copyPaths = (paths: EngineSettings): EngineSettings => ({ ...paths });

const pathsFrom = (value: unknown): EngineSettings => {
  const result = copyPaths(EMPTY_ENGINE_SETTINGS);
  if (!value || typeof value !== "object") return result;
  const record = value as Partial<Record<EnginePathId, unknown>>;
  for (const field of ENGINE_PATH_FIELDS) {
    const path = record[field.id];
    if (typeof path === "string") result[field.id] = path;
  }
  return result;
};

export function createGeneratorTemplate(name = "New template"): GeneratorTemplate {
  return {
    id: `generator-template-${crypto.randomUUID()}`,
    name,
    defaultSteps: DEFAULT_GENERATION_STEPS,
    attention: "sage2",
    paths: copyPaths(EMPTY_ENGINE_SETTINGS),
  };
}

const initialTemplateSettings = (paths = EMPTY_ENGINE_SETTINGS): GeneratorTemplateSettings => ({
  templates: [{ id: "default", name: "Default", defaultSteps: DEFAULT_GENERATION_STEPS, attention: "sage2", paths: copyPaths(paths) }],
  defaultTemplateId: "default",
});

const normalizeTemplateSettings = (value: unknown): GeneratorTemplateSettings | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as { templates?: unknown; defaultTemplateId?: unknown };
  if (!Array.isArray(record.templates)) return null;
  const ids = new Set<string>();
  const templates = record.templates.flatMap((item): GeneratorTemplate[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<Record<keyof GeneratorTemplate, unknown>>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!id || ids.has(id)) return [];
    ids.add(id);
    const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : "Untitled template";
    const defaultSteps = typeof candidate.defaultSteps === "number"
      && Number.isInteger(candidate.defaultSteps)
      && candidate.defaultSteps >= 2
      && candidate.defaultSteps <= MAX_GENERATION_STEPS
      ? candidate.defaultSteps
      : DEFAULT_GENERATION_STEPS;
    const attention = candidate.attention === "exact" || candidate.attention === "flash2" ? candidate.attention : "sage2";
    return [{ id, name, defaultSteps, attention, paths: pathsFrom(candidate.paths) }];
  });
  if (templates.length === 0) return null;
  const requestedDefault = typeof record.defaultTemplateId === "string" ? record.defaultTemplateId : "";
  return {
    templates,
    defaultTemplateId: templates.some((template) => template.id === requestedDefault) ? requestedDefault : templates[0].id,
  };
};

/** Generator templates are machine-local because every path names this
 * computer. A pre-template installation is migrated in memory into its one
 * Default template; the next edit persists the new format. */
export function loadGeneratorTemplateSettings(): GeneratorTemplateSettings {
  try {
    const stored = migratedStorageItem(GENERATOR_TEMPLATES_KEY, LEGACY_GENERATOR_TEMPLATES_KEY);
    if (stored) {
      const normalized = normalizeTemplateSettings(JSON.parse(stored));
      if (normalized) return normalized;
    }
    const legacy = migratedStorageItem(ENGINE_KEY, LEGACY_ENGINE_KEY);
    return initialTemplateSettings(legacy ? pathsFrom(JSON.parse(legacy)) : EMPTY_ENGINE_SETTINGS);
  } catch {
    return initialTemplateSettings();
  }
}

export function saveGeneratorTemplateSettings(settings: GeneratorTemplateSettings): void {
  const normalized = normalizeTemplateSettings(settings) ?? initialTemplateSettings();
  try {
    localStorage.setItem(GENERATOR_TEMPLATES_KEY, JSON.stringify(normalized));
  } catch {
    /* The current React state remains usable for this session. */
  }
}

export function defaultGeneratorTemplate(settings = loadGeneratorTemplateSettings()): GeneratorTemplate {
  return settings.templates.find((template) => template.id === settings.defaultTemplateId) ?? settings.templates[0];
}

export function loadDefaultGenerationSteps(): number {
  return defaultGeneratorTemplate().defaultSteps;
}

/** Reads what is stored, ignoring anything that is not a string: a hand-edited
 *  or half-written entry must not take the whole settings screen down. */
export function loadEngineSettings(): EngineSettings {
  return copyPaths(defaultGeneratorTemplate().paths);
}

export function saveEngineSettings(settings: EngineSettings): void {
  const current = loadGeneratorTemplateSettings();
  saveGeneratorTemplateSettings({
    ...current,
    templates: current.templates.map((template) => template.id === current.defaultTemplateId
      ? { ...template, paths: copyPaths(settings) }
      : template),
  });
}

/** The `slopfab` provider setting these paths describe, with blanks dropped so
 *  an unset field falls through to whatever the project (or the Rust default)
 *  already had rather than overwriting it with "". */
export function engineProviderSetting(settings: EngineSettings, base?: ProviderSetting, attention = defaultGeneratorTemplate().attention): ProviderSetting {
  const options: ProviderSetting["options"] = { ...(base?.options ?? {}), attention, inferenceBackend: loadInferenceBackend() };
  for (const field of ENGINE_PATH_FIELDS) {
    const value = settings[field.id].trim();
    if (value) options[field.id] = value;
  }
  return { enabled: base?.enabled ?? true, model: base?.model ?? null, options };
}

/** A copy of `config` carrying this machine's engine paths. For passing to a
 *  Tauri command only — never store or save the result. */
export function withEngineSettings(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    providerSettings: {
      ...config.providerSettings,
      slopfab: engineProviderSetting(loadEngineSettings(), config.providerSettings.slopfab),
    },
  };
}

export type EndpointProviderId = "openrouter" | "local";

export interface EndpointProviderSettings {
  endpoint: string;
  apiKey: string;
  model: string;
}

export type AgentEndpointSettings = Record<EndpointProviderId, EndpointProviderSettings>;

export const EMPTY_AGENT_ENDPOINT_SETTINGS: AgentEndpointSettings = {
  openrouter: { endpoint: "https://openrouter.ai/api/v1", apiKey: "", model: "" },
  local: { endpoint: "", apiKey: "", model: "" },
};

const AGENT_ENDPOINTS_KEY = "slopus.agent-endpoints.v1";
const LEGACY_AGENT_ENDPOINTS_KEY = "polstudio.agent-endpoints.v1";

export function loadAgentEndpointSettings(): AgentEndpointSettings {
  const fallback = {
    openrouter: { ...EMPTY_AGENT_ENDPOINT_SETTINGS.openrouter },
    local: { ...EMPTY_AGENT_ENDPOINT_SETTINGS.local },
  };
  try {
    const raw = migratedStorageItem(AGENT_ENDPOINTS_KEY, LEGACY_AGENT_ENDPOINTS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Record<EndpointProviderId, Partial<Record<keyof EndpointProviderSettings, unknown>>>>;
    for (const id of ["openrouter", "local"] as const) {
      for (const field of ["endpoint", "apiKey", "model"] as const) {
        const value = parsed?.[id]?.[field];
        if (typeof value === "string") fallback[id][field] = value;
      }
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function saveAgentEndpointSettings(settings: AgentEndpointSettings): void {
  try {
    localStorage.setItem(AGENT_ENDPOINTS_KEY, JSON.stringify(settings));
  } catch {
    /* Never fall back to putting machine credentials in a project file. */
  }
}

export function endpointProviderSetting(settings: EndpointProviderSettings): ProviderSetting {
  const options: ProviderSetting["options"] = { endpoint: settings.endpoint.trim() };
  if (settings.apiKey.trim()) options.apiKey = settings.apiKey.trim();
  return { enabled: true, model: settings.model.trim() || null, options };
}

export function isEndpointProviderConfigured(id: EndpointProviderId, settings: EndpointProviderSettings): boolean {
  return Boolean(settings.endpoint.trim() && settings.model.trim() && (id === "local" || settings.apiKey.trim()));
}

/** These settings exist only on an IPC request. Rust removes them before
 * validating, prompting with, or saving the project. */
export function agentEndpointProviderSettings(): Partial<Record<EndpointProviderId, ProviderSetting>> {
  const settings = loadAgentEndpointSettings();
  return Object.fromEntries(
    (["openrouter", "local"] as const)
      .filter((id) => isEndpointProviderConfigured(id, settings[id]))
      .map((id) => [id, endpointProviderSetting(settings[id])]),
  );
}

export function withAgentEndpointSettings(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    providerSettings: { ...config.providerSettings, ...agentEndpointProviderSettings() },
  };
}

/* --- Agent provider -------------------------------------------------------- */

/* Which coding agent drives Slop is a property of the computer — it depends on
 * what is installed and signed in here — so it is remembered across restarts
 * next to the engine paths, not inside a project file. Projects written before
 * this existed still carry their own choice; that is read as a seed the first
 * time and then this preference takes over. */
const AGENT_PROVIDER_KEY = "slopus.agent-provider.v1";
const LEGACY_AGENT_PROVIDER_KEY = "polstudio.agent-provider.v1";

export function loadAgentProvider(): ProviderId | null {
  try {
    const value = migratedStorageItem(AGENT_PROVIDER_KEY, LEGACY_AGENT_PROVIDER_KEY);
    return value === "claude" || value === "codex" || value === "openrouter" || value === "local" ? value : null;
  } catch {
    return null;
  }
}

export function saveAgentProvider(provider: ProviderId): void {
  try {
    localStorage.setItem(AGENT_PROVIDER_KEY, provider);
  } catch {
    /* Losing the preference costs a dropdown click next launch, nothing more. */
  }
}

/* --- Debug options --------------------------------------------------------- */

const DEBUG_OPTIONS_KEY = "slopus.debug-options.v1";
const DEBUG_OPTIONS_EVENT = "slopus:debug-options-changed";

export function loadDebugOptionsEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_OPTIONS_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveDebugOptionsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(DEBUG_OPTIONS_KEY, String(enabled));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(DEBUG_OPTIONS_EVENT));
}

export function subscribeDebugOptions(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEBUG_OPTIONS_KEY || event.key === null) listener();
  };
  window.addEventListener(DEBUG_OPTIONS_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(DEBUG_OPTIONS_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

/* --- Panel layout ----------------------------------------------------------
   How the media panel lays its footage out. A working habit, not a property of
   any one project, so it lives beside the engine paths rather than in
   slopus.json — a project file the user may copy to another machine should not
   carry one editor's panel preference with it. */

export type MediaLayout = "grid" | "list";

const MEDIA_LAYOUT_KEY = "slopus.media-layout.v1";
const LEGACY_MEDIA_LAYOUT_KEY = "polstudio.media-layout.v1";

export function loadMediaLayout(): MediaLayout {
  try {
    return migratedStorageItem(MEDIA_LAYOUT_KEY, LEGACY_MEDIA_LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function saveMediaLayout(layout: MediaLayout): void {
  try {
    localStorage.setItem(MEDIA_LAYOUT_KEY, layout);
  } catch {
    /* A full or disabled localStorage costs the preference, not the session:
       the panel still shows whatever was just chosen. */
  }
}
