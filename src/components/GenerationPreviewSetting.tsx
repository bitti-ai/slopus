import { useSyncExternalStore } from "react";
import { loadGenerationPreviewsEnabled, saveGenerationPreviewsEnabled, subscribeGenerationPreviews } from "../lib/generationPreviewSettings";
import { SettingsCard, SettingsGroup, ToggleSwitch } from "./ui";

export function GenerationPreviewSetting() {
  const enabled = useSyncExternalStore(subscribeGenerationPreviews, loadGenerationPreviewsEnabled);
  return <SettingsGroup heading="Preview">
    <SettingsCard header="Show generation previews" description="Play MiniMax H3 previews in scene cards during generation. Download TAEH3 from Other weights first. Decoder changes apply to new generations.">
      <ToggleSwitch checked={enabled} aria-label="Enable generation previews" onChange={saveGenerationPreviewsEnabled} />
    </SettingsCard>
  </SettingsGroup>;
}
