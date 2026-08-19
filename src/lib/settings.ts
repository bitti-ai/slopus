/* Machine-level settings.
 *
 * The video engine and its weights are a property of THIS computer, not of a
 * project: a project folder copied from another machine carries paths that do
 * not exist here. They therefore live in localStorage rather than in
 * polstudio.json, and are merged into `providerSettings.vidfab` only
 * on the way into a Tauri command — never on the way into a saved config.
 * Keep it that way: writing them into a project file would put one machine's
 * disk layout into a file the user is invited to move, copy, and share.
 *
 * The option names below are the contract with `Configuration::from_settings`
 * in src-tauri/src/vidfab.rs. Renaming one here without renaming it there
 * silently drops that path.
 */
import type { ProjectConfig, ProviderSetting } from "./project";
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

/* No entry for the engine library itself: it ships beside PolStudio.exe and is
   loaded from there, so there was never a path worth asking anyone for — only
   one that could be set wrong. Weights are different: they are large, they are
   downloaded separately, and they live wherever the user put them. */
export const ENGINE_PATH_FIELDS: EnginePathField[] = [
  { id: "transformer", label: "Transformer weights", hint: "The main model that turns your description into moving pictures.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
  { id: "textEncoder", label: "Text encoder weights", hint: "Reads your prompt so the transformer can act on it.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
  { id: "tokenizer", label: "Tokenizer", hint: "Splits your prompt into pieces the text encoder understands. Usually a folder.", directory: true, extensions: [], required: false },
  { id: "videoVae", label: "Video VAE weights", hint: "Turns the model's internal picture into real video frames.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
  { id: "audioVae", label: "Audio VAE weights", hint: "Turns the model's internal sound into real audio.", directory: false, extensions: ["safetensors", "gguf", "bin"], required: true },
];

export type EngineSettings = Record<EnginePathId, string>;

export const EMPTY_ENGINE_SETTINGS: EngineSettings = {
  transformer: "", textEncoder: "", tokenizer: "", videoVae: "", audioVae: "",
};

const ENGINE_KEY = "polstudio.engine-paths.v1";

/** Reads what is stored, ignoring anything that is not a string: a hand-edited
 *  or half-written entry must not take the whole settings screen down. */
export function loadEngineSettings(): EngineSettings {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (!raw) return { ...EMPTY_ENGINE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Record<EnginePathId, unknown>>;
    const settings = { ...EMPTY_ENGINE_SETTINGS };
    for (const field of ENGINE_PATH_FIELDS) {
      const value = parsed?.[field.id];
      if (typeof value === "string") settings[field.id] = value;
    }
    return settings;
  } catch {
    return { ...EMPTY_ENGINE_SETTINGS };
  }
}

export function saveEngineSettings(settings: EngineSettings): void {
  try {
    localStorage.setItem(ENGINE_KEY, JSON.stringify(settings));
  } catch {
    /* A full or disabled localStorage costs the user the saved paths, not the
       session: the values they just typed are still in the fields. */
  }
}

/** The `vidfab` provider setting these paths describe, with blanks dropped so
 *  an unset field falls through to whatever the project (or the Rust default)
 *  already had rather than overwriting it with "". */
export function engineProviderSetting(settings: EngineSettings, base?: ProviderSetting): ProviderSetting {
  const options: ProviderSetting["options"] = { ...(base?.options ?? {}) };
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
      vidfab: engineProviderSetting(loadEngineSettings(), config.providerSettings.vidfab),
    },
  };
}

/* --- Agent provider -------------------------------------------------------- */

/* Which coding agent drives Pol is a property of the computer — it depends on
 * what is installed and signed in here — so it is remembered across restarts
 * next to the engine paths, not inside a project file. Projects written before
 * this existed still carry their own choice; that is read as a seed the first
 * time and then this preference takes over. */
const AGENT_PROVIDER_KEY = "polstudio.agent-provider.v1";

export function loadAgentProvider(): ProviderId | null {
  try {
    const value = localStorage.getItem(AGENT_PROVIDER_KEY);
    return value === "claude" || value === "codex" ? value : null;
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

/* --- Panel layout ----------------------------------------------------------
   How the media panel lays its footage out. A working habit, not a property of
   any one project, so it lives beside the engine paths rather than in
   polstudio.json — a project file the user may copy to another machine should not
   carry one editor's panel preference with it. */

export type MediaLayout = "grid" | "list";

const MEDIA_LAYOUT_KEY = "polstudio.media-layout.v1";

export function loadMediaLayout(): MediaLayout {
  try {
    return localStorage.getItem(MEDIA_LAYOUT_KEY) === "list" ? "list" : "grid";
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
