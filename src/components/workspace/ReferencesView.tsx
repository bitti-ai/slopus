import { BookOpen, ChevronRight, FileText, Image, Link2, Plus, Search, Trash2, Upload, Users, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { isReferenceDescribed, type ProjectConfig, type ProjectReference } from "../../lib/project";
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
const referenceKindLabel = (kind: ProjectReference["kind"]) =>
  kind === "text" ? "Text definition" : kind === "image" ? "Image" : kind === "video" ? "Video clip" : "Sound";

export function ReferencesView({ config, folderPath, onChange }: { config: ProjectConfig; folderPath: string; onChange: (next: ProjectConfig) => void }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(config.references[0]?.id);
  const [definitionDialog, setDefinitionDialog] = useState(false);
  const [definitionName, setDefinitionName] = useState("Visual style reference");
  const [definitionDescription, setDefinitionDescription] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [presetDialog, setPresetDialog] = useState(false);
  const [pickerType, setPickerType] = useState<ReferenceType>("custom");
  const [pickerSubcategory, setPickerSubcategory] = useState("all");
  const [presetSearch, setPresetSearch] = useState("");
  const [locationPresetId, setLocationPresetId] = useState<string | null>(null);
  const [locationSettings, setLocationSettings] = useState<LocationSettings>({});
  const selected = config.references.find((ref) => ref.id === selectedId);
  const jobs = useMemo(() => config.generationJobs.filter((job) => job.referenceIds.includes(selectedId ?? "")), [config.generationJobs, selectedId]);
  const update = (id: string, patch: Partial<ProjectReference>) => onChange({ ...config, references: config.references.map((ref) => ref.id === id ? { ...ref, ...patch } : ref) });
  // Starts empty on purpose. Seeding it with the instruction text meant an
  // unedited definition shipped "Describe the traits…" to the model as if the
  // user had written it. The guidance lives in the field's placeholder instead.
  const addTextReference = (name = "New definition", description = "") => {
    const id = `ref-${Date.now()}`;
    const reference: ProjectReference = { id, kind: "text", name, description, content: description || null, intendedUse: [], createdAt: new Date().toISOString() };
    onChange({ ...config, references: [reference, ...config.references] });
    setSelectedId(id);
  };
  const addDefinition = () => {
    addTextReference();
    setPickerType("custom");
    setPickerSubcategory("all");
    setPresetSearch("");
    setPresetDialog(true);
  };
  const addImage = async () => {
    setImportError(null);
    if (!isTauri()) {
      setDefinitionDialog(true);
      return;
    }
    try {
      const imported = await invoke<{ name: string; relativePath: string } | null>("choose_reference_image", { folderPath });
      if (!imported) return;
      const id = `ref-${Date.now()}`;
      // Empty on purpose, exactly like addTextReference. This field is compiled
      // into the prompt as the user's own account of the picture, so a filing
      // note here ("Visual reference copied into this portable project.") was
      // shipped to the model as if they had written it. The card says the
      // definition is missing instead of faking one.
      const reference: ProjectReference = { id, kind: "image", name: imported.name, description: "", relativePath: imported.relativePath, intendedUse: [], createdAt: new Date().toISOString() };
      onChange({ ...config, references: [reference, ...config.references] });
      setSelectedId(id);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const remove = () => {
    if (!selected) return;
    onChange({ ...config, references: config.references.filter((ref) => ref.id !== selected.id), generationJobs: config.generationJobs.map((job) => ({ ...job, referenceIds: job.referenceIds.filter((id) => id !== selected.id) })) });
    setSelectedId(config.references.find((ref) => ref.id !== selected.id)?.id);
  };
  const openPresetPicker = () => {
    if (!selected) return;
    setPickerType(referenceType(selected));
    setPickerSubcategory("all");
    setPresetSearch("");
    const location = locationSelectionFromPrompt(selected.description);
    setLocationPresetId(location?.preset.id ?? null);
    setLocationSettings(location?.settings ?? {});
    setPresetDialog(true);
  };
  const chooseCustom = () => {
    if (!selected) return;
    update(selected.id, { intendedUse: [] });
    setPresetDialog(false);
  };
  const choosePreset = (preset: ReferencePreset) => {
    if (!selected) return;
    if (preset.type === "location") {
      setLocationPresetId(preset.id);
      setLocationSettings({});
      return;
    }
    update(selected.id, { intendedUse: [preset.type], description: preset.prompt, content: preset.prompt });
    setPresetDialog(false);
  };
  const chooseLocation = () => {
    if (!selected) return;
    const preset = REFERENCE_PRESETS.find((candidate) => candidate.type === "location" && candidate.id === locationPresetId);
    if (!preset) return;
    const prompt = composeLocationPrompt(preset, locationSettings);
    update(selected.id, { intendedUse: ["location"], description: prompt, content: prompt });
    setPresetDialog(false);
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
        <div className="references-heading__actions">
          <button className="secondary-button" onClick={addDefinition}><FileText size={16} /> New definition</button>
          <button className="primary-button" onClick={() => void addImage()}><Upload size={16} /> Add image</button>
        </div>
      </header>
      <section className="reference-library" aria-labelledby="reference-library-heading">
        {/* Both regions used to start at h3, so the outline jumped h1 → h3. */}
        <h2 className="sr-only" id="reference-library-heading">Reference library</h2>
        <div className="reference-grid">
          {config.references.map((ref) => <button key={ref.id} className={selectedId === ref.id ? "selected" : ""} onClick={() => setSelectedId(ref.id)}>
            {ref.kind === "image" && (ref.relativePath || ref.sourcePath)
              ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={ref.relativePath} sourcePath={ref.sourcePath} alt={ref.name} /></span>
              : ref.kind === "image"
                ? <span className="reference-art"><Image size={26} /><em>Image file</em></span>
                : <span className="reference-copy-art"><FileText size={26} /><em>Text definition</em></span>}
            <span className="reference-card__body"><span><b>{ref.name}</b><small>{referenceKindLabel(ref.kind)}</small></span>{isReferenceDescribed(ref)
              ? <p>{ref.description}</p>
              : <p className="reference-card__incomplete">{ref.kind === "image"
                ? "Not described yet — the picture is sent, but nothing tells the engine what to keep."
                : "Not described yet — it won’t be used until you add a definition."}</p>}<span className="use-tags"><i>{referenceTypeLabel(referenceType(ref))}</i></span></span>
          </button>)}
          <button className="reference-add-card" onClick={() => void addImage()}><span><Plus size={22} /></span><b>Add a reference</b><small>Import an image or write a definition</small></button>
        </div>
      </section>
    </main>

    <aside className="reference-inspector">
      <div className="panel-chrome"><h2>Reference details</h2>{selected && <button onClick={remove} aria-label="Delete reference" title="Delete this reference"><Trash2 size={16} /></button>}</div>
      <div className="reference-inspector__scroll">
        {selected ? <>
          <div className={`reference-detail-art reference-detail-art--${selected.kind}${selected.kind === "image" && (selected.relativePath || selected.sourcePath) ? " reference-detail-art--photo" : ""}`}>
            {selected.kind === "image" && (selected.relativePath || selected.sourcePath)
              ? <ReferenceImage folderPath={folderPath} relativePath={selected.relativePath} sourcePath={selected.sourcePath} alt={selected.name} />
              : <span>{selected.kind === "image" ? <Image size={30} /> : <Users size={30} />}</span>}
            {/* A caption only where there is no picture to look at. It used
                to print the file's path over the thumbnail, which is neither
                what the reference IS nor anything the user acts on. */}
            {selected.kind !== "image" && <em>{referenceKindLabel(selected.kind)}</em>}
          </div>
          <div className="reference-fields">
            <label><span>Name</span><input value={selected.name} onChange={(event) => update(selected.id, { name: event.target.value || "Untitled reference" })} /></label>
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
    {definitionDialog && <div className="reference-dialog-backdrop"><div className="reference-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-dialog-title">
      <h2 id="reference-dialog-title">Define a visual reference</h2>
      <p>Image import is available in the desktop app. This browser preview will save an honest text definition without inventing a file path.</p>
      <label><span>Name</span><input value={definitionName} onChange={(event) => setDefinitionName(event.target.value)} /></label>
      <label><span>Definition</span><textarea value={definitionDescription} onChange={(event) => setDefinitionDescription(event.target.value)} placeholder="Describe the composition, materials, colors, or character traits to preserve." /></label>
      <div>
        <button className="secondary-button" onClick={() => setDefinitionDialog(false)}>Cancel</button>
        <button className="primary-button" disabled={!definitionName.trim() || !definitionDescription.trim()} onClick={() => { addTextReference(definitionName.trim(), definitionDescription.trim()); setDefinitionDialog(false); setDefinitionDescription(""); }}>Save text definition</button>
      </div>
    </div></div>}
    {presetDialog && selected && <div className="reference-dialog-backdrop"><div className="reference-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-preset-title">
      <header>
        <div><h2 id="reference-preset-title">Choose a reference type</h2><p>Pick one type and one prepared option, or keep a custom prompt.</p></div>
        <button onClick={() => setPresetDialog(false)} aria-label="Close type picker"><X size={18} /></button>
      </header>
      <div className="reference-preset-dialog__body">
        <nav aria-label="Reference types">
          {REFERENCE_TYPES.map((type) => <button key={type.id} className={pickerType === type.id ? "active" : ""} aria-pressed={pickerType === type.id} onClick={() => { setPickerType(type.id); setPickerSubcategory("all"); setPresetSearch(""); setLocationPresetId(null); setLocationSettings({}); }}>{type.label}<ChevronRight size={16} /></button>)}
        </nav>
        <section>
          {pickerType === "custom" ? <div className="reference-custom-option">
            <FileText size={26} />
            <h3>Custom prompt</h3>
            <p>Keep the current prompt and edit it directly in Reference details.</p>
            <button className="primary-button" onClick={chooseCustom}>Use Custom</button>
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
              {visiblePresets.map((preset) => <button key={preset.id} className={preset.id === locationPresetId ? "active" : ""} aria-pressed={preset.type === "location" ? preset.id === locationPresetId : undefined} onClick={() => choosePreset(preset)}>
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
