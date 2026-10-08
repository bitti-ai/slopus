import { useMemo } from "react";
import { alignExtendBounds, compileExtendImage, initialExtendBounds, EXTEND_GRID, EXTEND_MAX_EDGE, type ExtendOptions } from "../../lib/extendImage";
import type { ProjectAsset, ProjectConfig } from "../../lib/project";
import { InfoBar, ItemHeader, PropRow } from "../ui";
import { Dismiss16, Sparkle16 } from "../ui/icons";
import { PromptTextField, type PromptReference } from "./PromptTextField";
import { TemplateDebugPrompt } from "./TemplateDebugPrompt";

export function ExtendSettings({ config, source, options, onChange, references, missingLabel, busy, disabledReason, onExecute, onClose }: {
  config: ProjectConfig; source: ProjectAsset; options: ExtendOptions; onChange: (options: ExtendOptions) => void;
  references: PromptReference[]; missingLabel: (id: string) => string; busy: boolean; disabledReason: string | null;
  onExecute: () => void; onClose: () => void;
}) {
  const validation = useMemo(() => {
    try {
      const compiled = compileExtendImage(config, source, "cache/extend-preview.png", options);
      return { output: compiled.layout.output, prompt: compiled.prompt, message: null };
    }
    catch (reason) { return { output: null, prompt: null, message: reason instanceof Error ? reason.message : String(reason) }; }
  }, [config, source, options]);
  return <aside className="image-inspector image-template-settings" aria-label="Extend settings">
    <ItemHeader name="Extend" meta="Template" actions={<button type="button" className="icon-button" aria-label="Close template settings" data-tooltip="Back to image settings" onClick={onClose}><Dismiss16 aria-hidden="true" /></button>} />
    <form className="image-template-settings__form" onSubmit={(event) => { event.preventDefault(); if (!busy && !disabledReason && !validation.message) onExecute(); }}>
      <div className="image-inspector__fields image-template-settings__fields">
        {validation.output && <p className="image-inspector__caption">Output: {validation.output.width} × {validation.output.height} px</p>}
        <p className="image-inspector__caption">Source: {source.name} · {source.width} × {source.height} px</p>
        {(["x", "y", "width", "height"] as const).map((field) => <PropRow key={field} label={field === "x" ? "X" : field === "y" ? "Y" : field === "width" ? "Width" : "Height"} htmlFor={`extend-${field}`}
          tooltip={field === "x" || field === "y" ? "Drag the box or its handles, or drag outside it to draw a new box." : "Sizes use 32-pixel increments. The original is downscaled to make room for generated areas; output stays within the source pixel count and selected generation resolution."}>
          <input id={`extend-${field}`} aria-label={`Extend ${field}`} className="text-field" type="number" step={field === "x" || field === "y" ? 1 : EXTEND_GRID} min={field === "x" || field === "y" ? -8192 : EXTEND_GRID} max={field === "x" || field === "y" ? 8192 : EXTEND_MAX_EDGE} required disabled={busy}
            value={options.bounds[field]} onChange={(event) => {
              const value = event.target.valueAsNumber; if (!Number.isFinite(value)) return;
              const bounds = { ...options.bounds, [field]: value };
              onChange({ ...options, bounds: field === "width" || field === "height" ? alignExtendBounds(bounds, field === "width" ? "e" : "s") : { ...bounds, [field]: Math.round(value) } });
            }} />
        </PropRow>)}
        <button type="button" className="secondary-button" disabled={busy} onClick={() => onChange({ ...options, bounds: initialExtendBounds(source.width!, source.height!) })}>Reset box</button>
        <PropRow label="Steps" htmlFor="extend-steps"><input id="extend-steps" className="text-field" type="number" min="2" max="1000" step="1" required disabled={busy}
          value={Number.isNaN(options.steps) ? "" : options.steps} onChange={(event) => onChange({ ...options, steps: event.target.valueAsNumber })} /></PropRow>
        <PropRow label="Seed" htmlFor="extend-seed" tooltip="Use -1 for a random seed."><input id="extend-seed" className="text-field" type="number" min="-1" max={Number.MAX_SAFE_INTEGER} step="1" required disabled={busy}
          value={Number.isNaN(options.seed) ? "" : options.seed} onChange={(event) => onChange({ ...options, seed: event.target.valueAsNumber })} /></PropRow>
        <div className="image-inspector__area"><span>Prompt</span><PromptTextField aria-label="Extend prompt" value={options.prompt} onChange={(prompt) => onChange({ ...options, prompt })}
          references={references} missingLabel={missingLabel} disabled={busy} placeholder="Describe what should appear beyond the image…" /></div>
        {validation.message && <InfoBar severity="error" title="Adjust the Extend settings" message={validation.message} />}
      </div>
      <div className="image-template-settings__footer">
        <TemplateDebugPrompt name="Extend" prompts={validation.prompt === null ? [] : [{ label: "Extend", prompt: validation.prompt }]} />
        {disabledReason && <p className="image-inspector__caption">{disabledReason}</p>}
        <button type="submit" className="primary-button" disabled={busy || Boolean(disabledReason || validation.message)}><Sparkle16 aria-hidden="true" />{busy ? "Executing…" : "Execute"}</button>
      </div>
    </form>
  </aside>;
}
