import { useMemo, useState } from "react";
import { CHARACTER_SHEET_HEIGHTS, CHARACTER_SHEET_ORDER, CHARACTER_SHEET_VIEWS, characterSheetDimensions, compileCharacterSheet, emptyCharacterSheetOptions, type CharacterSheetOptions } from "../../lib/characterSheet";
import type { ProjectAsset, ProjectConfig } from "../../lib/project";
import { ComboBox, InfoBar, ItemHeader, PropRow } from "../ui";
import { Dismiss16, Sparkle16 } from "../ui/icons";
import { PromptTextField, type PromptReference } from "./PromptTextField";
import { TemplateDebugPrompt } from "./TemplateDebugPrompt";

export function CharacterSheetSettings({ config, source, references, missingLabel, defaultSteps, disabledReason, busy, onExecute, onClose }: {
  config: ProjectConfig; source: ProjectAsset; references: PromptReference[]; missingLabel: (id: string) => string;
  defaultSteps: number; disabledReason: string | null; busy: boolean;
  onExecute: (options: CharacterSheetOptions) => void; onClose: () => void;
}) {
  const [options, setOptions] = useState<CharacterSheetOptions>(() => ({ ...emptyCharacterSheetOptions(), height: characterSheetDimensions(config.settings.resolution)[0].height,
    steps: config.imageScene?.steps ?? defaultSteps, seed: config.imageScene?.seed ?? -1 }));
  const dimensions = characterSheetDimensions(config.settings.resolution, options.height);
  const [error, setError] = useState<string | null>(null);
  const compiled = useMemo(() => {
    try { return { views: compileCharacterSheet(config, source, "cache/character-sheet-preview/1.png", options), error: null }; }
    catch (reason) { return { views: null, error: reason instanceof Error ? reason.message : String(reason) }; }
  }, [config, source, options]);
  const validation = compiled.error;
  const update = <K extends keyof CharacterSheetOptions,>(field: K, value: CharacterSheetOptions[K]) => {
    setOptions((current) => ({ ...current, [field]: value })); setError(null);
  };
  return <aside className="image-inspector image-template-settings" aria-label="Character sheet settings">
    <ItemHeader name="Character sheet" meta="Template" actions={<button type="button" className="icon-button" aria-label="Close template settings" data-tooltip="Back to image settings" onClick={onClose}><Dismiss16 aria-hidden="true" /></button>} />
    <form className="image-template-settings__form" onSubmit={(event) => {
      event.preventDefault();
      if (disabledReason || validation || busy) return;
      try { setError(null); onExecute(options); }
      catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    }}>
      <div className="image-inspector__fields image-template-settings__fields">
        <p className="image-inspector__caption">Source: {source.name}</p>
        <p className="image-inspector__caption">A square waist-up shot and three full-body views (front, side, back), combined into one image.</p>
        <PropRow label="Resolution" htmlFor="character-sheet-resolution"><ComboBox id="character-sheet-resolution" aria-label="Character sheet resolution" value={options.height} disabled={busy}
          options={CHARACTER_SHEET_HEIGHTS.map((height) => ({ value: height, label: `${height} px high` }))} onChange={(height) => update("height", height)} /></PropRow>
        <p className="image-inspector__caption">Sheet size: {dimensions.reduce((width, view) => width + view.width, 0)} × {dimensions[0].height} px. Width follows the four view proportions.</p>
        <PropRow label="Steps" htmlFor="character-sheet-steps"><input id="character-sheet-steps" className="text-field" type="number" min="2" max="1000" step="1" required disabled={busy}
          value={Number.isNaN(options.steps) ? "" : options.steps} onChange={(event) => update("steps", event.target.valueAsNumber)} /></PropRow>
        <PropRow label="Seed" htmlFor="character-sheet-seed"><input id="character-sheet-seed" className="text-field" type="number" min="-1" max={Number.MAX_SAFE_INTEGER} step="1" required disabled={busy}
          value={Number.isNaN(options.seed) ? "" : options.seed} onChange={(event) => update("seed", event.target.valueAsNumber)} /></PropRow>
        <p className="image-inspector__caption">Use -1 for a random seed. All four views use the same seed and step count.</p>
        <div className="image-inspector__area"><span>Prompt</span>
          <PromptTextField aria-label="Character sheet prompt" value={options.prompt} onChange={(value) => update("prompt", value)} references={references} missingLabel={missingLabel} disabled={busy} placeholder="Describe the character, clothing, accessories, style, or lighting…" />
        </div>
        <p className="image-inspector__caption">Use the prompt and references for clothing and other details. Leave it blank to keep the source appearance. Clothing instructions apply to the front view, then the same outfit is used for every angle.</p>
        {(validation || error) && <InfoBar severity="error" title="Couldn't prepare the template" message={validation ?? error ?? ""} />}
      </div>
      <div className="image-template-settings__footer">
        <TemplateDebugPrompt name="Character sheet" prompts={compiled.views ? CHARACTER_SHEET_ORDER.map((index) => ({ label: CHARACTER_SHEET_VIEWS[index].label, prompt: compiled.views![index].prompt })) : []} />
        {disabledReason && <p className="image-inspector__caption">{disabledReason}</p>}
        <button type="submit" className="primary-button" disabled={Boolean(disabledReason || validation || busy)}><Sparkle16 aria-hidden="true" />{busy ? "Executing…" : "Execute"}</button>
      </div>
    </form>
  </aside>;
}
