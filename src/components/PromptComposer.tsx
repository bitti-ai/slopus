import { Clapperboard, Clock3, Monitor, Save, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { outputDimensions, resolutionLabel } from "../lib/export";
import type { AspectRatio, CreateProjectInput, ProjectConfig, Resolution } from "../lib/project";
import { PROJECT_RESOLUTIONS } from "../lib/project";

interface PromptComposerProps {
  busy: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onClose: () => void;
  project?: ProjectConfig;
  error?: string | null;
}

const aspectRatioLabels: Record<AspectRatio, string> = {
  "16:9": "Widescreen 16:9",
  "9:16": "Vertical 9:16",
  "1:1": "Square 1:1",
  "4:5": "Portrait 4:5",
};

/* Chosen because it is the closest rung to the canvas slopfab actually plans a
   16:9 scene onto (1344×768), so a project made without opening this panel is
   not one that has to be rescaled the moment a scene is generated. */
const DEFAULT_RESOLUTION: Resolution = "768p";

const durationLabel = (seconds: number) => {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}${remainder ? ` ${remainder} seconds` : ""}`;
};

export function PromptComposer({ busy, onCreate: onSubmit, onClose, project, error }: PromptComposerProps) {
  const [name, setName] = useState(project?.name ?? "Untitled video");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(project?.settings.aspectRatio ?? "16:9");
  const [resolution, setResolution] = useState<Resolution>(project?.settings.resolution ?? DEFAULT_RESOLUTION);
  const [durationInput, setDurationInput] = useState(String(project?.brief.targetDurationSeconds ?? 30));
  const duration = Number(durationInput);
  const dialog = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const validDuration = durationInput.trim() !== "" && Number.isInteger(duration) && duration >= 0 && duration <= 600;
  const sliderPosition = Math.max(0, Math.min(114, duration <= 60 ? duration : 60 + (duration - 60) / 10));
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
    if (busy || !name.trim() || !validDuration) return;
    await onSubmit({
      name: name.trim(),
      prompt: project?.brief.prompt ?? "",
      aspectRatio,
      resolution,
      targetDurationSeconds: duration,
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
            <span className="composer__options-value">{aspectRatioLabels[aspectRatio]} · {resolutionLabel(resolution, aspectRatio)} · {durationLabel(duration)}</span>
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
              <div className="composer__duration">
                <span>
                  <Clock3 size={15} /> Length
                  <output htmlFor="project-duration">{validDuration ? durationLabel(duration) : "Enter 0–600 seconds"}</output>
                </span>
                <input id="project-duration" aria-label="Length in seconds" type="number" min={0} max={600} step={1} disabled={busy} value={durationInput} onChange={(event) => setDurationInput(event.target.value)} />
                <input
                  aria-label="Length slider"
                  aria-valuetext={durationLabel(duration)}
                  aria-valuemin={0}
                  aria-valuemax={600}
                  aria-valuenow={validDuration ? duration : 0}
                  type="range"
                  min={0}
                  disabled={busy}
                  max={114}
                  step={1}
                  value={Number.isFinite(sliderPosition) ? sliderPosition : 0}
                  onChange={(event) => {
                    const position = Number(event.target.value);
                    setDurationInput(String(position <= 60 ? position : 60 + (position - 60) * 10));
                  }}
                />
                <small className="composer__duration-scale"><span>0 seconds</span><span>10 minutes</span></small>
              </div>
            </div>
          </div>
        </section>

        {error && <p role="alert">{error}</p>}
        <div className="composer__actions">
          <button className="primary-button composer__submit" disabled={busy || !name.trim() || !validDuration} aria-busy={busy} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : project ? <Save size={18} /> : <WandSparkles size={18} />}
            {project ? "Save changes" : "Create project"}
          </button>
        </div>
      </div>
      </section>
    </div>
  );
}
