import { useSyncExternalStore } from "react";
import { loadGenerationPreviewsEnabled, saveGenerationPreviewsEnabled, subscribeGenerationPreviews } from "../lib/generationPreviewSettings";
import { SettingsCard, SettingsGroup, ToggleSwitch } from "./ui";

export function GenerationPreviewSetting() {
  const enabled = useSyncExternalStore(subscribeGenerationPreviews, loadGenerationPreviewsEnabled);
  return <SettingsGroup heading="Generation previews">
    <SettingsCard header="Show generation previews" description="Play MiniMax H3 previews in scene cards during generation. Requires TAEH3 from Other weights and a runtime with preview support.">
      <ToggleSwitch checked={enabled} aria-label="Enable generation previews" onChange={saveGenerationPreviewsEnabled} />
    </SettingsCard>
  </SettingsGroup>;
}
