import { AlertCircle, Check, ChevronLeft, FileText, FolderOpen, FolderSearch, LoaderCircle, Monitor, Moon, Plus, RefreshCw, RotateCcw, Sun, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getDiagnosticLogInfo, revealDiagnosticLog, type DiagnosticLogInfo } from "../lib/diagnostics";
import { isTauri } from "../lib/persistence";
import { chooseEnginePath, getAgentModels, getEngineStatus, type ModelStatus, type SlopfabStatus } from "../lib/runtime";
import {
  EMPTY_ENGINE_SETTINGS, ENGINE_PATH_FIELDS,
  createGeneratorTemplate, defaultGeneratorTemplate,
  isEndpointProviderConfigured, loadAgentEndpointSettings,
  loadGeneratorTemplateSettings, saveAgentEndpointSettings, saveGeneratorTemplateSettings,
  type AgentEndpointSettings, type EndpointProviderId, type EndpointProviderSettings,
  type EnginePathField, type EnginePathId, type EngineSettings, type GeneratorTemplateSettings,
} from "../lib/settings";
import { MAX_GENERATION_STEPS } from "../lib/project";
import {
  applyTheme, loadTheme, saveTheme, systemTheme, watchSystemTheme,
  type ResolvedTheme, type ThemeChoice,
} from "../lib/theme";

type PathState = "unset" | "checking" | "found" | "missing";

function pathState(field: EnginePathField, value: string, status: SlopfabStatus | null): PathState {
  if (!value.trim()) return "unset";
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
};

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

function DiagnosticsSetting({ desktop }: { desktop: boolean }) {
  const [info, setInfo] = useState<DiagnosticLogInfo | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    void getDiagnosticLogInfo().then(setInfo).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [desktop]);

  const reveal = async () => {
    setOpening(true);
    setError(null);
    try {
      const next = await revealDiagnosticLog();
      if (next) setInfo(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening(false);
    }
  };

  return <div className="diagnostics-setting">
    <div className="diagnostics-setting__icon"><FileText size={22} aria-hidden="true" /></div>
    <div>
      <h2>Application log</h2>
      <p>Slopus records startup, runtime checks, generation stages, encoding, file writes, and unexpected errors in a readable text log. The file rotates at 5 MB and keeps one previous file.</p>
      <p>Prompt text and credentials are not recorded. Sensitive fields are redacted again when each record is written.</p>
      <code title={info?.path}>{desktop ? info?.path ?? "Locating the log…" : "Available in the desktop app"}</code>
      {info?.previousPath && <small>A previous rotated log is stored beside this file.</small>}
      <button type="button" className="secondary-button" disabled={!desktop || opening} onClick={() => void reveal()}>
        {opening ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />} Show log file
      </button>
      {error && <p className="diagnostics-setting__error" role="alert">{error}</p>}
    </div>
  </div>;
}

/* Two things live on this screen and they have nothing to do with each other:
   how the app looks, and where this computer keeps the model files. Stacked,
   they made a screen taller than the window — five path fields is a long list —
   so whichever one the user came for was below the fold half the time. One tab
   each, and neither scrolls on an ordinary window. */
const TABS = [
  { id: "engine", label: "Video engine" },
  { id: "llms", label: "Agents" },
  { id: "appearance", label: "Appearance" },
  { id: "diagnostics", label: "Diagnostics" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function SettingsView({ onClose }: { onClose: () => void }) {
  /* The engine first: this screen exists because those paths have to be set
     before anything can be rendered, and its status line answers "is Slopus
     ready?" without a click. */
  const [tab, setTab] = useState<TabId>("engine");
  const [templateSettings, setTemplateSettings] = useState<GeneratorTemplateSettings>(() => loadGeneratorTemplateSettings());
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [status, setStatus] = useState<SlopfabStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();

  const defaultTemplate = defaultGeneratorTemplate(templateSettings);
  const selectedTemplate = templateSettings.templates.find((template) => template.id === editingTemplateId)
    ?? defaultTemplate;
  const settings = selectedTemplate.paths;

  const probe = useCallback((paths?: EngineSettings) => {
    setStatus(null);
    void getEngineStatus(paths).then(setStatus).catch(() => setStatus(null));
  }, []);

  /* Saved on every keystroke — there is no Save button here, so a half-typed
     path must never be the reason generation is still broken after a restart.
     The probe is deliberately NOT per keystroke: it touches the disk and loads
     the engine library. It runs when a field is left or a path is picked. */
  const update = (id: EnginePathId, value: string) => {
    setTemplateSettings((current) => {
      const next = {
        ...current,
        templates: current.templates.map((template) => template.id === selectedTemplate.id
          ? { ...template, paths: { ...template.paths, [id]: value } }
          : template),
      };
      saveGeneratorTemplateSettings(next);
      return next;
    });
  };

  useEffect(() => { probe(settings); }, [probe, editingTemplateId, templateSettings.defaultTemplateId]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);

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
          ? { ...template, paths: { ...EMPTY_ENGINE_SETTINGS } }
          : template),
      };
      saveGeneratorTemplateSettings(next);
      return next;
    });
    probe({ ...EMPTY_ENGINE_SETTINGS });
  };

  const updateTemplate = (updates: Partial<Pick<typeof selectedTemplate, "name" | "defaultSteps">>) => {
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
    if (templateSettings.templates.length <= 1) return;
    const remaining = templateSettings.templates.filter((template) => template.id !== id);
    const next: GeneratorTemplateSettings = {
      templates: remaining,
      defaultTemplateId: id === templateSettings.defaultTemplateId ? remaining[0].id : templateSettings.defaultTemplateId,
    };
    setTemplateSettings(next);
    saveGeneratorTemplateSettings(next);
    if (editingTemplateId === id) setEditingTemplateId(null);
  };

  const makeDefault = (id: string) => {
    const next = { ...templateSettings, defaultTemplateId: id };
    setTemplateSettings(next);
    saveGeneratorTemplateSettings(next);
  };

  const missing = ENGINE_PATH_FIELDS.filter((field) => field.required && pathState(field, settings[field.id], status) !== "found");

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <div className="settings-view">
        <header className="settings-view__head">
          <h1 id="settings-heading">Settings</h1>
          <button className="icon-button icon-button--strong" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </header>

        {/* A tab is a button that says which panel it opens, so it is a real
            tablist rather than two buttons that happen to swap the content:
            the arrow keys move between them, and the panel below is named by
            the tab that opened it. */}
        {editingTemplateId ? <div className="settings-tabs settings-tabs--editor">
          <button type="button" className="generator-editor__back" onClick={() => setEditingTemplateId(null)}><ChevronLeft size={16} /> Generators</button>
        </div> : <div className="settings-tabs" role="tablist" aria-label="Settings sections">
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
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                setTab(next.id);
                document.getElementById(`settings-tab-${next.id}`)?.focus();
              }}
            >
              {item.label}
              {/* What is wrong stays visible from the other tab: a count here
                  is the whole reason someone opens this screen. */}
              {item.id === "engine" && missing.length > 0 && <em title={`${missing.length} model ${missing.length === 1 ? "path" : "paths"} still to set`}>{missing.length}</em>}
            </button>
          ))}
        </div>}

        <div className="settings-view__body">
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
            <DiagnosticsSetting desktop={desktop} />
          </section>}

          {tab === "engine" && <section
            className="settings-section"
            id="settings-panel-engine"
            role={editingTemplateId ? "region" : "tabpanel"}
            aria-labelledby={editingTemplateId ? "generator-editor-heading" : "settings-tab-engine"}
          >
            {!editingTemplateId ? <section className="generator-templates" aria-labelledby="generators-heading">
              <header>
                <div>
                  <h2 id="generators-heading">Generators</h2>
                  <p>Choose the generator used by default, or open one to edit its model setup.</p>
                </div>
                <button type="button" className="secondary-button" onClick={addTemplate}><Plus size={16} /> New generator</button>
              </header>
              <div className="generator-template-list" role="list" aria-label="Generators">
                {templateSettings.templates.map((template) => (
                  <div className={`generator-template-item${template.id === templateSettings.defaultTemplateId ? " generator-template-item--selected" : ""}`} role="listitem" key={template.id}>
                    <label className="generator-template-item__default" title="Use this generator for generation by default">
                      <input type="radio" name="default-generator-template" checked={template.id === templateSettings.defaultTemplateId} onChange={() => makeDefault(template.id)} aria-label={`Use ${template.name} as the default generator`} />
                    </label>
                    <button type="button" className="generator-template-item__open" onClick={() => setEditingTemplateId(template.id)} aria-label={`Edit ${template.name} generator`}>
                      <b>{template.name}</b><small>{template.defaultSteps} steps</small>
                    </button>
                    <button type="button" className="icon-button" disabled={templateSettings.templates.length === 1} onClick={() => removeTemplate(template.id)} aria-label={`Remove generator ${template.name}`} title={templateSettings.templates.length === 1 ? "At least one generator is required" : `Remove ${template.name}`}><Trash2 size={15} /></button>
                  </div>
                ))}
              </div>
            </section> : <div className="generator-editor">
              <header className="generator-editor__head">
                <div>
                  <h2 id="generator-editor-heading">Edit generator</h2>
                  <p>Set its name, generation steps, and model locations on this computer.</p>
                </div>
              </header>
              <div className="generator-template-fields">
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
              </div>
              <div className={`settings-status settings-status--${status?.state ?? "checking"}`} role="status">
                <span><i />{engineHeadline(status, desktop)}</span>
                <p>{engineDetail(status, desktop, missing.length)}</p>
                {status?.platform && <small className="settings-status__platform"><b>Platform</b>{status.platform}</small>}
              </div>
              {ENGINE_PATH_FIELDS.map((field) => {
                const value = settings[field.id];
                const state = pathState(field, value, status);
                return (
                  <div className={`settings-path settings-path--${state}`} key={field.id}>
                    <label htmlFor={`engine-${field.id}`}>
                      <b>{field.label}{!field.required && <em>Optional</em>}</b>
                      <small>{field.hint}</small>
                    </label>
                    <div className="settings-path__row">
                      <input
                        id={`engine-${field.id}`}
                        value={value}
                        spellCheck={false}
                        placeholder={field.directory ? "Folder on this computer" : "File on this computer"}
                        onChange={(event) => update(field.id, event.target.value)}
                        onBlur={() => probe(settings)}
                      />
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void browse(field)}
                        disabled={!desktop}
                        title={desktop ? `Browse for ${field.label}` : "Browsing for files is available in the desktop app"}
                      >
                        <FolderSearch size={16} /> Browse
                      </button>
                      <span className="settings-path__state">
                        {state === "found" ? <Check size={14} aria-hidden="true" /> : state === "missing" ? <AlertCircle size={14} aria-hidden="true" /> : null}
                        {stateLabel[state]}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>}
          </section>}
        </div>

        {(tab === "diagnostics" || (tab === "engine" && editingTemplateId)) && <footer className="settings-view__foot">
          {/* Clearing the paths is an engine action, so it is only offered
              beside them. */}
          {tab === "engine" && editingTemplateId && <button className="secondary-button" onClick={clearAll}><RotateCcw size={16} /> Clear generator paths</button>}
          {tab === "diagnostics" && <span>Logs stay on this computer.</span>}
        </footer>}

        {error && <div className="toast" role="alert"><strong>Couldn’t open the file picker</strong><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
      </div>
    </div>
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
