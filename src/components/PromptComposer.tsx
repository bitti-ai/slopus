import { Clapperboard, Clock3, Monitor, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { outputDimensions, resolutionLabel } from "../lib/export";
import type { AspectRatio, CreateProjectInput, Resolution } from "../lib/project";
import { PROJECT_RESOLUTIONS } from "../lib/project";

interface PromptComposerProps {
  busy: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onClose: () => void;
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

export function PromptComposer({ busy, onCreate, onClose }: PromptComposerProps) {
  const [name, setName] = useState("Untitled video");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [resolution, setResolution] = useState<Resolution>(DEFAULT_RESOLUTION);
  const [duration, setDuration] = useState(30);
  const nameInput = useRef<HTMLInputElement>(null);
  const validDuration = Number.isInteger(duration) && duration >= 10 && duration <= 600;

  /* Naming is the only authored content required before the Agent takes over. */
  useEffect(() => {
    nameInput.current?.focus({ preventScroll: true });
    nameInput.current?.select();
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onClose]);

  const submit = async () => {
    if (busy || !name.trim() || !validDuration) return;
    await onCreate({
      name: name.trim(),
      prompt: "",
      aspectRatio,
      resolution,
      targetDurationSeconds: duration,
    });
  };

  return (
    <div className="composer-overlay" role="dialog" aria-modal="true" aria-labelledby="create-heading">
      <section className="composer-shell">
      <header className="composer-heading">
        <h2 id="create-heading">New project</h2>
        <button className="icon-button icon-button--strong" onClick={onClose} disabled={busy} aria-label="Close new project"><X size={18} /></button>
      </header>
      <div className="composer">
        <label className="composer__name-row">
          <span>Project name</span>
          <input ref={nameInput} value={name} onChange={(event) => setName(event.target.value)} aria-label="Project name" />
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
                <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}>
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
                <select value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)}>
                  {PROJECT_RESOLUTIONS.map((option) => {
                    const { width, height } = outputDimensions(option, aspectRatio);
                    return <option key={option} value={option}>{width} × {height}{option === DEFAULT_RESOLUTION ? " (default)" : ""}</option>;
                  })}
                </select>
              </label>
              <label className="composer__duration">
                <span>
                  <Clock3 size={15} /> Length
                  <output htmlFor="project-duration">{durationLabel(duration)}</output>
                </span>
                <input
                  id="project-duration"
                  aria-label="Length in seconds"
                  aria-valuetext={durationLabel(duration)}
                  type="range"
                  min={10}
                  max={600}
                  step={1}
                  value={duration}
                  onChange={(event) => setDuration(Number(event.target.value))}
                />
                <small className="composer__duration-scale"><span>10 seconds</span><span>10 minutes</span></small>
              </label>
            </div>
          </div>
        </section>

        <div className="composer__actions">
          <button className="primary-button composer__submit" disabled={busy || !name.trim() || !validDuration} aria-busy={busy} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : <WandSparkles size={18} />}
            Create project
          </button>
        </div>
      </div>
      </section>
    </div>
  );
}
