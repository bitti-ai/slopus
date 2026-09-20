import { Clapperboard, Monitor, Palette, Save, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { outputDimensions } from "../lib/export";
import type { AspectRatio, CreateProjectInput, ProjectConfig, Resolution } from "../lib/project";
import { PROJECT_RESOLUTIONS } from "../lib/project";
import { SHOT_TAG_GROUPS } from "../lib/shot-tags";

interface PromptComposerProps {
  busy: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onClose: () => void;
  project?: ProjectConfig;
  error?: string | null;
}

/* Chosen because it is the closest rung to the canvas slopfab actually plans a
   16:9 scene onto (1344×768), so a project made without opening this panel is
   not one that has to be rescaled the moment a scene is generated. */
const DEFAULT_RESOLUTION: Resolution = "768p";
const LOOKS = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")!.options;

export function PromptComposer({ busy, onCreate: onSubmit, onClose, project, error }: PromptComposerProps) {
  const [name, setName] = useState(project?.name ?? "Untitled video");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(project?.settings.aspectRatio ?? "16:9");
  const [resolution, setResolution] = useState<Resolution>(project?.settings.resolution ?? DEFAULT_RESOLUTION);
  const [defaultLook, setDefaultLook] = useState(project?.settings.defaultLook ?? "");
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const resolutions: readonly Resolution[] = project && !PROJECT_RESOLUTIONS.some((value) => value === project.settings.resolution)
    ? [...PROJECT_RESOLUTIONS, project.settings.resolution] : PROJECT_RESOLUTIONS;

  /* Naming is the only authored content required before the Agent takes over. */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    nameInput.current?.focus({ preventScroll: true });
    nameInput.current?.select();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)") ?? []);
      if (!controls.length) { event.preventDefault(); return; }
      if (!dialog.current?.contains(document.activeElement) || (event.shiftKey ? document.activeElement === controls[0] : document.activeElement === controls.at(-1))) {
        event.preventDefault(); (event.shiftKey ? controls.at(-1)! : controls[0]).focus();
      }
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [busy, onClose]);

  const submit = async () => {
    if (busy || !name.trim()) return;
    await onSubmit({
      name: name.trim(),
      prompt: project?.brief.prompt ?? "",
      aspectRatio,
      resolution,
      targetDurationSeconds: project?.brief.targetDurationSeconds ?? 60,
      defaultLook: defaultLook || null,
    });
  };

  return (
    <div ref={dialog} className="composer-overlay" role="dialog" aria-modal="true" aria-labelledby="create-heading">
      <section className="composer-shell">
      <header className="composer-heading">
        <h2 id="create-heading">{project ? "Project settings" : "New project"}</h2>
        <button className="icon-button icon-button--strong" onClick={onClose} disabled={busy} aria-label={project ? "Close project settings" : "Close new project"}><X size={18} /></button>
      </header>
      <div className="composer">
        <label className="composer__name-row">
          <span>Project name</span>
          <input ref={nameInput} disabled={busy} value={name} onChange={(event) => setName(event.target.value)} aria-label="Project name" />
        </label>

        <section className="composer__options">
          <div className="composer__options-head">
            <span className="composer__options-title">Video settings</span>
          </div>
          <div className="composer__options-body">
            <div className="composer__options-grid">
              <label>
                <span><Monitor size={15} /> Aspect Ratio</span>
                <select disabled={busy} value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}>
                  <option value="16:9">Widescreen 16:9</option>
                  <option value="9:16">Vertical 9:16</option>
                  <option value="1:1">Square 1:1</option>
                  <option value="4:5">Portrait 4:5</option>
                </select>
              </label>
              {/* The real pixels, not a name for them. Every rung is a multiple
                  of 32 on both edges — what MiniMax H3 generates at — and they
                  are relabelled when the shape above changes, because 768p is
                  1376×768 widescreen and 768×1376 vertical. */}
              <label>
                <span><Clapperboard size={15} /> Resolution</span>
                <select disabled={busy} value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)}>
                  {resolutions.map((option) => {
                    const { width, height } = outputDimensions(option, aspectRatio);
                    return <option key={option} value={option}>{width} × {height}{option === DEFAULT_RESOLUTION ? " (default)" : ""}</option>;
                  })}
                </select>
              </label>
              <label>
                <span><Palette size={15} aria-hidden="true" /> Look</span>
                <select aria-label="Look" disabled={busy} value={defaultLook} onChange={(event) => setDefaultLook(event.target.value)}>
                  <option value="">None</option>
                  {LOOKS.map((look) => <option key={look.id} value={look.id}>{look.label}</option>)}
                </select>
              </label>
            </div>
          </div>
        </section>

        {error && <p role="alert">{error}</p>}
        <div className="composer__actions">
          <button className="primary-button composer__submit" disabled={busy || !name.trim()} aria-busy={busy} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : project ? <Save size={18} /> : <WandSparkles size={18} />}
            {project ? "Save changes" : "Create project"}
          </button>
        </div>
      </div>
      </section>
    </div>
  );
}
