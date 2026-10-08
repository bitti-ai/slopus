import { AdditionalSafetensorsEditor } from "./AdditionalSafetensorsEditor";
import { GeneratorSharing } from "./GeneratorSharing";
import { OtherWeightsSettings } from "./OtherWeightsSettings";
import { AgentDock } from "./workspace/AgentDock";
import { useAgentPane } from "../lib/useAgentPane";
import { useShortcut } from "../lib/commands";
import { executeGeneratorCommands, type GeneratorCommand } from "../lib/agentGenerators";
import {
  Add20, Agent16, Agent16Filled, Agent20, Back16, Check14, Check16, Check20, ChevronRight20, Delete16, Diagnostics16,
  Diagnostics16Filled, Download16, Download20, Error16, Error20, Flash20, Folder20, Gauge20, Gpu20, Image20, ModelFile20, More16,
  Options20, Palette16, Palette16Filled, Palette20, Refresh16, Refresh16Filled, Rename20, Reset16, Sparkle20, Spinner16,
  Spinner20, Steps20, TextFile20, Video16, Video16Filled, Video20, Worker16, Worker16Filled,
} from "./ui/icons";
import { WorkersSetting } from "./WorkersSettings";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { revealDiagnosticLog } from "../lib/diagnostics";
import { isTauri } from "../lib/persistence";
import { WeightSourcesEditor } from "./WeightSourcesEditor";
import { LoraEditor, LoraLibrary, TemplateLorasEditor } from "./LoraSettings";
import { OpenableCard } from "./OpenableCard";
import { TitleBar } from "./TitleBar";
import { downloadableTemplateLoras, loadLoras } from "../lib/loras";
import { retryWeightDownload } from "../lib/weightDownloads";
import { getQueuedWeightDownloads, cancelWeightDownload, downloadTemplateWeights, getWeightDownloadState, refreshDownloadedWeights, removeTemplateWeights, subscribeWeightDownloads, updateWeightPath, weightDownloadProgress, type DownloadState } from "../lib/weightDownloads";
import { CHECKING_PROVIDERS, chooseEnginePath, getAgentModels, getEngineStatus, type ProviderStatus, type ModelStatus, type SlopfabStatus } from "../lib/runtime";
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
import { createProjectConfig, MAX_GENERATION_STEPS } from "../lib/project";
import { availableReferenceIconGenerators, loadReferenceIconAutomation, loadReferenceIconGeneratorId, referenceIconGenerator, saveReferenceIconAutomation, saveReferenceIconGeneratorId, subscribeReferenceIconAutomation } from "../lib/referenceIconSettings";
import { applyTheme, loadTheme, saveTheme, type ThemeChoice } from "../lib/theme";
import { runtimeLocationHint } from "../lib/platform";
import {
  ComboBox, ContextMenu, InfoBadge, InfoBar, NavItem, NavPane, ProgressBar, SettingsCard, SettingsExpander, SettingsGroup, SettingsRow,
  Splitter, TextField, ToggleSwitch, type InfoBarSeverity,
} from "./ui";

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
  missing: "Not found",
  download: "Download required",
};

/* Paths are long and the file name is the part that tells them apart, so the
   middle goes, not the end (Explorer does the same in narrow columns). */
export function middleEllipsis(text: string, max = 64): string {
  if (text.length <= max) return text;
  const tail = Math.ceil(max * 0.6);
  return `${text.slice(0, max - tail - 1)}…${text.slice(-tail)}`;
}

function templateSummary(template: GeneratorTemplate): string {
  const loras = downloadableTemplateLoras(template.loras);
  const pendingModels = generatorPathFields(template).some(({ id }) => isDownloadUrl(template.paths[id])
    || (!template.paths[id].trim() && (template.sources?.[id]?.length ?? 0) > 0));
  return `${template.defaultSteps} steps${loras.length && !pendingModels ? ` · Needs ${loras.map(({ name }) => name).join(", ")} LoRA${loras.length > 1 ? "s" : ""}` : ""}`;
}

const hasDownloadedWeights = (template: GeneratorTemplate) =>
  Object.values(template.sources ?? {}).some((sources) => sources.length > 0) || Boolean(template.additionalSafetensors?.length);

/* --- Shared pieces ---------------------------------------------------------- */

/* The one line that says what the weight downloader is doing, with its
   Cancel / Retry. It sits at the top of the page it concerns. */
function DownloadStatus({ state, templateName, onError }: { state: DownloadState; templateName?: string; onError: (message: string) => void }) {
  const text = state.error ?? (state.active
    ? state.phase === "preparing" ? "Preparing LoRA…"
      : `${state.completed}/${state.files} files · ${(state.downloaded / 1024 ** 3).toFixed(2)} GB${state.total ? ` / ${(state.total / 1024 ** 3).toFixed(2)} GB` : ""}`
    : state.preparePath ? "LoRA prepared" : "Download complete");
  return <div className="ui-settings-card settings-download-status" role="status">
    <span className="ui-settings-card__icon" aria-hidden="true">{state.error ? <Error20 /> : state.active ? <Download20 /> : <Check20 />}</span>
    <span className="ui-settings-card__text">
      <span className="ui-settings-card__header">{state.name ?? templateName}</span>
      <span className="ui-settings-card__description">{text}</span>
    </span>
    <span className="ui-settings-card__control">
      {state.active && state.phase !== "preparing" && <button type="button" className="secondary-button" onClick={() => void cancelWeightDownload().catch((reason) => onError(String(reason)))}>Cancel download</button>}
      {state.error && <button type="button" className="secondary-button" onClick={() => void retryWeightDownload()}>{state.phase === "preparing" ? "Retry preparation" : "Retry download"}</button>}
    </span>
  </div>;
}

/* --- Generator page: reference icons ------------------------------------------ */

function ReferenceIconSetting({ templates }: { templates: GeneratorTemplateSettings }) {
  const automation = useSyncExternalStore(subscribeReferenceIconAutomation, loadReferenceIconAutomation);
  const chosenId = useSyncExternalStore(subscribeReferenceIconAutomation, loadReferenceIconGeneratorId);
  const available = availableReferenceIconGenerators(templates);
  const selected = referenceIconGenerator(templates, chosenId);
  return <SettingsGroup heading="Reference icons">
    <SettingsCard icon={<Sparkle20 />} header="Automatic reference icon generation">
      <ToggleSwitch checked={automation !== "disabled"} aria-label="Automatic reference icon generation" onChange={(on) => saveReferenceIconAutomation(on ? "ask" : "disabled")} />
    </SettingsCard>
    <SettingsCard icon={<Image20 />} header="Reference icon generator">
      <ComboBox aria-label="Reference icon generator" disabled={!available.length} value={selected?.id ?? ""} placeholder="No available generators"
        onChange={saveReferenceIconGeneratorId} options={available.map((template) => ({ value: template.id, label: template.name }))} />
    </SettingsCard>
  </SettingsGroup>;
}

/* --- Appearance ------------------------------------------------------------------- */

const themeOptions: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Use system setting" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function AppearanceSetting() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveTheme(next);
    applyTheme(next);
  };
  return <SettingsCard icon={<Palette20 />} header="App theme" description="Select which app theme to display">
    <ComboBox aria-label="App theme" value={choice} onChange={pick} options={themeOptions} />
  </SettingsCard>;
}

/* --- Agents ------------------------------------------------------------------------ */

const endpointProviders: { id: EndpointProviderId; label: string; detail: string; icon: ReactNode; endpointPlaceholder: string; keyRequired: boolean }[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    detail: "Use models from openrouter.ai through its OpenAI-compatible API.",
    icon: <Agent20 />,
    endpointPlaceholder: "https://openrouter.ai/api/v1",
    keyRequired: true,
  },
  {
    id: "local",
    label: "Local OpenAI-compatible",
    detail: "Use a server on this computer or network that implements /models and /chat/completions.",
    icon: <Gpu20 />,
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
      if (found.length === 0) setErrors((current) => ({ ...current, [id]: "The endpoint returned no models. You can still enter a model ID." }));
    } catch (reason) {
      setErrors((current) => ({ ...current, [id]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setLoading(null);
    }
  };

  return <SettingsGroup heading="Providers">
    <p className="settings-caption">Configured providers appear in Slop’s agent list. Endpoints and API keys stay on this computer.</p>
    {endpointProviders.map((provider) => {
      const value = settings[provider.id];
      const configured = isEndpointProviderConfigured(provider.id, value);
      const listId = `llm-models-${provider.id}`;
      return <SettingsExpander key={provider.id} className="llm-provider" icon={provider.icon} header={provider.label} description={provider.detail}
        control={<span className="llm-provider__status">{configured ? <><Check14 aria-hidden="true" /> Configured</> : "Not configured"}</span>}>
        <SettingsRow header="Endpoint">
          <TextField className="settings-field" aria-label={`${provider.label} endpoint`} value={value.endpoint} spellCheck={false} placeholder={provider.endpointPlaceholder} onChange={(next) => update(provider.id, "endpoint", next)} />
        </SettingsRow>
        <SettingsRow header="API key" description={provider.keyRequired ? undefined : "Optional"}>
          <TextField className="settings-field" type="password" aria-label={`${provider.label} API key`} value={value.apiKey} autoComplete="off" spellCheck={false} placeholder={provider.keyRequired ? "Required" : "Leave blank if not required"} onChange={(next) => update(provider.id, "apiKey", next)} />
        </SettingsRow>
        <SettingsRow header="Model">
          <TextField className="settings-field" list={listId} aria-label={`${provider.label} model`} value={value.model} spellCheck={false} placeholder="Select or enter a model ID" onChange={(next) => update(provider.id, "model", next)} />
          <datalist id={listId}>{models[provider.id].map((model) => <option value={model} key={model} />)}</datalist>
          <button type="button" className="secondary-button" disabled={!desktop || !value.endpoint.trim() || loading === provider.id} onClick={() => void discover(provider.id)} data-tooltip={desktop ? "Load models from this endpoint" : "Model discovery is available in the desktop app"}>
            {loading === provider.id ? <Spinner16 className="spin" /> : <Refresh16 />} Load models
          </button>
        </SettingsRow>
        {errors[provider.id] && <div className="settings-expander-message"><InfoBar severity="error" message={errors[provider.id]} /></div>}
      </SettingsExpander>;
    })}
  </SettingsGroup>;
}

/* --- Diagnostics ------------------------------------------------------------------- */

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

  return <SettingsGroup>
    <SettingsCard icon={<Gpu20 />} header="GPU backend">
      <ComboBox aria-label="GPU backend" value={cudaAvailable ? backend : "vulkan"} disabled={!desktop || !cudaAvailable} onChange={(value) => {
        const next = value as InferenceBackend;
        saveInferenceBackend(next);
        setBackend(next);
        onBackendChange();
      }} options={[...(cudaAvailable ? [{ value: "cuda", label: "CUDA" }] : []), { value: "vulkan", label: "Vulkan" }]} />
    </SettingsCard>
    <SettingsCard icon={<Options20 />} header="Enable debug options" description="Show Debug Prompt in scene settings and the image inspector, and Debug Icon Prompt in reference details">
      <ToggleSwitch checked={debugEnabled} aria-label="Enable debug options" onChange={saveDebugOptionsEnabled} />
    </SettingsCard>
    <SettingsCard icon={opening ? <Spinner20 className="spin" /> : <TextFile20 />} header="Show log file" actionIcon="external" disabled={!desktop || opening} onClick={() => void reveal()} />
    {error && <InfoBar severity="error" title="Couldn’t show the log file" message={error} onClose={() => setError(null)} />}
  </SettingsGroup>;
}

/* --- The page ------------------------------------------------------------------------ */

const TABS = [
  { id: "engine", label: "Generator", icon: Video16, selectedIcon: Video16Filled },
  { id: "workers", label: "Workers", icon: Worker16, selectedIcon: Worker16Filled },
  { id: "llms", label: "Agents", icon: Agent16, selectedIcon: Agent16Filled },
  { id: "appearance", label: "Appearance", icon: Palette16, selectedIcon: Palette16Filled },
  { id: "diagnostics", label: "Diagnostics", icon: Diagnostics16, selectedIcon: Diagnostics16Filled },
  { id: "updates", label: "Updates", icon: Refresh16, selectedIcon: Refresh16Filled },
] as const;
type TabId = (typeof TABS)[number]["id"];

const engineSeverity = (status: SlopfabStatus | null, desktop: boolean): InfoBarSeverity => {
  if (!desktop || !status || status.state === "demo") return "informational";
  if (status.state === "ready") return "success";
  if (status.state === "runtimeMissing") return "error";
  return "warning";
};

/* Settings is a page of the app window, below the title bar the shell draws:
   a 280px navigation pane with Back at its top, and a content column that
   reads like Windows Settings — a 28px title (a breadcrumb on sub-pages) over
   groups of one-setting-per-row cards. */
export interface SettingsNavigation { templateId: string; loraId?: string }

export function SettingsView({ onClose, updates, initialTab = "engine", titleBarActions, navigation, providers = CHECKING_PROVIDERS }: {
  onClose: () => void; updates?: ReactNode; initialTab?: TabId;
  /** App-wide title-bar buttons (the work queue), after Settings' own. */
  titleBarActions?: ReactNode;
  navigation?: SettingsNavigation;
  providers?: ProviderStatus[];
}) {
  /* The engine first: this screen exists because those paths have to be set
     before anything can be rendered. */
  const [tab, setTab] = useState<TabId>(initialTab);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const agentPane = useAgentPane("settings.agent");
  const agentToggle = useRef<HTMLButtonElement>(null);
  const agentPaneRef = useRef<HTMLElement>(null);
  const [agentRecord] = useState(() => ({ folderPath: "", config: createProjectConfig({
    name: "Settings", prompt: "", aspectRatio: "16:9", resolution: "768p", targetDurationSeconds: 30,
  }) }));
  const toggleAgent = () => {
    setAgentOpen(!agentOpen);
    if (!agentOpen) requestAnimationFrame(() => (agentPaneRef.current?.querySelector<HTMLElement>("textarea:not(:disabled)")
      ?? agentPaneRef.current?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus());
    else if (agentPaneRef.current?.contains(document.activeElement)) agentToggle.current?.focus();
  };
  useShortcut("Ctrl+Shift+A", toggleAgent, { allowInInput: true });
  const page = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const subpageHeading = useRef<HTMLHeadingElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const returnFocus = useRef<string | null>(null);
  const focusName = useRef(false);
  useEffect(() => { page.current?.focus(); }, []);
  const [templateSettings, setTemplateSettings] = useState<GeneratorTemplateSettings>(() => loadGeneratorTemplateSettings());
  const downloadState = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const queuedDownloads = useSyncExternalStore(subscribeWeightDownloads, getQueuedWeightDownloads);
  const downloadPercent = downloadState ? weightDownloadProgress(downloadState) : 0;
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [editingLoraId, setEditingLoraId] = useState<string | null>(null);
  useEffect(() => {
    if (!navigation) return;
    setTab("engine");
    setEditingTemplateId(loadGeneratorTemplateSettings().templates.some((template) => template.id === navigation.templateId) ? navigation.templateId : null);
    setEditingLoraId(navigation.loraId && loadLoras().some((lora) => lora.id === navigation.loraId) ? navigation.loraId : null);
  }, [navigation]);
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);
  const [editingPath, setEditingPath] = useState<EnginePathId | null>(null);
  const [pathMenu, setPathMenu] = useState<{ field: EnginePathField; anchor: HTMLElement } | null>(null);
  const [status, setStatus] = useState<SlopfabStatus | null>(null);
  const probeRevision = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();

  const defaultTemplate = defaultGeneratorTemplate(templateSettings);
  const editingTemplate = templateSettings.templates.find((template) => template.id === editingTemplateId);
  const selectedTemplate = editingTemplate ?? defaultTemplate;
  const settings = selectedTemplate.paths;
  const downloadedPathsKey = JSON.stringify(Object.values(selectedTemplate.sources ?? {}).flatMap((sources) => sources.map(({ downloadedPath }) => downloadedPath)));
  const downloading = downloadState?.active && downloadState.templateId === selectedTemplate.id;
  const generatorSections = [
    { id: "generators", title: "Generators", templates: templateSettings.templates.filter((template) => !templateNeedsDownload(template)) },
    { id: "downloadable-generators", title: "Available to download", templates: templateSettings.templates.filter(templateNeedsDownload) },
  ];

  useEffect(() => { setShowAdvancedOptions(false); setEditingPath(null); setPathMenu(null); }, [editingTemplateId]);

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
    void getEngineStatus(paths, selectedTemplate.attention, selectedTemplate.loras ?? [], selectedTemplate.mode ?? "prompt", selectedTemplate.additionalSafetensors ?? [], selectedTemplate.motionCache ?? false, selectedTemplate.sources).then((next) => {
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

  /* A new page opens at its top; a sub-page takes focus on its title (or on
     the name of a generator that was just created), and going back returns
     focus to the card that opened it. */
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab, editingTemplateId]);
  useEffect(() => {
    if (editingTemplateId) {
      if (focusName.current) { focusName.current = false; nameField.current?.focus(); nameField.current?.select(); }
      else subpageHeading.current?.focus();
      return;
    }
    const ref = returnFocus.current;
    returnFocus.current = null;
    if (ref) [...(body.current?.querySelectorAll<HTMLElement>("[data-open-ref]") ?? [])].find((element) => element.dataset.openRef === ref)?.focus();
  }, [editingTemplateId]);

  const openTemplate = (id: string) => { returnFocus.current = `template:${id}`; setEditingTemplateId(id); };
  const leaveTemplate = () => setEditingTemplateId(null);

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
    focusName.current = true;
    returnFocus.current = `template:${created.id}`;
    setEditingTemplateId(created.id);
  };

  const removeTemplate = (id: string) => {
    const template = templateSettings.templates.find((template) => template.id === id);
    if (template && hasDownloadedWeights(template)) {
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
  const back = () => { if (editingTemplateId) leaveTemplate(); else onClose(); };

  const downloadStatus = downloadState && <DownloadStatus state={downloadState} onError={setError}
    templateName={templateSettings.templates.find((template) => template.id === downloadState.templateId)?.name} />;

  const pathCard = (field: EnginePathField) => {
    const value = settings[field.id];
    const state = pathState(field, value, status);
    const fieldDownload = downloading && downloadState?.field === field.id ? downloadState : null;
    const filePercent = fieldDownload?.total ? Math.floor(100 * fieldDownload.downloaded / fieldDownload.total) : undefined;
    const editing = editingPath === field.id;
    const description = editing
      ? <input
          id={`engine-${field.id}`}
          className="text-field settings-path__input"
          aria-label={field.label}
          value={value}
          spellCheck={false}
          autoFocus
          placeholder={field.directory ? "Folder on this computer or download URL" : "Local path or download URL"}
          onChange={(event) => update(field.id, event.target.value)}
          onBlur={() => { probe(settings); setEditingPath(null); }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
        />
      : fieldDownload
        ? <>{filePercent === undefined ? "Downloading…" : `Downloading · ${filePercent}%`}<ProgressBar className="settings-progress" value={filePercent} aria-label={`Downloading ${field.label}`} /></>
        : value.trim() ? <span className="settings-path__value" data-tooltip={value}>{middleEllipsis(value)}</span> : "Not set";
    return <div className={`settings-path settings-path--${state}`} key={field.id}>
      <SettingsCard
        icon={field.directory ? <Folder20 /> : <ModelFile20 />}
        header={<>{field.label}{!field.required && <span className="settings-path__optional"> (optional)</span>}</>}
        description={description}
      >
        {state !== "unset" && <span className="settings-path__state" data-tooltip={state === "found" ? "Found" : undefined}>
          {state === "found" ? <Check16 aria-hidden="true" /> : state === "missing" ? <Error16 aria-hidden="true" /> : null}
          <span className={state === "found" ? "sr-only" : undefined}>{stateLabel[state]}</span>
        </span>}
        <button type="button" className="secondary-button" onClick={() => void browse(field)} disabled={!desktop || Boolean(downloading)}
          aria-label={`Browse for ${field.label}`} data-tooltip={desktop ? undefined : "Browsing for files is available in the desktop app"}>
          Browse…
        </button>
        <button type="button" className="icon-button" aria-label={`More options for ${field.label}`} data-tooltip="More options" aria-haspopup="menu"
          disabled={Boolean(downloading)} onClick={(event) => setPathMenu({ field, anchor: event.currentTarget })}>
          <More16 />
        </button>
      </SettingsCard>
      {showAdvancedOptions && <WeightSourcesEditor label={field.label} sources={selectedTemplate.sources?.[field.id] ?? []} disabled={Boolean(downloading)} onChange={(sources) => updateSources(field.id, sources)} />}
    </div>;
  };

  const generatorEditor = editingTemplate && <>
    <GeneratorSharing key={`sharing:${selectedTemplate.id}`} templates={[selectedTemplate]}>{({ exportButton }) => <div className="settings-page__actions">
      {templateNeedsDownload(selectedTemplate) && <button type="button" className="primary-button" disabled={!desktop || downloading || queuedDownloads.some((item) => item.templateId === selectedTemplate.id)} onClick={() => void downloadTemplateWeights(selectedTemplate.id)}><Download16 /> {queuedDownloads.some((item) => item.templateId === selectedTemplate.id) ? "Queued for download" : "Download weights"}</button>}
      <button type="button" className="secondary-button" disabled={Boolean(downloading)} onClick={clearAll}><Reset16 /> Clear generator paths</button>
      <div className="settings-page__actions-end">{exportButton}</div>
    </div>}</GeneratorSharing>
    {downloadStatus}
    <InfoBar severity={engineSeverity(status, desktop)} title={engineHeadline(status, desktop)} message={<>
      {engineDetail(status, desktop, missing.length)}
      {status?.platform && <span className="settings-status__platform"> <b>Platform</b> <span>{status.platform}</span></span>}
    </>} />

    <SettingsGroup heading="General">
      <SettingsCard icon={<Rename20 />} header="Name">
        <input ref={nameField} className="text-field settings-field" aria-label="Generator name" value={selectedTemplate.name} onChange={(event) => updateTemplate({ name: event.target.value })} onBlur={() => { if (!selectedTemplate.name.trim()) updateTemplate({ name: "Untitled generator" }); }} />
      </SettingsCard>
      <SettingsCard icon={<Video20 />} header="Mode">
        <ComboBox aria-label="Generator mode" value={selectedTemplate.mode ?? "prompt"} onChange={(value) => updateTemplate({ mode: value === "animate" ? "animate" : "prompt" })}
          options={[{ value: "prompt", label: "Text prompt" }, { value: "animate", label: "Animate (reference video)" }]} />
      </SettingsCard>
      <SettingsCard icon={<Steps20 />} header="Default steps">
        <input className="text-field settings-field settings-field--number" aria-label="Generator default steps" type="number" min={2} max={MAX_GENERATION_STEPS} step={1} value={selectedTemplate.defaultSteps} onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isInteger(value) && value >= 2 && value <= MAX_GENERATION_STEPS) updateTemplate({ defaultSteps: value });
        }} />
      </SettingsCard>
    </SettingsGroup>

    <SettingsGroup heading="Performance">
      <SettingsCard icon={<Gauge20 />} header="Attention">
        <ComboBox aria-label="Generator attention" value={selectedTemplate.attention} onChange={(value) => updateTemplate({ attention: value as AttentionMode })}
          options={[{ value: "exact", label: "Exact attention" }, { value: "flash2", label: "Flash attention" }, { value: "sage2", label: "Sage attention" }]} />
      </SettingsCard>
      <SettingsCard icon={<Flash20 />} header="Enable MotionCache" description={<span id="motion-cache-help">{selectedTemplate.mode === "animate" ? "Unavailable in Animate mode" : "Reuses similar denoising results to reduce computation. May affect detail and motion."}</span>}>
        <ToggleSwitch aria-label="Enable MotionCache" aria-describedby="motion-cache-help"
          checked={selectedTemplate.mode !== "animate" && Boolean(selectedTemplate.motionCache)} disabled={selectedTemplate.mode === "animate"}
          onChange={(on) => updateTemplate({ motionCache: on })} />
      </SettingsCard>
    </SettingsGroup>

    <SettingsGroup heading="Model files">
      {generatorPathFields(selectedTemplate).map(pathCard)}
    </SettingsGroup>

    <AdditionalSafetensorsEditor key={selectedTemplate.id} value={selectedTemplate.additionalSafetensors ?? []} disabled={Boolean(downloading)} animate={selectedTemplate.mode === "animate"} onChange={(additionalSafetensors) => updateTemplate({ additionalSafetensors })} />
    <TemplateLorasEditor value={selectedTemplate.loras ?? []} onChange={(loras) => updateTemplate({ loras })} />

    <SettingsGroup heading="Advanced">
      <SettingsCard icon={<Options20 />} header="Show advanced options" description="Per-GPU download sources for each model file">
        <ToggleSwitch aria-label="Show advanced options" checked={showAdvancedOptions} onChange={setShowAdvancedOptions} />
      </SettingsCard>
    </SettingsGroup>
    {pathMenu && <ContextMenu aria-label={`${pathMenu.field.label} options`} position={{ anchor: pathMenu.anchor, placement: "bottom-end" }} onClose={() => setPathMenu(null)} items={[
      { id: "enter", label: "Enter path or URL…", onSelect: () => setEditingPath(pathMenu.field.id) },
      { id: "clear", label: "Clear", disabled: !settings[pathMenu.field.id], onSelect: () => { update(pathMenu.field.id, ""); probe({ ...settings, [pathMenu.field.id]: "" }); } },
    ]} />}
  </>;

  const generatorList = <>
    {downloadStatus}
    <ReferenceIconSetting templates={templateSettings} />
    {generatorSections.filter((section) => section.id === "generators" || section.templates.length > 0).map((section) => <SettingsGroup key={section.id} heading={section.title}>
      {section.id === "generators" && <GeneratorSharing templates={[]}>{({ importButton }) => <SettingsCard icon={<Add20 />} header="Add a generator" description="Choose the generator used by default, or open one to edit its model setup">
        {importButton}
        <button type="button" className="secondary-button" onClick={addTemplate}>New generator</button>
      </SettingsCard>}</GeneratorSharing>}
      <div className="settings-card-list" role="list" aria-label={section.title}>
        {section.templates.map((template) => {
          const needsDownload = templateNeedsDownload(template);
          const isDefault = template.id === templateSettings.defaultTemplateId;
          const active = downloadState?.active && downloadState.templateId === template.id;
          const queued = queuedDownloads.some((item) => item.templateId === template.id);
          const weights = hasDownloadedWeights(template);
          return <OpenableCard key={template.id} icon={<Video20 />} header={template.name} openRef={`template:${template.id}`}
            openLabel={`Edit ${template.name} generator`} onOpen={() => openTemplate(template.id)}
            description={queued ? "Queued for download" : active ? downloadState?.phase === "preparing" ? "Preparing LoRA…" : `Downloading · ${Math.floor(downloadPercent)}%`
              : `${!needsDownload && isDefault ? "Used by default · " : ""}${templateSummary(template)}`}
            progress={active && downloadState?.phase !== "preparing" && <ProgressBar className="settings-progress" value={downloadPercent} aria-label={`Downloading ${template.name} weights`} />}
            actions={needsDownload
              ? <button type="button" className="icon-button" disabled={!desktop || active || queued} onClick={() => void downloadTemplateWeights(template.id)} aria-label={`Download generator ${template.name}`} data-tooltip={`Download ${template.name} weights`}>
                {active ? <Spinner16 className="spin" /> : <Download16 />}
              </button>
              : <>
                {!isDefault && <button type="button" className="secondary-button" onClick={() => makeDefault(template.id)} aria-label={`Set ${template.name} as default`}>Set as default</button>}
                <button type="button" className="icon-button" disabled={Boolean(downloadState?.active) || (weights ? !desktop : templateSettings.templates.length === 1)} onClick={() => removeTemplate(template.id)}
                  aria-label={weights ? `Remove downloaded weights for ${template.name}` : `Remove generator ${template.name}`}
                  data-tooltip={weights ? "Remove weights and keep the template" : "Remove generator"}><Delete16 /></button>
              </>} />;
        })}
      </div>
    </SettingsGroup>)}
    <LoraLibrary onAdd={() => setEditingLoraId(`lora-${crypto.randomUUID()}`)} onEdit={setEditingLoraId} />
    <OtherWeightsSettings desktop={desktop} />
  </>;

  const current = TABS.find((item) => item.id === tab)!;

  return (
    <>
    {/* Back is the title bar's first button, as in the project window: it
        leaves a sub-page first, then Settings. */}
    <TitleBar
      title="Settings"
      leading={<button type="button" className="icon-button" onClick={back} aria-label="Back" data-tooltip="Back" data-tooltip-shortcut="Alt+Left" aria-keyshortcuts="Alt+ArrowLeft"><Back16 /></button>}
      actions={<>
        <button ref={agentToggle} type="button" className={`icon-button${agentOpen ? " icon-button--checked" : ""}${agentBusy ? " icon-button--busy" : ""}`}
          aria-label="Agent" aria-pressed={agentOpen} aria-busy={agentBusy} aria-controls="settings-agent"
          data-tooltip={`${agentOpen ? "Hide agent" : "Show agent"}${agentBusy ? " \u00b7 working" : ""}`} data-tooltip-shortcut="Ctrl+Shift+A" aria-keyshortcuts="Control+Shift+A"
          onClick={toggleAgent}>{agentOpen ? <Agent16Filled /> : <Agent16 />}</button>
        {titleBarActions}
      </>}
    />
    <div className={`app-screen__content settings-layout${agentOpen ? " settings-layout--agent" : ""}`} style={agentPane.style}>
    <main aria-hidden={editingLoraId ? true : undefined} className="settings-view" ref={page} tabIndex={-1} aria-label="Settings" onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
      // The mounted editor must not receive shortcuts while Settings has focus.
      // Allow Settings' Back and agent shortcuts through to the dispatcher.
      const agentShortcut = event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "a";
      if (!(event.altKey && event.key === "ArrowLeft") && !agentShortcut) event.stopPropagation();
      if (event.key !== "Escape" || event.defaultPrevented) return;
      back();
    }}>
      <NavPane aria-label="Settings sections" className="settings-nav">
        {TABS.map((item, index) => {
          const Icon = tab === item.id ? item.selectedIcon : item.icon;
          const count = item.id === "engine" ? missing.length : 0;
          return <NavItem
            key={item.id}
            id={`settings-tab-${item.id}`}
            icon={<Icon />}
            label={item.label}
            selected={tab === item.id}
            badge={count > 0 ? count : undefined}
            badgeSeverity="caution"
            aria-label={count > 0 ? `${item.label}, ${count} model ${count === 1 ? "path" : "paths"} to set` : undefined}
            data-tooltip={count > 0 ? `${count} model ${count === 1 ? "path" : "paths"} still to set` : undefined}
            onClick={() => selectTab(item.id)}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = TABS[event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : TABS.length - 1)) % TABS.length];
              selectTab(next.id);
              document.getElementById(`settings-tab-${next.id}`)?.focus();
            }}
          />;
        })}
      </NavPane>

      <div className="settings-view__body" ref={body}>
        <div className="settings-page" id={`settings-panel-${tab}`} aria-labelledby={editingTemplate ? "settings-subpage-heading" : "settings-page-heading"}>
          {editingTemplate
            ? <nav className="settings-breadcrumb" aria-label="Breadcrumb">
                <button type="button" className="settings-breadcrumb__link" onClick={leaveTemplate}>Generators</button>
                <ChevronRight20 aria-hidden="true" className="settings-breadcrumb__separator" />
                <h1 id="settings-subpage-heading" ref={subpageHeading} tabIndex={-1} aria-current="page">{editingTemplate.name || "Untitled generator"}</h1>
              </nav>
            : <h1 id="settings-page-heading" className="settings-page__title">{current.label}</h1>}

          {error && <InfoBar severity="error" title="Couldn’t update generator settings" message={error} onClose={() => setError(null)} closeLabel="Dismiss" />}

          {tab === "engine" && (editingTemplate ? generatorEditor : generatorList)}
          {tab === "workers" && <WorkersSetting desktop={desktop} />}
          {tab === "llms" && <PromptLlmSetting desktop={desktop} />}
          {tab === "appearance" && <AppearanceSetting />}
          {tab === "diagnostics" && <DiagnosticsSetting desktop={desktop} status={status} onBackendChange={() => probe(settings)} />}
          {tab === "updates" && (updates ?? <p className="settings-caption">Updates are available in the desktop app.</p>)}
        </div>
      </div>
    </main>
    {agentOpen && <Splitter {...agentPane.splitterProps} reverse aria-label="Resize agent pane" aria-controls="settings-agent" />}
    <aside ref={agentPaneRef} id="settings-agent" className="settings-agent-pane" aria-label="Agent" hidden={!agentOpen}>
      <AgentDock scope="settings" context="settings" record={agentRecord} providers={providers}
        onClose={() => { setAgentOpen(false); agentToggle.current?.focus(); }}
        onPromptStart={() => setAgentOpen(true)} onBusyChange={setAgentBusy}
        onCommands={async (commands) => {
          if (!commands.every((command) => command.op.startsWith("generator."))) {
            throw new Error("Use the project agent for project edits. This agent edits generator settings.");
          }
          await executeGeneratorCommands(commands as GeneratorCommand[]);
        }} />
    </aside>
    </div>
    {editingLoraId && <LoraEditor key={editingLoraId} loraId={editingLoraId} onDone={() => setEditingLoraId(null)} />}
    </>
  );
}

const engineHeadline = (status: SlopfabStatus | null, desktop: boolean) => {
  if (!desktop) return "Browser preview";
  if (!status) return "Checking…";
  switch (status.state) {
    case "ready": return "Ready";
    case "modelsMissing": return "Model files missing";
    case "runtimeMissing": return "Engine missing";
    case "incompatible": return "Engine version not supported";
    case "demo": return "Browser preview";
  }
};

const engineDetail = (status: SlopfabStatus | null, desktop: boolean, missing: number) => {
  if (!desktop) return "Only the desktop app can check paths and render.";
  if (!status) return "Looking for the engine and model files.";
  if (status.state === "runtimeMissing") return `${status.detail} ${runtimeLocationHint()}`;
  if (status.state === "ready") return "All required model files found.";
  if (missing > 0) return `${status.detail} ${missing === 1 ? "1 path" : `${missing} paths`} still to set.`;
  return status.detail;
};
