import { useMemo, useState } from "react";
import { compileCharacterSheet, emptyCharacterSheetOptions, type CharacterSheetOptions } from "../../lib/characterSheet";
import type { ProjectAsset, ProjectConfig } from "../../lib/project";
import { InfoBar, ItemHeader } from "../ui";
import { Dismiss16, Sparkle16 } from "../ui/icons";
import { PromptTextField, type PromptReference } from "./PromptTextField";

export function CharacterSheetSettings({ config, source, references, missingLabel, disabledReason, busy, onExecute, onClose }: {
  config: ProjectConfig; source: ProjectAsset; references: PromptReference[]; missingLabel: (id: string) => string;
  disabledReason: string | null; busy: boolean;
  onExecute: (options: CharacterSheetOptions) => void; onClose: () => void;
}) {
  const [options, setOptions] = useState(emptyCharacterSheetOptions);
  const [error, setError] = useState<string | null>(null);
  const validation = useMemo(() => {
    try { compileCharacterSheet(config, source, "cache/character-sheet-preview/1.png", options); return null; }
    catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
  }, [config, source, options]);
  const update = (field: keyof CharacterSheetOptions, value: string) => {
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
        <p className="image-inspector__caption">A square portrait and three full-body views (front, side, back), combined into one image.</p>
        <div className="image-inspector__area"><span>Prompt</span>
          <PromptTextField aria-label="Character sheet prompt" value={options.prompt} onChange={(value) => update("prompt", value)} references={references} missingLabel={missingLabel} disabled={busy} placeholder="Describe the character, style, lighting, or other details…" />
        </div>
        <div className="image-inspector__area"><span>Clothing and accessories</span>
          <PromptTextField aria-label="Clothing and accessories" value={options.clothing} onChange={(value) => update("clothing", value)} references={references} missingLabel={missingLabel} disabled={busy} placeholder="Describe the outfit or add clothing references…" />
        </div>
        <p className="image-inspector__caption">Leave these blank to keep the source appearance. Clothing instructions apply to the front view, then the same outfit is used for every angle.</p>
        {(validation || error) && <InfoBar severity="error" title="Couldn't prepare the template" message={validation ?? error ?? ""} />}
      </div>
      <div className="image-template-settings__footer">
        {disabledReason && <p className="image-inspector__caption">{disabledReason}</p>}
        <button type="submit" className="primary-button" disabled={Boolean(disabledReason || validation || busy)}><Sparkle16 aria-hidden="true" />{busy ? "Executing…" : "Execute"}</button>
      </div>
    </form>
  </aside>;
}
