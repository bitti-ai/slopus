import { useMemo } from "react";
import { alignExtendBounds, compileExtendImage, initialExtendBounds, EXTEND_GRID, EXTEND_MAX_EDGE, type ExtendOptions } from "../../lib/extendImage";
import { PROJECT_RESOLUTIONS, type ProjectAsset, type ProjectConfig } from "../../lib/project";
import { imageSettings } from "../../lib/imageSettings";
import { ComboBox, InfoBar, ItemHeader, PropRow } from "../ui";
import { Dismiss16, Sparkle16 } from "../ui/icons";
import { PromptTextField, type PromptReference } from "./PromptTextField";
import { TemplateDebugPrompt } from "./TemplateDebugPrompt";

export function ExtendSettings({ config, source, options, onChange, onResolutionChange, references, missingLabel, busy, disabledReason, onExecute, onClose }: {
  config: ProjectConfig; source: ProjectAsset; options: ExtendOptions; onChange: (options: ExtendOptions) => void;
  references: PromptReference[]; missingLabel: (id: string) => string; busy: boolean; disabledReason: string | null;
  onExecute: () => void; onClose: () => void;
  onResolutionChange?: (resolution: ProjectConfig["settings"]["resolution"]) => void;
}) {
  const validation = useMemo(() => {
    try {
      const compiled = compileExtendImage(config, source, "cache/extend-preview.png", options);
      return { mode: compiled.layout.mode, output: compiled.layout.output, prompt: compiled.prompt, message: null };
    }
    catch (reason) { return { output: null, prompt: null, message: reason instanceof Error ? reason.message : String(reason) }; }
  }, [config, source, options]);
  return <aside className="image-inspector image-template-settings" aria-label="Extend settings">
    <ItemHeader name="Extend" meta="Template" actions={<button type="button" className="icon-button" aria-label="Close template settings" data-tooltip="Back to image settings" onClick={onClose}><Dismiss16 aria-hidden="true" /></button>} />
    <form className="image-template-settings__form" onSubmit={(event) => { event.preventDefault(); if (!busy && !disabledReason && !validation.message) onExecute(); }}>
      <div className="image-inspector__fields image-template-settings__fields">
        <PropRow label="Resolution" htmlFor="extend-resolution" tooltip="The box sets the aspect ratio. The selected resolution sets the pixel budget; expanding the box makes the source smaller within that output.">
          <ComboBox id="extend-resolution" aria-label="Extend resolution" value={imageSettings(config).resolution} options={PROJECT_RESOLUTIONS.map((value) => ({ value, label: value }))}
            disabled={busy || !onResolutionChange} onChange={(value) => onResolutionChange?.(value)} />
        </PropRow>
        {validation.output && <p className="image-inspector__caption">Output: {validation.output.width} × {validation.output.height} px</p>}
        {validation.mode === "regenerate" && <p className="image-inspector__caption">Regenerate selection: refine the selected crop at the output resolution.</p>}
        <p className="image-inspector__caption">Source: {source.name} · {source.width} × {source.height} px</p>
        {(["x", "y", "width", "height"] as const).map((field) => <PropRow key={field} label={field === "x" ? "X" : field === "y" ? "Y" : field === "width" ? "Width" : "Height"} htmlFor={`extend-${field}`}
          tooltip={field === "x" || field === "y" ? "Drag the box or its handles, or drag outside it to draw a new box." : "Sizes use 32-pixel increments. The source is resized to fit the box at the selected generation resolution."}>
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
        <div className="image-inspector__area"><span>Prompt (optional)</span><PromptTextField aria-label="Extend prompt" value={options.prompt} onChange={(prompt) => onChange({ ...options, prompt })}
          references={references} missingLabel={missingLabel} disabled={busy} placeholder={validation.mode === "regenerate" ? "Describe details to refine…" : "Describe what should appear beyond the image…"} /></div>
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
