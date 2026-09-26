import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { ProjectConfig } from "../../lib/project";
import { isTauri } from "../../lib/persistence";
import { EmptyState, InfoBar, PropSection, Splitter, tooltipProps, usePaneSize } from "../ui";
import { Image32 } from "../ui/icons";
import { ReferenceImage } from "./ReferenceImage";

/* The image project's Export tab: the same page as the video export (see
   export.css) — the image on the stage, filling it, and the resizable settings
   pane on the right opening straight on its first section, with Export… pinned
   at its foot. For now Export… only opens the Save dialog (JPG or PNG is picked
   there); the pane is where output settings will grow. */
export function ImageExportView({ config, folderPath }: { config: ProjectConfig; folderPath: string }) {
  const settingsPane = usePaneSize("export.settings", 340, { min: 280, max: 560 });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const output = config.assets.find((asset) => asset.kind === "image" && asset.id === config.imageScene?.outputAssetId);
  const draft = Boolean(output?.imageDraft);
  const desktop = isTauri();

  /* Why there is nothing to export, in the order the user can fix it. */
  const blocker = !output?.relativePath ? "Generate an image in the Editor first."
    : draft ? "This image is still a draft. Generate it before exporting."
      : !desktop ? "Exporting is available in the Slopus desktop app."
        : null;
  const disabled = blocker !== null || exporting;
  const size = output?.width && output?.height ? `${output.width} × ${output.height}` : null;

  const exportImage = async () => {
    if (!output?.relativePath || disabled) return;
    setExporting(true); setError(null);
    try { await invoke("export_generated_image", { folderPath, relativePath: output.relativePath }); }
    catch (reason) { setError(String(reason)); }
    finally { setExporting(false); }
  };

  const facts: [string, string][] = [["Format", "JPG or PNG, chosen when saving"]];
  if (size) facts.push(["Size", `${size} px`]);

  return <div className="export-view" style={settingsPane.style}>
    <h1 className="sr-only">Export</h1>
    <div className="export-body">
      <section className="export-preview" aria-label="Image preview">
        <div className="export-stage">
          <div className="export-screen">
            {output?.relativePath && !draft
              ? <ReferenceImage className="export-image" folderPath={folderPath} relativePath={output.relativePath} alt={output.name} />
              : <EmptyState className="export-empty" icon={<Image32 />} title={draft ? "The image is a draft" : "No image to export yet"} description={blocker ?? undefined} />}
          </div>
        </div>
      </section>

      <Splitter {...settingsPane.splitterProps} reverse aria-label="Resize export settings" aria-controls="image-export-settings" />

      {/* No title: the pane opens on its first section, like every inspector. */}
      <section id="image-export-settings" className="export-settings" aria-label="Export settings">
        <div className="export-settings__scroll">
          <PropSection title="Output" persistKey="export.image.output">
            <dl className="export-summary">
              {facts.map(([term, value]) => <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>)}
            </dl>
          </PropSection>
          <div className="export-messages">
            {blocker && <InfoBar severity="informational" title="Nothing to export yet" message={blocker} />}
            {error && <InfoBar severity="error" title="Couldn’t export image" message={error} onClose={() => setError(null)} />}
          </div>
        </div>
        <div className="export-settings__foot">
          <div className="export-settings__actions">
            <button
              type="button"
              className="primary-button"
              disabled={disabled}
              onClick={() => void exportImage()}
              {...tooltipProps(exporting ? "Export is running" : blocker ?? "Save the image as JPG or PNG")}
            >{exporting ? "Exporting…" : "Export…"}</button>
          </div>
        </div>
      </section>
    </div>
  </div>;
}
