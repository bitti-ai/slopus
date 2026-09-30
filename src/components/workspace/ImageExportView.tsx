import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { exportSizeChoices } from "../../lib/export";
import type { ProjectConfig } from "../../lib/project";
import { isTauri } from "../../lib/persistence";
import { ComboBox, EmptyState, InfoBar, PropRow, PropSection, Slider, Splitter, tooltipProps, usePaneSize } from "../ui";
import { Image32 } from "../ui/icons";
import { ImageBar } from "./ImageBar";
import { ReferenceImage } from "./ReferenceImage";

/* The image project's Export tab: the same page as the video export (see
   export.css) — the image on the stage, filling it, and the resizable settings
   pane on the right opening straight on its first section, with Export… pinned
   at its foot. Output sets the size (the image's own, or a standard export size
   at its aspect), the format and, for JPG, the quality; Export… then
   asks where to save. The image bar under the stage picks which image. Format and quality are remembered across projects. */

type ImageFormat = "jpg" | "png";
const STORAGE_KEY = "slopus.image-export.v1";
const DEFAULT_QUALITY = 90;

function loadPreferences(): { format: ImageFormat; quality: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { format?: unknown; quality?: unknown };
    const quality = typeof saved.quality === "number" && saved.quality >= 1 && saved.quality <= 100 ? Math.round(saved.quality) : DEFAULT_QUALITY;
    return { format: saved.format === "png" ? "png" : "jpg", quality };
  } catch { return { format: "jpg", quality: DEFAULT_QUALITY }; }
}

export function ImageExportView({ config, folderPath }: { config: ProjectConfig; folderPath: string }) {
  const settingsPane = usePaneSize("export.settings", 340, { min: 280, max: 560 });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Which image to export is this page's own choice: it starts on the one open
     in the Editor, and picking another here leaves the Editor where it was. */
  const images = config.assets.filter((asset) => asset.kind === "image");
  const [chosenId, setChosenId] = useState<string | null>(null);
  const output = images.find((asset) => asset.id === chosenId) ?? images.find((asset) => asset.id === config.imageScene?.outputAssetId);
  const draft = Boolean(output?.imageDraft);
  const desktop = isTauri();

  /* Why there is nothing to export, in the order the user can fix it. */
  const blocker = !output?.relativePath ? "Generate an image in the Editor first."
    : draft ? "This image is still a draft. Generate it before exporting."
      : !desktop ? "Exporting is available in the Slopus desktop app."
        : null;
  const disabled = blocker !== null || exporting;
  const [preferences, setPreferences] = useState(loadPreferences);
  const choose = (patch: Partial<typeof preferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* remembered for this session only */ }
  };

  /* Generation sizes use a 32-pixel grid; exports use standard exact ratios.
     A saved image retains its authored aspect even if project settings change. */
  const original = output?.width && output?.height ? { width: output.width, height: output.height } : null;
  const aspectRatio = output?.imageGeneration?.aspectRatio ?? config.settings.aspectRatio;
  const sizes = exportSizeChoices(original, aspectRatio, "original")
    .map((size, index) => original && index === 0 ? { ...size, value: "original" } : size);
  const [chosenSize, setChosenSize] = useState<string | null>(null);
  const size = sizes.find((candidate) => candidate.value === chosenSize) ?? sizes[0];

  const exportImage = async () => {
    if (!output?.relativePath || disabled) return;
    setExporting(true); setError(null);
    try {
      await invoke("export_generated_image", {
        folderPath,
        relativePath: output.relativePath,
        options: { format: preferences.format, width: size?.width, height: size?.height, quality: preferences.format === "jpg" ? preferences.quality : undefined },
      });
    }
    catch (reason) { setError(String(reason)); }
    finally { setExporting(false); }
  };


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
        {images.length > 0 && <ImageBar images={images} selectedId={output?.id} folderPath={folderPath} onSelect={(id) => { setChosenId(id); setError(null); }} />}
      </section>

      <Splitter {...settingsPane.splitterProps} reverse aria-label="Resize export settings" aria-controls="image-export-settings" />

      {/* No title: the pane opens on its first section, like every inspector. */}
      <section id="image-export-settings" className="export-settings" aria-label="Export settings">
        <div className="export-settings__scroll">
          <PropSection title="Output" persistKey="export.image.output">
            <PropRow label="Resolution" htmlFor="image-export-resolution">
              <ComboBox
                id="image-export-resolution"
                value={size?.value ?? ""}
                disabled={exporting || sizes.length === 0}
                placeholder="Generate an image first"
                onChange={setChosenSize}
                options={sizes.map((candidate) => ({ value: candidate.value, label: candidate.label }))}
              />
            </PropRow>
            <PropRow label="Format" htmlFor="image-export-format">
              <ComboBox
                id="image-export-format"
                value={preferences.format}
                disabled={exporting}
                onChange={(value) => choose({ format: value as ImageFormat })}
                options={[{ value: "jpg", label: "JPG" }, { value: "png", label: "PNG · lossless" }]}
              />
            </PropRow>
            {preferences.format === "jpg" && <PropRow label="Quality" value={preferences.quality} defaultValue={DEFAULT_QUALITY} onReset={exporting ? undefined : () => choose({ quality: DEFAULT_QUALITY })} resetLabel="Reset quality">
              <Slider aria-label="JPG quality" min={1} max={100} step={1} value={preferences.quality} disabled={exporting} onChange={(quality) => choose({ quality })} />
              <span className="export-quality__value">{preferences.quality}</span>
            </PropRow>}
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
              {...tooltipProps(exporting ? "Export is running" : blocker ?? `Save the image as ${preferences.format.toUpperCase()}`)}
            >{exporting ? "Exporting…" : "Export…"}</button>
          </div>
        </div>
      </section>
    </div>
  </div>;
}
