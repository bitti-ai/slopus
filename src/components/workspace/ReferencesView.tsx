import { BookOpen, ChevronRight, FileText, ImagePlus, Link2, Plus, Search, Trash2, Users, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { isReferenceDescribed, referenceImages, type ProjectConfig, type ProjectReference, type ProjectReferenceImage } from "../../lib/project";
import {
  composeLocationPrompt,
  locationSelectionFromPrompt,
  REFERENCE_PRESETS,
  REFERENCE_TYPES,
  referenceType,
  referenceTypeLabel,
  referenceSubcategories,
  selectedReferencePreset,
  type ReferencePreset,
  type PresetReferenceType,
} from "../../lib/reference-presets";
import { LOCATION_SETTING_GROUPS } from "../../lib/expanded-reference-options";
import { isTauri } from "../../lib/persistence";
import { ReferenceImage } from "./ReferenceImage";

/** What a reference IS, in a word. This replaced the file path in both places
 *  it used to be printed: a path is a fact about the disk, not about the
 *  reference, and neither the card nor the inspector does anything with it. */
const referenceKindLabel = (reference: ProjectReference) => {
  const count = referenceImages(reference).length;
  if (count === 0) return reference.kind === "video" ? "Video clip" : reference.kind === "audio" ? "Sound" : "Text definition";
  return `${count} image${count === 1 ? "" : "s"}${isReferenceDescribed(reference) ? " + text" : ""}`;
};

export function ReferencesView({ config, folderPath, onChange }: { config: ProjectConfig; folderPath: string; onChange: (next: ProjectConfig) => void }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(config.references[0]?.id);
  const [importError, setImportError] = useState<string | null>(null);
  const [presetDialog, setPresetDialog] = useState(false);
  const [pickerType, setPickerType] = useState<PresetReferenceType>("character");
  const [pickerSubcategory, setPickerSubcategory] = useState("all");
  const [presetSearch, setPresetSearch] = useState("");
  const selected = config.references.find((ref) => ref.id === selectedId);
  const selectedImages = selected ? referenceImages(selected) : [];
  const selectedPreset = selected ? selectedReferencePreset(selected) : undefined;
  const selectedType = selected ? referenceType(selected) : "custom";
  const selectedSubcategory = selected?.subcategory ?? selectedPreset?.subcategory ?? "";
  const selectedLocation = useMemo(() => selected && referenceType(selected) === "location"
    ? locationSelectionFromPrompt(selected.description)
    : undefined, [selected]);
  const selectedPresetIcon = selectedImages.length === 0 ? selectedPreset?.icon : undefined;
  const jobs = useMemo(() => config.generationJobs.filter((job) => job.referenceIds.includes(selectedId ?? "")), [config.generationJobs, selectedId]);
  const update = (id: string, patch: Partial<ProjectReference>) => onChange({ ...config, references: config.references.map((ref) => ref.id === id ? { ...ref, ...patch } : ref) });
  // Starts empty on purpose. Seeding it with the instruction text meant an
  // unedited definition shipped "Describe the traits…" to the model as if the
  // user had written it. The guidance lives in the field's placeholder instead.
  const addTextReference = (name: string, description: string, type: PresetReferenceType, subcategory = "") => {
    const id = `ref-${crypto.randomUUID()}`;
    const reference: ProjectReference = { id, kind: "text", name, description, content: description || null, intendedUse: [type], subcategory, createdAt: new Date().toISOString() };
    onChange({ ...config, references: [reference, ...config.references] });
    setSelectedId(id);
    return id;
  };
  const openNewReference = () => {
    setPickerType("character");
    setPickerSubcategory("all");
    setPresetSearch("");
    setPresetDialog(true);
  };
  const addImages = async () => {
    if (!selected) return;
    setImportError(null);
    if (!isTauri()) {
      setImportError("Image import is available in the desktop app.");
      return;
    }
    try {
      const imported = await invoke<Array<{ name: string; relativePath: string }>>("choose_reference_images", { folderPath });
      if (imported.length === 0) return;
      const stamp = Date.now();
      const images: ProjectReferenceImage[] = imported.map((image, index) => ({
        id: `ref-image-${stamp}-${index + 1}`,
        name: image.name,
        relativePath: image.relativePath,
      }));
      update(selected.id, { images: [...(selected.images ?? []), ...images] });
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const remove = () => {
    if (!selected) return;
    onChange({ ...config, references: config.references.filter((ref) => ref.id !== selected.id), generationJobs: config.generationJobs.map((job) => ({
      ...job,
      referenceIds: job.referenceIds.filter((id) => id !== selected.id),
      startFrameReferenceId: job.startFrameReferenceId === selected.id ? undefined : job.startFrameReferenceId,
    })) });
    setSelectedId(config.references.find((ref) => ref.id !== selected.id)?.id);
  };
  const createEmptyReference = () => {
    addTextReference(`New ${referenceTypeLabel(pickerType).toLocaleLowerCase()}`, "", pickerType, pickerSubcategory === "all" ? "" : pickerSubcategory);
    setPresetDialog(false);
  };
  const choosePreset = (preset: ReferencePreset) => {
    const prompt = preset.type === "location"
      ? composeLocationPrompt(preset, {})
      : preset.prompt;
    addTextReference(preset.name, prompt, preset.type, preset.subcategory);
    setPresetDialog(false);
  };
  const visiblePresets = REFERENCE_PRESETS.filter((preset) => {
    if (preset.type !== pickerType) return false;
    if (pickerSubcategory !== "all" && preset.subcategory !== pickerSubcategory) return false;
    const query = presetSearch.trim().toLocaleLowerCase();
    return !query || `${preset.name} ${preset.prompt} ${preset.subcategory} ${preset.searchTerms ?? ""}`.toLocaleLowerCase().includes(query);
  });
  const subcategories = referenceSubcategories(pickerType);

  return <div className="references-view">
    <main className="references-main">
      <header className="references-heading">
        <div className="references-heading__title">
          <h1>References</h1>
          <p>{config.references.length === 1 ? "1 reference" : `${config.references.length} references`}</p>
        </div>
      </header>
      <section className="reference-library" aria-labelledby="reference-library-heading">
        {/* Both regions used to start at h3, so the outline jumped h1 → h3. */}
        <h2 className="sr-only" id="reference-library-heading">Reference library</h2>
        <div className="reference-grid">
          {config.references.map((ref) => {
            const images = referenceImages(ref);
            const cover = images[0];
            const presetIcon = selectedReferencePreset(ref)?.icon;
            return <button key={ref.id} className={selectedId === ref.id ? "selected" : ""} onClick={() => setSelectedId(ref.id)}>
            {cover
              ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={cover.relativePath} sourcePath={cover.sourcePath} alt={cover.name} /></span>
              : ref.iconRelativePath
                ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={ref.iconRelativePath} alt={`${ref.name} icon`} /></span>
              : presetIcon
                ? <span className="reference-art reference-art--photo"><img src={presetIcon} alt="" /></span>
              : <span className="reference-copy-art"><FileText size={26} /><em>Text definition</em></span>}
            <span className="reference-card__body"><span><b>{ref.name}</b><small>{referenceKindLabel(ref)}</small></span>{isReferenceDescribed(ref)
              ? <p>{ref.description}</p>
              : <p className="reference-card__incomplete">{images.length > 0
                ? "Not described yet — the picture is sent, but nothing tells the engine what to keep."
                : "Not described yet — it won’t be used until you add a definition."}</p>}<span className="use-tags"><i>{referenceTypeLabel(referenceType(ref))}</i></span></span>
          </button>;
          })}
          <button className="reference-add-card" onClick={openNewReference}><span><Plus size={22} /></span><b>Add a reference</b><small>Import images or write a definition</small></button>
        </div>
      </section>
    </main>

    <aside className="reference-inspector">
      <header className="reference-inspector__head">{selected ? <>
        <h2><input
          className="reference-title__name"
          value={selected.name}
          aria-label="Reference name"
          title="Rename this reference"
          onChange={(event) => update(selected.id, { name: event.target.value || "Untitled reference" })}
        /></h2>
        <button className="inspector-remove-button" onClick={remove} aria-label="Remove reference" title="Remove this reference"><Trash2 size={16} aria-hidden="true" /></button>
      </> : <h2>Reference details</h2>}</header>
      <div className="reference-inspector__scroll">
        {selected ? <>
          <div className={`reference-detail-art${selectedImages.length > 0 || selected.iconRelativePath || selectedPresetIcon ? " reference-detail-art--photo" : " reference-detail-art--text"}${selectedPresetIcon || selected.iconRelativePath ? " reference-detail-art--preset" : ""}`}>
            {selectedImages.length > 0
              ? <div className="reference-detail-images">{selectedImages.map((image) => <ReferenceImage key={image.id} folderPath={folderPath} relativePath={image.relativePath} sourcePath={image.sourcePath} alt={image.name} />)}</div>
              : selected.iconRelativePath
                ? <ReferenceImage className="reference-detail-preset-icon" folderPath={folderPath} relativePath={selected.iconRelativePath} alt={`${selected.name} reference icon`} />
              : selectedPresetIcon
                ? <img className="reference-detail-preset-icon" src={selectedPresetIcon} alt={`${selected.name} reference icon`} />
              : <span><Users size={30} /></span>}
            {/* A caption only where there is no picture to look at. It used
                to print the file's path over the thumbnail, which is neither
                what the reference IS nor anything the user acts on. */}
            {selectedImages.length === 0 && !selected.iconRelativePath && !selectedPresetIcon && <em>{referenceKindLabel(selected)}</em>}
          </div>
          <div className="reference-fields">
            <label><span>Prompt</span><textarea value={selected.description} placeholder="Describe what should stay consistent — the traits, materials, colours, or wardrobe Slopus should preserve across shots." onChange={(event) => update(selected.id, { description: event.target.value, content: event.target.value || null, subcategory: selectedSubcategory })} /></label>
            <div className="reference-fields__actions">
              <button className="secondary-button" onClick={() => void addImages()}><ImagePlus size={16} /> Add images</button>
            </div>
          </div>
          {selectedLocation && <section className="reference-location-settings" aria-label="Location settings">
            {LOCATION_SETTING_GROUPS.map((group) => <label key={group.id} className="reference-location-settings__group">
              <span>{group.label}</span>
              <select value={selectedLocation.settings[group.id] ?? ""} onChange={(event) => {
                const prompt = composeLocationPrompt(selectedLocation.preset, { ...selectedLocation.settings, [group.id]: event.target.value || undefined });
                update(selected.id, { description: prompt, content: prompt });
              }}>
                <option value="">None</option>
                {group.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>)}
          </section>}
          <section className="reference-type" aria-label="Reference classification">
            <label><span>Category</span><select value={selectedType} onChange={(event) => update(selected.id, { intendedUse: [event.target.value as PresetReferenceType], subcategory: "" })}>
              {selectedType === "custom" && <option value="custom" disabled>Uncategorized</option>}
              {REFERENCE_TYPES.map((type) => <option key={type.id} value={type.id}>{type.label}</option>)}
            </select></label>
            {selectedType !== "custom" && <label><span>Subcategory</span><select value={selectedSubcategory} onChange={(event) => update(selected.id, { subcategory: event.target.value })}>
              <option value="">None</option>
              {referenceSubcategories(selectedType).map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>)}
            </select></label>}
          </section>
          <section className="reference-used-by">
            <h3>Used by <span>{jobs.length}</span></h3>
            {jobs.length ? jobs.map((job) => <div key={job.id}><span className={`job-link-dot job-link-dot--${job.status}`} /><div><b>{job.title}</b><small>{job.status} · {job.stage}</small></div><Link2 size={16} /></div>) : <p>No shots use this reference yet. Each new shot picks up the first two it can use from this list, so it will be used once it reaches the top two of those.</p>}
          </section>
        </> : <div className="reference-empty"><BookOpen size={26} /><b>Select a reference</b><p>Pick one from the library, or add a new one, to edit its definition and see which generations use it.</p></div>}
      </div>
    </aside>
    {presetDialog && <div className="reference-dialog-backdrop"><div className="reference-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-preset-title">
      <header>
        <div><h2 id="reference-preset-title">Add a reference</h2><p>Choose a preset or create a new reference, then add a prompt and images.</p></div>
        <button onClick={() => setPresetDialog(false)} aria-label="Close type picker"><X size={18} /></button>
      </header>
      <div className="reference-preset-dialog__body">
        <nav aria-label="Reference types">
          {REFERENCE_TYPES.map((type) => <button key={type.id} className={pickerType === type.id ? "active" : ""} aria-pressed={pickerType === type.id} onClick={() => { setPickerType(type.id); setPickerSubcategory("all"); setPresetSearch(""); }}>{type.label}<ChevronRight size={16} /></button>)}
        </nav>
        <section>
          <div className="reference-preset-toolbar">
            <label className="reference-preset-search"><Search size={17} /><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder={`Search ${referenceTypeLabel(pickerType).toLocaleLowerCase()} options`} aria-label="Search reference options" /></label>
            <button className="primary-button" onClick={createEmptyReference}><Plus size={16} aria-hidden="true" /> New</button>
          </div>
            <div className="reference-subcategories" role="group" aria-label={`${referenceTypeLabel(pickerType)} subcategories`}>
              <button className={pickerSubcategory === "all" ? "active" : ""} aria-pressed={pickerSubcategory === "all"} onClick={() => setPickerSubcategory("all")}>All</button>
              {subcategories.map((subcategory) => <button key={subcategory} className={pickerSubcategory === subcategory ? "active" : ""} aria-pressed={pickerSubcategory === subcategory} onClick={() => setPickerSubcategory(subcategory)}>{subcategory}</button>)}
            </div>
            <div className="reference-preset-grid">
              {visiblePresets.map((preset) => <button key={preset.id} className={preset.icon ? "reference-preset-card--with-icon" : undefined} onClick={() => choosePreset(preset)}>
                {preset.icon && <img className="reference-preset-icon" src={preset.icon} alt="" loading="lazy" />}
                <small>{preset.subcategory}</small><b>{preset.name}</b><span>{preset.prompt}</span>
              </button>)}
              {visiblePresets.length === 0 && <p>No options match that search.</p>}
            </div>
        </section>
      </div>
    </div></div>}
    {importError && <div className="toast" role="alert"><strong>Couldn’t add image</strong><span>{importError}</span><button onClick={() => setImportError(null)}>Dismiss</button></div>}
  </div>;
}
