import { BookOpen, ChevronRight, FileText, ImagePlus, Link2, Plus, Search, Trash2, Upload, Users, X } from "lucide-react";
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
  selectedReferencePreset,
  type LocationSettings,
  type ReferencePreset,
  type ReferenceType,
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
  const [creatingReference, setCreatingReference] = useState(false);
  const [pickerSection, setPickerSection] = useState<ReferenceType | "image">("custom");
  const [pickerType, setPickerType] = useState<ReferenceType>("custom");
  const [pickerSubcategory, setPickerSubcategory] = useState("all");
  const [presetSearch, setPresetSearch] = useState("");
  const [locationPresetId, setLocationPresetId] = useState<string | null>(null);
  const [locationSettings, setLocationSettings] = useState<LocationSettings>({});
  const selected = config.references.find((ref) => ref.id === selectedId);
  const selectedImages = selected ? referenceImages(selected) : [];
  const selectedPreset = selected ? selectedReferencePreset(selected) : undefined;
  const selectedPresetIcon = selectedImages.length === 0 ? selectedPreset?.icon : undefined;
  const jobs = useMemo(() => config.generationJobs.filter((job) => job.referenceIds.includes(selectedId ?? "")), [config.generationJobs, selectedId]);
  const update = (id: string, patch: Partial<ProjectReference>) => onChange({ ...config, references: config.references.map((ref) => ref.id === id ? { ...ref, ...patch } : ref) });
  // Starts empty on purpose. Seeding it with the instruction text meant an
  // unedited definition shipped "Describe the traits…" to the model as if the
  // user had written it. The guidance lives in the field's placeholder instead.
  const addTextReference = (name = "New definition", description = "", intendedUse: ProjectReference["intendedUse"] = []) => {
    const id = `ref-${Date.now()}`;
    const reference: ProjectReference = { id, kind: "text", name, description, content: description || null, intendedUse, createdAt: new Date().toISOString() };
    onChange({ ...config, references: [reference, ...config.references] });
    setSelectedId(id);
    return id;
  };
  const openNewReference = () => {
    setCreatingReference(true);
    setPickerSection("custom");
    setPickerType("custom");
    setPickerSubcategory("all");
    setPresetSearch("");
    setPresetDialog(true);
  };
  const addImages = async () => {
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
      if (creatingReference) {
        const id = `ref-${stamp}`;
        const reference: ProjectReference = { id, kind: "text", name: imported[0].name, description: "", content: null, images, intendedUse: [], createdAt: new Date().toISOString() };
        onChange({ ...config, references: [reference, ...config.references] });
        setSelectedId(id);
        setPresetDialog(false);
        setCreatingReference(false);
      } else if (selected) {
        update(selected.id, { images: [...(selected.images ?? []), ...images] });
      }
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
  const openPresetPicker = () => {
    if (!selected) return;
    setCreatingReference(false);
    setPickerSection(referenceType(selected));
    setPickerType(referenceType(selected));
    setPickerSubcategory("all");
    setPresetSearch("");
    const location = locationSelectionFromPrompt(selected.description);
    setLocationPresetId(location?.preset.id ?? null);
    setLocationSettings(location?.settings ?? {});
    setPresetDialog(true);
  };
  const chooseCustom = () => {
    if (creatingReference) addTextReference();
    else if (selected) update(selected.id, { intendedUse: [] });
    else return;
    setPresetDialog(false);
    setCreatingReference(false);
  };
  const choosePreset = (preset: ReferencePreset) => {
    if (preset.type === "location") {
      setLocationPresetId(preset.id);
      setLocationSettings({});
      return;
    }
    if (creatingReference) addTextReference(preset.name, preset.prompt, [preset.type]);
    else if (selected) update(selected.id, { intendedUse: [preset.type], description: preset.prompt, content: preset.prompt });
    else return;
    setPresetDialog(false);
    setCreatingReference(false);
  };
  const chooseLocation = () => {
    const preset = REFERENCE_PRESETS.find((candidate) => candidate.type === "location" && candidate.id === locationPresetId);
    if (!preset) return;
    const prompt = composeLocationPrompt(preset, locationSettings);
    if (creatingReference) addTextReference(preset.name, prompt, ["location"]);
    else if (selected) update(selected.id, { intendedUse: ["location"], description: prompt, content: prompt });
    else return;
    setPresetDialog(false);
    setCreatingReference(false);
  };
  const visiblePresets = REFERENCE_PRESETS.filter((preset) => {
    if (preset.type !== pickerType) return false;
    if (pickerSubcategory !== "all" && preset.subcategory !== pickerSubcategory) return false;
    const query = presetSearch.trim().toLocaleLowerCase();
    return !query || `${preset.name} ${preset.prompt} ${preset.subcategory} ${preset.searchTerms ?? ""}`.toLocaleLowerCase().includes(query);
  });
  const subcategories = [...new Set(REFERENCE_PRESETS.filter((preset) => preset.type === pickerType).map((preset) => preset.subcategory))];
  const chosenLocationPreset = pickerType === "location"
    ? REFERENCE_PRESETS.find((preset) => preset.type === "location" && preset.id === locationPresetId)
    : undefined;

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
          <div className={`reference-detail-art${selectedImages.length > 0 || selectedPresetIcon ? " reference-detail-art--photo" : " reference-detail-art--text"}${selectedPresetIcon ? " reference-detail-art--preset" : ""}`}>
            {selectedImages.length > 0
              ? <div className="reference-detail-images">{selectedImages.map((image) => <ReferenceImage key={image.id} folderPath={folderPath} relativePath={image.relativePath} sourcePath={image.sourcePath} alt={image.name} />)}</div>
              : selectedPresetIcon
                ? <img className="reference-detail-preset-icon" src={selectedPresetIcon} alt={`${selected.name} reference icon`} />
              : <span><Users size={30} /></span>}
            {/* A caption only where there is no picture to look at. It used
                to print the file's path over the thumbnail, which is neither
                what the reference IS nor anything the user acts on. */}
            {selectedImages.length === 0 && !selectedPresetIcon && <em>{referenceKindLabel(selected)}</em>}
          </div>
          <div className="reference-fields">
            {referenceType(selected) === "custom" ? <label><span>Prompt</span><textarea value={selected.description} placeholder="Describe what should stay consistent — the traits, materials, colours, or wardrobe PolStudio should preserve across shots." onChange={(event) => update(selected.id, { description: event.target.value, content: event.target.value || null })} /></label> : <div className="reference-preset-summary">
              <span>Selection</span>
              <button onClick={openPresetPicker}>
                <span><b>{selectedReferencePreset(selected)?.name ?? `${referenceTypeLabel(referenceType(selected))} selection`}</b><small>{selected.description}</small></span>
                <ChevronRight size={17} />
              </button>
            </div>}
          </div>
          <section className="reference-type">
            <h3>Type</h3>
            <button className="reference-type__trigger" onClick={openPresetPicker} aria-haspopup="dialog">
              <span>{referenceTypeLabel(referenceType(selected))}</span><ChevronRight size={17} />
            </button>
          </section>
          <section className="reference-used-by">
            <h3>Used by <span>{jobs.length}</span></h3>
            {jobs.length ? jobs.map((job) => <div key={job.id}><span className={`job-link-dot job-link-dot--${job.status}`} /><div><b>{job.title}</b><small>{job.status} · {job.stage}</small></div><Link2 size={16} /></div>) : <p>No shots use this reference yet. Each new shot picks up the first two it can use from this list, so it will be used once it reaches the top two of those.</p>}
          </section>
        </> : <div className="reference-empty"><BookOpen size={26} /><b>Select a reference</b><p>Pick one from the library, or add a new one, to edit its definition and see which generations use it.</p></div>}
      </div>
    </aside>
    {presetDialog && (creatingReference || selected) && <div className="reference-dialog-backdrop"><div className="reference-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-preset-title">
      <header>
        <div><h2 id="reference-preset-title">{creatingReference ? "Add a reference" : "Choose a reference type"}</h2><p>Use text, a prepared definition, images, or any combination of text and images.</p></div>
        <button onClick={() => { setPresetDialog(false); setCreatingReference(false); }} aria-label="Close type picker"><X size={18} /></button>
      </header>
      <div className="reference-preset-dialog__body">
        <nav aria-label="Reference types">
          {REFERENCE_TYPES.map((type) => <button key={type.id} className={pickerSection === type.id ? "active" : ""} aria-pressed={pickerSection === type.id} onClick={() => { setPickerSection(type.id); setPickerType(type.id); setPickerSubcategory("all"); setPresetSearch(""); setLocationPresetId(null); setLocationSettings({}); }}>{type.label}<ChevronRight size={16} /></button>)}
          <button className={pickerSection === "image" ? "active" : ""} aria-pressed={pickerSection === "image"} onClick={() => setPickerSection("image")}>Image<ChevronRight size={16} /></button>
        </nav>
        <section>
          {pickerSection === "image" ? <div className="reference-custom-option reference-image-option">
            <ImagePlus size={28} />
            <h3>Reference images</h3>
            <p>{creatingReference ? "Choose one or more pictures. The new reference starts with an empty text prompt that you can describe later." : `Add one or more pictures to this reference. Its ${isReferenceDescribed(selected!) ? "text prompt is kept" : "text prompt can remain empty"}.`}</p>
            {!creatingReference && selectedImages.length > 0 && <small>{selectedImages.length} image{selectedImages.length === 1 ? "" : "s"} currently attached</small>}
            <button className="primary-button" onClick={() => void addImages()}><Upload size={16} /> {creatingReference ? "Choose images" : "Add images"}</button>
          </div> : pickerType === "custom" ? <div className="reference-custom-option">
            <FileText size={26} />
            <h3>Text prompt</h3>
            <p>{creatingReference ? "Create an empty text definition and write the prompt in Reference details." : "Keep the current prompt and edit it directly in Reference details."}</p>
            <button className="primary-button" onClick={chooseCustom}>Use Text</button>
          </div> : <>
            <label className="reference-preset-search"><Search size={17} /><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder={`Search ${referenceTypeLabel(pickerType).toLocaleLowerCase()} options`} aria-label="Search reference options" /></label>
            <div className="reference-subcategories" role="group" aria-label={`${referenceTypeLabel(pickerType)} subcategories`}>
              <button className={pickerSubcategory === "all" ? "active" : ""} aria-pressed={pickerSubcategory === "all"} onClick={() => setPickerSubcategory("all")}>All</button>
              {subcategories.map((subcategory) => <button key={subcategory} className={pickerSubcategory === subcategory ? "active" : ""} aria-pressed={pickerSubcategory === subcategory} onClick={() => setPickerSubcategory(subcategory)}>{subcategory}</button>)}
            </div>
            {chosenLocationPreset && <div className="reference-location-settings">
              <header><span><small>Location</small><b>{chosenLocationPreset.name}</b></span><button className="primary-button" onClick={chooseLocation}>Use location</button></header>
              <p>Add any combination. Each row is optional.</p>
              {LOCATION_SETTING_GROUPS.map((group) => <div key={group.id} className="reference-location-settings__group">
                <b>{group.label}</b>
                <span role="group" aria-label={group.label}>{group.options.map((option) => <button
                  key={option.id}
                  className={locationSettings[group.id] === option.id ? "active" : ""}
                  aria-pressed={locationSettings[group.id] === option.id}
                  onClick={() => setLocationSettings((current) => ({ ...current, [group.id]: current[group.id] === option.id ? undefined : option.id }))}
                >{option.label}</button>)}</span>
              </div>)}
              <small className="reference-location-settings__preview">{composeLocationPrompt(chosenLocationPreset, locationSettings)}</small>
            </div>}
            <div className="reference-preset-grid">
              {visiblePresets.map((preset) => <button key={preset.id} className={`${preset.id === locationPresetId ? "active" : ""}${preset.icon ? " reference-preset-card--with-icon" : ""}`.trim()} aria-pressed={preset.type === "location" ? preset.id === locationPresetId : undefined} onClick={() => choosePreset(preset)}>
                {preset.icon && <img className="reference-preset-icon" src={preset.icon} alt="" loading="lazy" />}
                <small>{preset.subcategory}</small><b>{preset.name}</b><span>{preset.prompt}</span>
              </button>)}
              {visiblePresets.length === 0 && <p>No options match that search.</p>}
            </div>
          </>}
        </section>
      </div>
    </div></div>}
    {importError && <div className="toast" role="alert"><strong>Couldn’t add image</strong><span>{importError}</span><button onClick={() => setImportError(null)}>Dismiss</button></div>}
  </div>;
}
