import { GeneratorTemplateDialog } from "./GeneratorTemplateDialog";
import { AdditionalSafetensorsEditor } from "./AdditionalSafetensorsEditor";
import { AlertCircle, ArrowLeft, Check, ChevronLeft, Download, FolderOpen, FolderSearch, LoaderCircle, Monitor, Moon, Plus, RefreshCw, RotateCcw, Sun, Trash2, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { revealDiagnosticLog } from "../lib/diagnostics";
import { isTauri } from "../lib/persistence";
import { WeightSourcesEditor } from "./WeightSourcesEditor";
import { LoraEditor, LoraLibrary, TemplateLorasEditor } from "./LoraSettings";
import { downloadableTemplateLoras } from "../lib/loras";
import { retryWeightDownload } from "../lib/weightDownloads";
import { cancelWeightDownload, downloadTemplateWeights, getWeightDownloadState, refreshDownloadedWeights, removeTemplateWeights, subscribeWeightDownloads, updateWeightPath, weightDownloadProgress } from "../lib/weightDownloads";
import { chooseEnginePath, getAgentModels, getEngineStatus, type ModelStatus, type SlopfabStatus } from "../lib/runtime";
import {
  EMPTY_ENGINE_SETTINGS, generatorPathFields,
  createGeneratorTemplate, defaultGeneratorTemplate,
  isEndpointProviderConfigured, loadAgentEndpointSettings,
  loadGeneratorTemplateSettings, saveAgentEndpointSettings, saveGeneratorTemplateSettings,
  isDownloadUrl, subscribeGeneratorTemplates, templateNeedsDownload, type WeightSource,
  loadDebugOptionsEnabled, saveDebugOptionsEnabled, subscribeDebugOptions,
  loadInferenceBackend, saveInferenceBackend, type AttentionMode, type InferenceBackend,
  type AgentEndpointSettings, type EndpointProviderId, type EndpointProviderSettings,
  type EnginePathField, type EnginePathId, type EngineSettings, type GeneratorTemplate, type GeneratorTemplateSettings,
} from "../lib/settings";
import { MAX_GENERATION_STEPS } from "../lib/project";
import { availableReferenceIconGenerators, loadReferenceIconAutomation, loadReferenceIconGeneratorId, referenceIconGenerator, saveReferenceIconAutomation, saveReferenceIconGeneratorId, subscribeReferenceIconAutomation } from "../lib/referenceIconSettings";
import {
  applyTheme, loadTheme, saveTheme, systemTheme, watchSystemTheme,
  type ResolvedTheme, type ThemeChoice,
} from "../lib/theme";

type PathState = "unset" | "checking" | "found" | "missing" | "download";

function pathState(field: EnginePathField, value: string, status: SlopfabStatus | null): PathState {
  if (!value.trim()) return "unset";
  if (isDownloadUrl(value)) return "download";
  if (!status) return "checking";
  const model: ModelStatus | undefined = status.models.find((item) => item.id === field.id);
  if (!model) return "checking";
  /* `available` is a file test on the Rust side, so a tokenizer FOLDER reads
     as unavailable even when it is perfectly fine. Don't call that missing. */
  if (!model.available && field.directory) return "found";
  return model.available ? "found" : "missing";
}

const stateLabel: Record<PathState, string> = {
  unset: "Not set",
  checking: "Checking…",
  found: "Found",
  missing: "Not found on disk",
  download: "Download required",
};

function templateSummary(template: GeneratorTemplate): string {
  const loras = downloadableTemplateLoras(template.loras);
  const pendingModels = generatorPathFields(template).some(({ id }) => isDownloadUrl(template.paths[id])
    || (!template.paths[id].trim() && (template.sources?.[id]?.length ?? 0) > 0));
  return `${template.defaultSteps} steps${loras.length && !pendingModels ? ` · Needs ${loras.map(({ name }) => name).join(", ")} LoRA${loras.length > 1 ? "s" : ""}` : ""}`;
}

/* The system option has to say what the computer is currently set to, or
   "Match this computer" is a promise the user cannot check. */
const themeOptions: { id: ThemeChoice; label: string; icon: typeof Sun; detail: (system: ResolvedTheme) => string }[] = [
  {
    id: "system",
    label: "Match this computer",
    icon: Monitor,
    detail: (system) => `Currently ${system}. Follows along when you change it.`,
  },
  { id: "light", label: "Light", icon: Sun, detail: () => "Always light, whatever this computer is set to." },
  { id: "dark", label: "Dark", icon: Moon, detail: () => "Always dark, whatever this computer is set to." },
];

function ReferenceIconSetting({ templates }: { templates: GeneratorTemplateSettings }) {
  const automation = useSyncExternalStore(subscribeReferenceIconAutomation, loadReferenceIconAutomation);
  const chosenId = useSyncExternalStore(subscribeReferenceIconAutomation, loadReferenceIconGeneratorId);
  const available = availableReferenceIconGenerators(templates);
  const selected = referenceIconGenerator(templates, chosenId);
  return (
    <div className="reference-icon-settings">
    <label className="reference-icon-option">
      <input type="checkbox" checked={automation !== "disabled"} onChange={(event) => saveReferenceIconAutomation(event.target.checked ? "ask" : "disabled")} aria-labelledby="automatic-reference-icons-label" />
      <span><b id="automatic-reference-icons-label">Automatic reference icon generation</b></span>
    </label>
    <div className="generator-template-fields">
      <label><span>Reference icon generator</span>
        <select aria-label="Reference icon generator" disabled={!available.length} value={selected?.id ?? ""} onChange={(event) => saveReferenceIconGeneratorId(event.target.value)}>
          {!available.length && <option value="">No available generators</option>}
          {available.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
        </select>
      </label>
    </div>
    </div>
  );
}

function AppearanceSetting() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  /* The app repaints itself through prefers-color-scheme; this listener only
     keeps the "Currently dark/light" line honest while the screen is open. */
  useEffect(() => watchSystemTheme(setSystem), []);

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
    applyTheme(next);
  };

  return (
    /* Named here rather than by a heading: the tab above IS the heading now,
       and a group pointed at an element that no longer exists announces
       nothing at all. */
    <div className="theme-choice" role="radiogroup" aria-label="Appearance">
      {themeOptions.map((option) => {
        const Icon = option.icon;
        const selected = choice === option.id;
        return (
          <label
            key={option.id}
            className={`theme-choice__option${selected ? " theme-choice__option--selected" : ""}`}
          >
            <input
              type="radio"
              name="slopus-theme"
              value={option.id}
              checked={selected}
              onChange={() => pick(option.id)}
            />
            <Icon size={18} aria-hidden="true" />
            <b>{option.label}</b>
            <small>{option.detail(system)}</small>
          </label>
        );
      })}
    </div>
  );
}

const endpointProviders: { id: EndpointProviderId; label: string; detail: string; endpointPlaceholder: string; keyRequired: boolean }[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    detail: "Use models from openrouter.ai through its OpenAI-compatible API.",
    endpointPlaceholder: "https://openrouter.ai/api/v1",
    keyRequired: true,
  },
  {
    id: "local",
    label: "Local OpenAI-compatible",
    detail: "Use a server on this computer or network that implements /models and /chat/completions.",
    endpointPlaceholder: "http://localhost:1234/v1",
    keyRequired: false,
  },
];

function PromptLlmSetting({ desktop }: { desktop: boolean }) {
  const [settings, setSettings] = useState<AgentEndpointSettings>(loadAgentEndpointSettings);
  const [models, setModels] = useState<Record<EndpointProviderId, string[]>>({ openrouter: [], local: [] });
  const [loading, setLoading] = useState<EndpointProviderId | null>(null);
  const [errors, setErrors] = useState<Partial<Record<EndpointProviderId, string>>>({});

  const update = (id: EndpointProviderId, field: keyof EndpointProviderSettings, value: string) => {
    setSettings((current) => {
      const next = { ...current, [id]: { ...current[id], [field]: value } };
      saveAgentEndpointSettings(next);
      return next;
    });
  };

  const discover = async (id: EndpointProviderId) => {
    setLoading(id);
    setErrors((current) => ({ ...current, [id]: undefined }));
    try {
      const found = await getAgentModels(id, settings[id]);
      setModels((current) => ({ ...current, [id]: found }));
      if (found.length === 0) setErrors((current) => ({ ...current, [id]: "The endpoint returned no models. You can still enter a model ID manually." }));
    } catch (reason) {
      setErrors((current) => ({ ...current, [id]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setLoading(null);
    }
  };

  return <div className="llm-settings">
    <p className="llm-settings__intro">Configured providers appear in Slop’s agent list. Endpoints and API keys stay on this computer and are never saved in a project.</p>
    {endpointProviders.map((provider) => {
      const value = settings[provider.id];
      const configured = isEndpointProviderConfigured(provider.id, value);
      const listId = `llm-models-${provider.id}`;
      return <section className={`llm-provider${configured ? " llm-provider--configured" : ""}`} key={provider.id} aria-labelledby={`llm-${provider.id}-heading`}>
        <header>
          <div><h2 id={`llm-${provider.id}-heading`}>{provider.label}</h2><p>{provider.detail}</p></div>
          <span>{configured ? <><Check size={14} /> Configured</> : "Not configured"}</span>
        </header>
        <div className="llm-provider__fields">
          <label>
            <span>Endpoint</span>
            <input aria-label={`${provider.label} endpoint`} value={value.endpoint} spellCheck={false} placeholder={provider.endpointPlaceholder} onChange={(event) => update(provider.id, "endpoint", event.target.value)} />
          </label>
          <label>
            <span>API key{!provider.keyRequired && <em>Optional</em>}</span>
            <input type="password" aria-label={`${provider.label} API key`} value={value.apiKey} autoComplete="off" spellCheck={false} placeholder={provider.keyRequired ? "Required" : "Leave blank if the server does not require one"} onChange={(event) => update(provider.id, "apiKey", event.target.value)} />
          </label>
          <label className="llm-provider__model">
            <span>Model</span>
            <div>
              <input list={listId} aria-label={`${provider.label} model`} value={value.model} spellCheck={false} placeholder="Select or enter a model ID" onChange={(event) => update(provider.id, "model", event.target.value)} />
              <datalist id={listId}>{models[provider.id].map((model) => <option value={model} key={model} />)}</datalist>
              <button type="button" className="secondary-button" disabled={!desktop || !value.endpoint.trim() || loading === provider.id} onClick={() => void discover(provider.id)} title={desktop ? "Load models from this endpoint" : "Model discovery is available in the desktop app"}>
                {loading === provider.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Load models
              </button>
            </div>
          </label>
        </div>
        {errors[provider.id] && <p className="llm-provider__error" role="alert">{errors[provider.id]}</p>}
      </section>;
    })}
  </div>;
}

function DiagnosticsSetting({ desktop, status, onBackendChange }: { desktop: boolean; status: SlopfabStatus | null; onBackendChange: () => void }) {
  const [backend, setBackend] = useState(loadInferenceBackend);
  const cudaAvailable = status?.cudaAvailable === true;
  const debugEnabled = useSyncExternalStore(subscribeDebugOptions, loadDebugOptionsEnabled);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = async () => {
    setOpening(true);
    setError(null);
    try {
      await revealDiagnosticLog();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening(false);
    }
  };

  return <>
    <div className="generator-template-fields diagnostics-backend">
      <label>
        <span>GPU backend</span>
        <select aria-label="GPU backend" value={cudaAvailable ? backend : "vulkan"} disabled={!desktop || !cudaAvailable} onChange={(event) => {
          const next = event.target.value as InferenceBackend;
          saveInferenceBackend(next);
          setBackend(next);
          onBackendChange();
        }}>
          {cudaAvailable && <option value="cuda">CUDA</option>}
          <option value="vulkan">Vulkan</option>
        </select>
      </label>
    </div>
    <label className="diagnostics-debug-option">
      <input type="checkbox" checked={debugEnabled} onChange={(event) => saveDebugOptionsEnabled(event.target.checked)} aria-labelledby="debug-options-label" aria-describedby="debug-options-description" />
      <span><b id="debug-options-label">Enable debug options</b><small id="debug-options-description">Show Debug Prompt in scene settings and Debug Icon Prompt in reference details.</small></span>
    </label>
    <button type="button" className="secondary-button" disabled={!desktop || opening} onClick={() => void reveal()} title={error ?? undefined}>
      {opening ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />} Show log file
    </button>
  </>;
}

/* The settings page keeps its section navigation behind the generator popup. */
const TABS = [
  { id: "engine", label: "Generator" },
  { id: "llms", label: "Agents" },
  { id: "appearance", label: "Appearance" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "updates", label: "Updates" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function SettingsView({ onClose, updates, initialTab = "engine" }: { onClose: () => void; updates?: ReactNode; initialTab?: TabId }) {
  /* The engine first: this screen exists because those paths have to be set
     before anything can be rendered, and its status line answers "is Slopus
     ready?" without a click. */
  const [tab, setTab] = useState<TabId>(initialTab);
  const page = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { page.current?.focus(); }, []);
  const [templateSettings, setTemplateSettings] = useState<GeneratorTemplateSettings>(() => loadGeneratorTemplateSettings());
  const downloadState = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const downloadPercent = downloadState ? weightDownloadProgress(downloadState) : 0;
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  useEffect(() => {
    if (page.current) page.current.inert = Boolean(editingTemplateId);
  }, [editingTemplateId]);
  const [editingLoraId, setEditingLoraId] = useState<string | null>(null);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [status, setStatus] = useState<SlopfabStatus | null>(null);
  const probeRevision = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();

  const defaultTemplate = defaultGeneratorTemplate(templateSettings);
  const selectedTemplate = templateSettings.templates.find((template) => template.id === editingTemplateId)
    ?? defaultTemplate;
  const settings = selectedTemplate.paths;
  const downloadedPathsKey = JSON.stringify(Object.values(selectedTemplate.sources ?? {}).flatMap((sources) => sources.map(({ downloadedPath }) => downloadedPath)));
  const downloading = downloadState?.active && downloadState.templateId === selectedTemplate.id;
  const generatorSections = [
    { id: "generators", title: "Generators", templates: templateSettings.templates.filter((template) => !templateNeedsDownload(template)) },
    { id: "downloadable-generators", title: "Download", templates: templateSettings.templates.filter(templateNeedsDownload) },
  ];

  useEffect(() => setShowAdvancedOptions(false), [editingTemplateId]);

  useEffect(() => subscribeGeneratorTemplates(() => setTemplateSettings(loadGeneratorTemplateSettings())), []);
  useEffect(() => {
    const refresh = () => { void refreshDownloadedWeights().catch((reason) => setError(String(reason))); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);

  const probe = useCallback((paths?: EngineSettings) => {
    const revision = ++probeRevision.current;
    void getEngineStatus(paths, selectedTemplate.attention, selectedTemplate.loras ?? [], selectedTemplate.mode ?? "prompt", selectedTemplate.additionalSafetensors ?? [], selectedTemplate.motionCache ?? false).then((next) => {
      if (revision === probeRevision.current) setStatus(next);
    }).catch(() => {
      if (revision === probeRevision.current) setStatus(null);
    });
  }, [selectedTemplate.attention, selectedTemplate.loras, selectedTemplate.mode, selectedTemplate.additionalSafetensors, selectedTemplate.motionCache]);

  /* Saved on every keystroke — there is no Save button here, so a half-typed
     path must never be the reason generation is still broken after a restart.
     The probe is deliberately NOT per keystroke: it touches the disk and loads
     the engine library. It runs when a field is left or a path is picked. */
  const update = (id: EnginePathId, value: string) => {
    setTemplateSettings((current) => {
      const next = {
        ...current,
        templates: current.templates.map((template) => template.id === selectedTemplate.id
          ? updateWeightPath(template, id, value)
          : template),
      };
      saveGeneratorTemplateSettings(next);
      return next;
    });
  };

  useEffect(() => { probe(settings); }, [probe, editingTemplateId, templateSettings.defaultTemplateId, downloadState?.completed, downloadedPathsKey]);

  const updateSources = (id: EnginePathId, sources: WeightSource[]) => {
    const current = loadGeneratorTemplateSettings();
    const next = { ...current, templates: current.templates.map((template) => {
      if (template.id !== selectedTemplate.id) return template;
      const path = template.paths[id];
      const nextPath = !path || isDownloadUrl(path) ? (sources.find((source) => source.url === path)?.url ?? sources[0]?.url ?? "") : path;
      return { ...template, paths: { ...template.paths, [id]: nextPath }, sources: { ...template.sources, [id]: sources } };
    }) };
    saveGeneratorTemplateSettings(next);
    setTemplateSettings(next);
  };

  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab, editingTemplateId, editingLoraId]);

  const browse = async (field: EnginePathField) => {
    setError(null);
    try {
      const picked = await chooseEnginePath(field);
      if (!picked) return;
      update(field.id, picked);
      probe({ ...settings, [field.id]: picked });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const clearAll = () => {
    setTemplateSettings((current) => {
      const next = {
        ...current,
        templates: current.templates.map((template) => template.id === selectedTemplate.id
          ? { ...template, paths: { ...EMPTY_ENGINE_SETTINGS }, sources: {} }
          : template),
      };
      saveGeneratorTemplateSettings(next);
      return next;
    });
    probe({ ...EMPTY_ENGINE_SETTINGS });
  };

  const updateTemplate = (updates: Partial<Pick<typeof selectedTemplate, "name" | "defaultSteps" | "attention" | "motionCache" | "loras" | "mode" | "additionalSafetensors">>) => {
    setTemplateSettings((current) => {
      const next = {
        ...current,
        templates: current.templates.map((template) => template.id === selectedTemplate.id ? { ...template, ...updates } : template),
      };
      saveGeneratorTemplateSettings(next);
      return next;
    });
  };

  const addTemplate = () => {
    const created = createGeneratorTemplate(`Generator ${templateSettings.templates.length + 1}`);
    setTemplateSettings((current) => {
      const next = { ...current, templates: [...current.templates, created] };
      saveGeneratorTemplateSettings(next);
      return next;
    });
    setEditingTemplateId(created.id);
  };

  const removeTemplate = (id: string) => {
    const template = templateSettings.templates.find((template) => template.id === id);
    if (template && (Object.values(template.sources ?? {}).some((sources) => sources.length > 0) || Boolean(template.additionalSafetensors?.length))) {
      void removeTemplateWeights(id).catch((reason) => setError(String(reason)));
      return;
    }
    if (templateSettings.templates.length <= 1) return;
    const remaining = templateSettings.templates.filter((template) => template.id !== id);
    const next: GeneratorTemplateSettings = {
      ...templateSettings,
      templates: remaining,
      defaultTemplateId: id === templateSettings.defaultTemplateId ? remaining[0].id : templateSettings.defaultTemplateId,
    };
    setTemplateSettings(next);
    saveGeneratorTemplateSettings(next);
    if (editingTemplateId === id) setEditingTemplateId(null);
  };

  const makeDefault = (id: string) => {
    if (templateSettings.templates.some((template) => template.id === id && templateNeedsDownload(template))) return;
    const next = { ...templateSettings, defaultTemplateId: id };
    setTemplateSettings(next);
    saveGeneratorTemplateSettings(next);
  };

  const missing = generatorPathFields(selectedTemplate).filter((field) => field.required && pathState(field, settings[field.id], status) !== "found");
  const selectTab = (id: TabId) => {
    setTab(id);
    setEditingTemplateId(null);
    setEditingLoraId(null);
  };

  const generatorEditor = <div className="generator-editor">
              {error && <p role="alert">{error}</p>}
              <div className="generator-template-fields">
                <label>
                  <span>Mode</span>
                  <select aria-label="Generator mode" value={selectedTemplate.mode ?? "prompt"}
                    onChange={(event) => updateTemplate({ mode: event.target.value === "animate" ? "animate" : "prompt" })}>
                    <option value="prompt">Text prompt</option>
                    <option value="animate">Animate (reference video)</option>
                  </select>
                </label>
                <label>
                  <span>Name</span>
                  <input aria-label="Generator name" value={selectedTemplate.name} onChange={(event) => updateTemplate({ name: event.target.value })} onBlur={() => { if (!selectedTemplate.name.trim()) updateTemplate({ name: "Untitled generator" }); }} />
                </label>
                <label>
                  <span>Default steps</span>
                  <input aria-label="Generator default steps" type="number" min={2} max={MAX_GENERATION_STEPS} step={1} value={selectedTemplate.defaultSteps} onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 2 && value <= MAX_GENERATION_STEPS) updateTemplate({ defaultSteps: value });
                  }} />
                </label>
                <label>
                  <span>Attention</span>
                  <select aria-label="Generator attention" value={selectedTemplate.attention} onChange={(event) => updateTemplate({ attention: event.target.value as AttentionMode })}>
                    <option value="exact">Exact attention</option>
                    <option value="flash2">Flash attention</option>
                    <option value="sage2">Sage attention</option>
                  </select>
                </label>
              </div>
              <label className="lora-toggle">
                <input type="checkbox" aria-label="Enable MotionCache" aria-describedby="motion-cache-help"
                  checked={selectedTemplate.mode !== "animate" && Boolean(selectedTemplate.motionCache)} disabled={selectedTemplate.mode === "animate"}
                  onChange={(event) => updateTemplate({ motionCache: event.target.checked })} />
                Enable MotionCache
              </label>
              <p id="motion-cache-help">{selectedTemplate.mode === "animate" ? "MotionCache is unavailable in Animate mode." : "Reuses similar denoising results to reduce computation. May affect detail and motion; short generations may not reuse any steps."}</p>
              <div className={`settings-status settings-status--${status?.state ?? "checking"}`} role="status">
                <span><i />{engineHeadline(status, desktop)}</span>
                <p>{engineDetail(status, desktop, missing.length)}</p>
                {status?.platform && <small className="settings-status__platform"><b>Platform</b>{status.platform}</small>}
              </div>
              {generatorPathFields(selectedTemplate).map((field) => {
                const value = settings[field.id];
                const state = pathState(field, value, status);
                return (
                  <div className={`settings-path settings-path--${state}`} key={field.id}>
                    <label htmlFor={`engine-${field.id}`}>
                      <b>{field.label}{!field.required && <em>Optional</em>}</b>
                    </label>
                    <div className="settings-path__row">
                      <input
                        id={`engine-${field.id}`}
                        value={value}
                        spellCheck={false}
                        placeholder={field.directory ? "Folder on this computer or download URL" : "Local path or download URL"}
                        disabled={Boolean(downloading)}
                        onChange={(event) => update(field.id, event.target.value)}
                        onBlur={() => probe(settings)}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void browse(field)}
                        disabled={!desktop || Boolean(downloading)}
                        title={desktop ? `Browse for ${field.label}` : "Browsing for files is available in the desktop app"}
                      >
                        <FolderSearch size={16} /> Browse
                      </button>
                      <span className="settings-path__state">
                        {state === "found" ? <Check size={14} aria-hidden="true" /> : state === "missing" ? <AlertCircle size={14} aria-hidden="true" /> : null}
                        {stateLabel[state]}
                      </span>
                    </div>
                    {showAdvancedOptions && <WeightSourcesEditor label={field.label} sources={selectedTemplate.sources?.[field.id] ?? []} disabled={Boolean(downloading)} onChange={(sources) => updateSources(field.id, sources)} />}
                  </div>
                );
              })}
              <AdditionalSafetensorsEditor key={selectedTemplate.id} value={selectedTemplate.additionalSafetensors ?? []} disabled={Boolean(downloading)} animate={selectedTemplate.mode === "animate"} onChange={(additionalSafetensors) => updateTemplate({ additionalSafetensors })} />
              <TemplateLorasEditor value={selectedTemplate.loras ?? []} onChange={(loras) => updateTemplate({ loras })} />
              <label className="generator-editor__advanced">
                <input type="checkbox" checked={showAdvancedOptions} onChange={(event) => setShowAdvancedOptions(event.target.checked)} />
                <span>Show advanced options</span>
              </label>
            </div>;
  const downloadStatus = downloadState && <div className="weight-download-status" role="status">
          <span>{downloadState.name ?? templateSettings.templates.find((template) => template.id === downloadState.templateId)?.name}: {downloadState.error ?? (downloadState.active ? downloadState.phase === "preparing" ? "Preparing LoRA…" : `${downloadState.completed}/${downloadState.files} files · ${(downloadState.downloaded / 1024 ** 3).toFixed(2)} GB${downloadState.total ? ` / ${(downloadState.total / 1024 ** 3).toFixed(2)} GB` : ""}` : downloadState.preparePath ? "LoRA prepared" : "Download complete")}</span>
          {downloadState.active && downloadState.phase !== "preparing" && <button type="button" className="secondary-button" onClick={() => void cancelWeightDownload().catch((reason) => setError(String(reason)))}>Cancel download</button>}
          {downloadState.error && <button type="button" className="secondary-button" onClick={() => void retryWeightDownload()}>{downloadState.phase === "preparing" ? "Retry preparation" : "Retry download"}</button>}
        </div>;
  const generatorFooter = <>{downloadStatus}<footer className="settings-view__foot">
          {/* Clearing the paths is an engine action, so it is only offered
              beside them. */}
          <button className="secondary-button" disabled={Boolean(downloading)} onClick={clearAll}><RotateCcw size={16} /> Clear generator paths</button>
          {templateNeedsDownload(selectedTemplate) && <button type="button" className="primary-button" disabled={!desktop || downloadState?.active} onClick={() => void downloadTemplateWeights(selectedTemplate.id)}><Download size={16} /> Download weights</button>}
        </footer></>;

  return (
    <>
    <main aria-hidden={editingTemplateId ? true : undefined} className="settings-view" ref={page} tabIndex={-1} aria-labelledby="settings-heading" onKeyDown={(event) => {
      // The mounted editor must not receive shortcuts while Settings has focus.
      event.stopPropagation();
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    }}>
        <header className="settings-view__head">
          <button type="button" className="icon-button icon-button--strong" onClick={onClose} aria-label="Close settings" title="Back"><ArrowLeft size={18} /></button>
          <h1 id="settings-heading">Settings</h1>
        </header>

        <aside className="settings-sidebar" aria-label="Settings navigation">
        <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
          {TABS.map((item, index) => (
            <button
              key={item.id}
              id={`settings-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={tab === item.id}
              aria-controls={`settings-panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              className={tab === item.id ? "active" : ""}
              onClick={() => selectTab(item.id)}
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = TABS[event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1
                  : (index + (event.key === "ArrowDown" ? 1 : TABS.length - 1)) % TABS.length];
                selectTab(next.id);
                document.getElementById(`settings-tab-${next.id}`)?.focus();
              }}
            >
              {item.label}
              {/* What is wrong stays visible from the other tab: a count here
                  is the whole reason someone opens this screen. */}
              {item.id === "engine" && missing.length > 0 && <em title={`${missing.length} model ${missing.length === 1 ? "path" : "paths"} still to set`}>{missing.length}</em>}
            </button>
          ))}
        </div>
        </aside>

        <div className="settings-view__content">
        <div className="settings-view__body" ref={body}>
          {tab === "engine" && editingLoraId && <button type="button" className="secondary-button generator-editor__back" onClick={() => { setEditingTemplateId(null); setEditingLoraId(null); }}><ChevronLeft size={16} /> Generators</button>}
          {tab === "updates" && <section className="settings-section" id="settings-panel-updates" role="tabpanel" aria-labelledby="settings-tab-updates">
            {updates ?? <p>Updates are available in the desktop app.</p>}
          </section>}
          {tab === "llms" && <section
            className="settings-section"
            id="settings-panel-llms"
            role="tabpanel"
            aria-labelledby="settings-tab-llms"
          >
            <PromptLlmSetting desktop={desktop} />
          </section>}

          {tab === "appearance" && <section
            className="settings-section"
            id="settings-panel-appearance"
            role="tabpanel"
            aria-labelledby="settings-tab-appearance"
          >
            <AppearanceSetting />
          </section>}

          {tab === "diagnostics" && <section
            className="settings-section"
            id="settings-panel-diagnostics"
            role="tabpanel"
            aria-labelledby="settings-tab-diagnostics"
          >
            <DiagnosticsSetting desktop={desktop} status={status} onBackendChange={() => probe(settings)} />
          </section>}

          {tab === "engine" && <section
            className="settings-section"
            id="settings-panel-engine"
            role="tabpanel"
            aria-labelledby="settings-tab-engine"
          >
            {!editingLoraId && <ReferenceIconSetting templates={templateSettings} />}
            {editingLoraId ? <LoraEditor key={editingLoraId} loraId={editingLoraId} onDone={() => setEditingLoraId(null)} /> : <>{generatorSections.filter((section) => section.id === "generators" || section.templates.length > 0).map((section) => <section key={section.id} className="generator-templates" aria-labelledby={`${section.id}-heading`}>
              <header>
                <div>
                  <h2 id={`${section.id}-heading`}>{section.title}</h2>
                  {section.id === "generators" && <p>Choose the generator used by default, or open one to edit its model setup.</p>}
                </div>
                {section.id === "generators" && <button type="button" className="secondary-button" onClick={addTemplate}><Plus size={16} /> New generator</button>}
              </header>
              <div className="generator-template-list" role="list" aria-label={section.title}>
                {section.templates.map((template) => (
                  <div className={`generator-template-item${templateNeedsDownload(template) ? " generator-template-item--download" : template.id === templateSettings.defaultTemplateId ? " generator-template-item--selected" : ""}`} role="listitem" key={template.id}>
                    {downloadState?.active && downloadState.templateId === template.id && downloadState.phase !== "preparing" && <span
                      className="generator-template-item__progress"
                      role="progressbar"
                      aria-label={`Downloading ${template.name} weights`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.floor(downloadPercent)}
                      aria-valuetext={`${downloadState.completed} of ${downloadState.files} files complete${downloadState.total ? `; current file ${Math.floor(100 * downloadState.downloaded / downloadState.total)}%` : "; downloading"}`}
                      style={{ width: `${downloadPercent}%` }}
                    />}
                    {!templateNeedsDownload(template) && <label className="generator-template-item__default" title="Use this generator for generation by default">
                      <input type="radio" name="default-generator-template" checked={template.id === templateSettings.defaultTemplateId} onChange={() => makeDefault(template.id)} aria-label={`Use ${template.name} as the default generator`} />
                    </label>}
                    <button type="button" className="generator-template-item__open" onClick={() => setEditingTemplateId(template.id)} aria-label={`Edit ${template.name} generator`}>
                      <Video size={16} aria-hidden="true" />
                      <b>{template.name}</b><small>{downloadState?.active && downloadState.templateId === template.id ? downloadState.phase === "preparing" ? "Preparing LoRA…" : `Downloading · ${Math.floor(downloadPercent)}%` : templateSummary(template)}</small>
                    </button>
                    {templateNeedsDownload(template)
                      ? <button type="button" className="icon-button" disabled={!desktop || downloadState?.active} onClick={() => void downloadTemplateWeights(template.id)} aria-label={`Download generator ${template.name}`} title={`Download ${template.name} weights`}>
                        {downloadState?.active && downloadState.templateId === template.id ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
                      </button>
                      : <button type="button" className="icon-button" disabled={Boolean(downloadState?.active) || ((Object.values(template.sources ?? {}).some((sources) => sources.length) || Boolean(template.additionalSafetensors?.length)) ? !desktop : templateSettings.templates.length === 1)} onClick={() => removeTemplate(template.id)} aria-label={(Object.values(template.sources ?? {}).some((sources) => sources.length) || Boolean(template.additionalSafetensors?.length)) ? `Remove downloaded weights for ${template.name}` : `Remove generator ${template.name}`} title={(Object.values(template.sources ?? {}).some((sources) => sources.length) || Boolean(template.additionalSafetensors?.length)) ? `Remove ${template.name} weights and keep the template` : `Remove ${template.name}`}><Trash2 size={15} /></button>}
                  </div>
                ))}
              </div>
            </section>)}<LoraLibrary onAdd={() => setEditingLoraId(`lora-${crypto.randomUUID()}`)} onEdit={setEditingLoraId} /></>}
          </section>}
        </div>

        {tab === "engine" && downloadStatus}


        {error && <div className="toast" role="alert"><strong>Couldn’t update generator settings</strong><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
      </div>
    </main>
    {editingTemplateId && <GeneratorTemplateDialog onClose={() => setEditingTemplateId(null)} footer={generatorFooter}>{generatorEditor}</GeneratorTemplateDialog>}
    </>
  );
}

const engineHeadline = (status: SlopfabStatus | null, desktop: boolean) => {
  if (!desktop) return "Browser preview";
  if (!status) return "Checking this computer…";
  switch (status.state) {
    case "ready": return "Engine ready";
    case "modelsMissing": return "Model files missing";
    case "runtimeMissing": return "Engine missing from this install";
    case "incompatible": return "Engine version not supported";
    case "demo": return "Browser preview";
  }
};

const engineDetail = (status: SlopfabStatus | null, desktop: boolean, missing: number) => {
  if (!desktop) return "Paths are saved here, but only the desktop app can check them or render with them.";
  if (!status) return "Looking for the engine and the model files.";
  if (status.state === "runtimeMissing") return `${status.detail} slopfab.dll should sit next to Slopus.exe.`;
  if (status.state === "ready") return "Everything Slopus needs to render a shot is in place.";
  if (missing > 0) return `${status.detail} ${missing === 1 ? "One path" : `${missing} paths`} still need setting below.`;
  return status.detail;
};
