import { useMemo } from "react";
import { compileExtendImage, initialExtendBounds, type ExtendOptions } from "../../lib/extendImage";
import type { ProjectAsset, ProjectConfig } from "../../lib/project";
import { InfoBar, ItemHeader, PropRow } from "../ui";
import { Dismiss16, Sparkle16 } from "../ui/icons";
import { PromptTextField, type PromptReference } from "./PromptTextField";

export function ExtendSettings({ config, source, options, onChange, references, missingLabel, busy, disabledReason, onExecute, onClose }: {
  config: ProjectConfig; source: ProjectAsset; options: ExtendOptions; onChange: (options: ExtendOptions) => void;
  references: PromptReference[]; missingLabel: (id: string) => string; busy: boolean; disabledReason: string | null;
  onExecute: () => void; onClose: () => void;
}) {
  const error = useMemo(() => {
    try { compileExtendImage(config, source, "cache/extend-preview.png", options); return null; }
    catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
  }, [config, source, options]);
  return <aside className="image-inspector image-template-settings" aria-label="Extend settings">
    <ItemHeader name="Extend" meta="Template" actions={<button type="button" className="icon-button" aria-label="Close template settings" data-tooltip="Back to image settings" onClick={onClose}><Dismiss16 aria-hidden="true" /></button>} />
    <form className="image-template-settings__form" onSubmit={(event) => { event.preventDefault(); if (!busy && !disabledReason && !error) onExecute(); }}>
      <div className="image-inspector__fields image-template-settings__fields">
        <p className="image-inspector__caption">Drag the box or its handles to set the final image bounds. Drag outside the box to draw a new one. Shaded areas will be generated; original pixels inside the box stay unchanged.</p>
        <p className="image-inspector__caption">Source: {source.name} · {source.width} × {source.height} px</p>
        {(["x", "y", "width", "height"] as const).map((field) => <PropRow key={field} label={field === "x" ? "X" : field === "y" ? "Y" : field === "width" ? "Width" : "Height"} htmlFor={`extend-${field}`}>
          <input id={`extend-${field}`} aria-label={`Extend ${field}`} className="text-field" type="number" step="1" min={field === "x" || field === "y" ? -8192 : 1} max="8192" required disabled={busy}
            value={Number.isNaN(options.bounds[field]) ? "" : options.bounds[field]} onChange={(event) => onChange({ ...options, bounds: { ...options.bounds, [field]: event.target.valueAsNumber } })} />
        </PropRow>)}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => onChange({ ...options, bounds: initialExtendBounds(source.width!, source.height!) })}>Reset box</button>
        <PropRow label="Steps" htmlFor="extend-steps"><input id="extend-steps" className="text-field" type="number" min="2" max="1000" step="1" required disabled={busy}
          value={Number.isNaN(options.steps) ? "" : options.steps} onChange={(event) => onChange({ ...options, steps: event.target.valueAsNumber })} /></PropRow>
        <PropRow label="Seed" htmlFor="extend-seed"><input id="extend-seed" className="text-field" type="number" min="-1" max={Number.MAX_SAFE_INTEGER} step="1" required disabled={busy}
          value={Number.isNaN(options.seed) ? "" : options.seed} onChange={(event) => onChange({ ...options, seed: event.target.valueAsNumber })} /></PropRow>
        <p className="image-inspector__caption">Use -1 for a random seed.</p>
        <div className="image-inspector__area"><span>Prompt</span><PromptTextField aria-label="Extend prompt" value={options.prompt} onChange={(prompt) => onChange({ ...options, prompt })}
          references={references} missingLabel={missingLabel} disabled={busy} placeholder="Describe what should appear beyond the image…" /></div>
        {error && <InfoBar severity="error" title="Adjust the Extend settings" message={error} />}
      </div>
      <div className="image-template-settings__footer">
        {disabledReason && <p className="image-inspector__caption">{disabledReason}</p>}
        <button type="submit" className="primary-button" disabled={busy || Boolean(disabledReason || error)}><Sparkle16 aria-hidden="true" />{busy ? "Executing…" : "Execute"}</button>
      </div>
    </form>
  </aside>;
}
