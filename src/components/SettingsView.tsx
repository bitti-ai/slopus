import { AlertCircle, Check, FolderSearch, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isTauri } from "../lib/persistence";
import { chooseEnginePath, getEngineStatus, type ModelStatus, type VidfabStatus } from "../lib/runtime";
import {
  EMPTY_ENGINE_SETTINGS, ENGINE_PATH_FIELDS,
  loadEngineSettings, saveEngineSettings,
  type EnginePathField, type EnginePathId, type EngineSettings,
} from "../lib/settings";

type PathState = "unset" | "checking" | "found" | "missing";

/* The backend reports the DLL separately from the five model paths, so one
   lookup answers "is this path actually there?" for either kind. */
function pathState(field: EnginePathField, value: string, status: VidfabStatus | null): PathState {
  if (!value.trim()) return "unset";
  if (!status) return "checking";
  if (field.id === "dllPath") return status.state === "runtimeMissing" ? "missing" : "found";
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

export function SettingsView({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<EngineSettings>(() => loadEngineSettings());
  const [status, setStatus] = useState<VidfabStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();

  const probe = useCallback(() => {
    setStatus(null);
    void getEngineStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  /* Saved on every keystroke — there is no Save button here, so a half-typed
     path must never be the reason generation is still broken after a restart.
     The probe is deliberately NOT per keystroke: it touches the disk and loads
     the engine library. It runs when a field is left or a path is picked. */
  const update = (id: EnginePathId, value: string) => {
    setSettings((current) => {
      const next = { ...current, [id]: value };
      saveEngineSettings(next);
      return next;
    });
  };

  useEffect(probe, [probe]);

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
      probe();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const clearAll = () => {
    setSettings({ ...EMPTY_ENGINE_SETTINGS });
    saveEngineSettings({ ...EMPTY_ENGINE_SETTINGS });
    probe();
  };

  const missing = ENGINE_PATH_FIELDS.filter((field) => field.required && pathState(field, settings[field.id], status) !== "found");

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
      <div className="settings-view">
        <header className="settings-view__head">
          <div>
            <p className="eyebrow">Settings</p>
            <h1 id="settings-heading">Video engine</h1>
          </div>
          <button className="icon-button icon-button--strong" onClick={onClose} aria-label="Close settings"><X size={18} /></button>
        </header>

        <p className="settings-view__lead">
          PolStudio needs the engine library and its model files to render a shot. These paths belong to
          this computer, not to a project — they are remembered here and used by every project you open.
        </p>

        <div className={`settings-status settings-status--${status?.state ?? "checking"}`} role="status">
          <span><i />{engineHeadline(status, desktop)}</span>
          <p>{engineDetail(status, desktop, missing.length)}</p>
        </div>

        <section className="settings-section" aria-labelledby="paths-heading">
          <h2 id="paths-heading">Engine and model paths</h2>
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
                    onBlur={probe}
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
                </div>
                <span className="settings-path__state">
                  {state === "found" ? <Check size={14} aria-hidden="true" /> : state === "missing" ? <AlertCircle size={14} aria-hidden="true" /> : null}
                  {stateLabel[state]}
                </span>
              </div>
            );
          })}
        </section>

        <footer className="settings-view__foot">
          <button className="secondary-button" onClick={clearAll}><RotateCcw size={16} /> Clear all paths</button>
          <span>Changes are saved as you type.</span>
        </footer>

        {error && <div className="toast" role="alert"><strong>Couldn’t open the file picker</strong><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
      </div>
    </div>
  );
}

const engineHeadline = (status: VidfabStatus | null, desktop: boolean) => {
  if (!desktop) return "Browser preview";
  if (!status) return "Checking this computer…";
  switch (status.state) {
    case "ready": return "Engine ready";
    case "modelsMissing": return "Model files missing";
    case "runtimeMissing": return "Engine not found";
    case "incompatible": return "Engine version not supported";
    case "demo": return "Browser preview";
  }
};

const engineDetail = (status: VidfabStatus | null, desktop: boolean, missing: number) => {
  if (!desktop) return "Paths are saved here, but only the desktop app can check them or render with them.";
  if (!status) return "Looking for the engine library and the model files.";
  if (status.state === "ready") return "Everything PolStudio needs to render a shot is in place.";
  if (missing > 0) return `${status.detail} ${missing === 1 ? "One path" : `${missing} paths`} still need setting below.`;
  return status.detail;
};
