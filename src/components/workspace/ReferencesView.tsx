import { BookOpen, ChevronRight, FileText, ImagePlus, Plus, RefreshCw, Search, Trash2, Users, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isReferenceDescribed, referenceImages, type ProjectConfig, type ProjectReference, type ProjectReferenceImage } from "../../lib/project";
import { activeReferenceRefmods } from "../../lib/project";
import {
  composeLocationPrompt,
  locationSelectionFromPrompt,
  REFERENCE_PRESETS,
  REFERENCE_TYPES,
  referenceType,
  referenceTypeLabel,
  referenceSubcategories,
  hasPresetIcon,
  selectedReferencePreset,
  type ReferencePreset,
  type PresetReferenceType,
  type ReferenceType,
} from "../../lib/reference-presets";
import { LOCATION_SETTING_GROUPS } from "../../lib/expanded-reference-options";
import { isTauri } from "../../lib/persistence";
import { ReferenceImage } from "./ReferenceImage";
import { PresetIcon } from "./PresetIcon";
import { ReferenceIconGenerationDialog } from "../ReferenceIconGenerationDialog";
import { builtinIconRevision, refreshBuiltinIcons, subscribeBuiltinIcons } from "../../lib/builtinReferenceIcons";
import { builtinIconVisitAction, saveBuiltinIconChoice } from "../../lib/referenceIconSettings";
import { ReferenceVideo } from "./ReferenceVideo";
import { MediaThumbnail } from "./MediaThumbnail";
import { inspectReferenceVideo } from "../../lib/referenceVideo";
import { DebugPromptDialog } from "./DebugPromptDialog";
import { referenceIconPrompt } from "../../lib/referenceIcons";
import { loadDebugOptionsEnabled, subscribeDebugOptions } from "../../lib/settings";

const PICKER_TYPES: ReadonlyArray<{ id: ReferenceType; label: string }> = [
  ...REFERENCE_TYPES, { id: "custom", label: "Other" },
];

/** What a reference IS, in a word. This replaced the file path in both places
 *  it used to be printed: a path is a fact about the disk, not about the
 *  reference, and neither the card nor the inspector does anything with it. */
const referenceKindLabel = (reference: ProjectReference) => {
  const count = referenceImages(reference).length;
  if (reference.refmods?.length) return `${reference.refmods.length} refmod${reference.refmods.length === 1 ? "" : "s"}`;
  if (reference.kind === "video") return `Video clip${count ? ` + ${count} image${count === 1 ? "" : "s"}` : ""}`;
  if (count === 0) return reference.kind === "audio" ? "Sound" : "Text definition";
  return `${count} image${count === 1 ? "" : "s"}${isReferenceDescribed(reference) ? " + text" : ""}`;
};

function ClipSecondsInput({ label, value, min, max = Number.MAX_SAFE_INTEGER, onChange }: {
  label: string; value: number; min: number; max?: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <label>{label}<input type="number" min={min} max={max} step={0.1} value={draft}
    onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
    onBlur={() => {
      const parsed = Number(draft);
      const next = draft.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
      setDraft(String(next)); onChange(next);
    }} /></label>;
}

export function ReferencesView({ config, folderPath, onChange, onRegenerateIcon, onGenerateBuiltinIcons, pendingIconIds = new Set<string>(), onOpenGenerator }: {
  config: ProjectConfig;
  folderPath: string;
  onChange: (next: ProjectConfig) => void;
  onRegenerateIcon?: (referenceId: string) => void;
  onGenerateBuiltinIcons?: () => void;
  pendingIconIds?: ReadonlySet<string>;
  onOpenGenerator?: (jobId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(config.references[0]?.id);
  const configRef = useRef(config);
  configRef.current = config;
  const debugEnabled = useSyncExternalStore(subscribeDebugOptions, loadDebugOptionsEnabled);
  const [showDebugIconPrompt, setShowDebugIconPrompt] = useState(false);
  useEffect(() => setShowDebugIconPrompt(false), [selectedId, debugEnabled]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importingFiles, setImportingFiles] = useState(false);
  const [iconError, setIconError] = useState<string | null>(null);
  const [presetDialog, setPresetDialog] = useState(false);
  const catalogVisit = useRef(0);
  useEffect(() => () => { catalogVisit.current += 1; }, []);
  const [builtinConfirmationCount, setBuiltinConfirmationCount] = useState(0);
  useSyncExternalStore(subscribeBuiltinIcons, builtinIconRevision);
  useEffect(() => {
    if (onGenerateBuiltinIcons && isTauri()) void refreshBuiltinIcons().catch((reason) => setIconError(String(reason)));
  }, [folderPath, Boolean(onGenerateBuiltinIcons)]);
  const [pickerType, setPickerType] = useState<ReferenceType>("character");
  const [pickerSubcategory, setPickerSubcategory] = useState("all");
  const [presetSearch, setPresetSearch] = useState("");
  const selected = config.references.find((ref) => ref.id === selectedId);
  const selectedImages = selected ? referenceImages(selected) : [];
  const hasRefmods = Boolean(selected?.refmods?.length);
  const showImages = selectedImages.length > 0 && !hasRefmods;
  const canGenerateIcon = Boolean(selected && (hasRefmods ? activeReferenceRefmods(selected).length : selected.description.trim()));
  const selectedPreset = selected ? selectedReferencePreset(selected) : undefined;
  const selectedType = selected ? referenceType(selected) : "custom";
  const selectedSubcategory = selected?.subcategory ?? selectedPreset?.subcategory ?? "";
  const selectedLocation = useMemo(() => selected && referenceType(selected) === "location"
    ? locationSelectionFromPrompt(selected.description)
    : undefined, [selected]);
  const selectedPresetIcon = selectedImages.length === 0 && hasPresetIcon(selectedPreset) ? selectedPreset : undefined;
  const jobs = useMemo(() => config.generationJobs.filter((job) => job.referenceIds.includes(selectedId ?? "")), [config.generationJobs, selectedId]);
  const update = (id: string, patch: Partial<ProjectReference>) => {
    const current = configRef.current;
    onChange({ ...current, references: current.references.map((ref) => ref.id === id ? { ...ref, ...patch } : ref) });
  };
  // Starts empty on purpose. Seeding it with the instruction text meant an
  // unedited definition shipped "Describe the traits…" to the model as if the
  // user had written it. The guidance lives in the field's placeholder instead.
  const addTextReference = (name: string, description: string, type: ReferenceType, subcategory = "") => {
    const id = `ref-${crypto.randomUUID()}`;
    const reference: ProjectReference = { id, kind: "text", name, description, content: description || null, intendedUse: type === "custom" ? [] : [type], subcategory, createdAt: new Date().toISOString() };
    onChange({ ...config, references: [reference, ...config.references] });
    setSelectedId(id);
    return id;
  };
  const openNewReference = () => {
    const visit = ++catalogVisit.current;
    setPickerType("character");
    setPickerSubcategory("all");
    setPresetSearch("");
    setPresetDialog(true);
    if (onGenerateBuiltinIcons && isTauri()) void refreshBuiltinIcons().then(() => {
      if (visit !== catalogVisit.current) return;
      const missing = REFERENCE_PRESETS.filter((preset) => !hasPresetIcon(preset)).length;
      if (!missing) return;
      const action = builtinIconVisitAction();
      if (action === "ask") setBuiltinConfirmationCount(missing);
      else if (action === "generate") onGenerateBuiltinIcons();
    }).catch((reason) => setIconError(String(reason)));
  };
  const remove = () => {
    if (!selected) return;
    onChange({ ...config, references: config.references.filter((ref) => ref.id !== selected.id), generationJobs: config.generationJobs.map((job) => ({
      ...job,
      referenceIds: job.referenceIds.filter((id) => id !== selected.id),
      startFrameReferenceId: job.startFrameReferenceId === selected.id ? undefined : job.startFrameReferenceId,
      endFrameReferenceId: job.endFrameReferenceId === selected.id ? undefined : job.endFrameReferenceId,
    })) });
    setSelectedId(config.references.find((ref) => ref.id !== selected.id)?.id);
  };
  const addFiles = async () => {
    if (!selected || hasRefmods || importingFiles) return;
    setImportError(null);
    if (!isTauri()) { setImportError("File import is available in the desktop app."); return; }
    setImportingFiles(true);
    try {
      const files = await invoke<Array<{ kind: "image" | "video" | "refmod"; name: string; relativePath?: string | null; sourcePath?: string | null }>>("choose_reference_files", { folderPath });
      if (!files.length) return;
      const clip = files.find((file) => file.kind === "video");
      const video = clip ? { startSeconds: 0, ...await inspectReferenceVideo(folderPath, clip.sourcePath!) } : undefined;
      const current = configRef.current;
      const target = current.references.find((reference) => reference.id === selected.id);
      if (!target) throw new Error("The reference was removed while the files were importing.");
      if (target.refmods?.length) throw new Error("Remove the refmods before adding more files.");
      const images: ProjectReferenceImage[] = files.filter((file) => file.kind === "image").map((file) => ({
        id: `ref-image-${crypto.randomUUID()}`, name: file.name, relativePath: file.relativePath, sourcePath: file.sourcePath,
      }));
      const refmods = files.filter((file) => file.kind === "refmod").map((file) => ({
        id: `refmod-${crypto.randomUUID()}`, name: file.name, relativePath: file.relativePath, sourcePath: file.sourcePath, strength: 1, copies: 1,
      }));
      update(target.id, {
        ...(clip ? { kind: "video", relativePath: null, sourcePath: clip.sourcePath, video } : {}),
        images: [...(clip ? referenceImages(target) : target.images ?? []), ...images],
        ...(refmods.length ? { refmods: [...(target.refmods ?? []), ...refmods], iconRelativePath: undefined } : {}),
      });
    } catch (reason) { setImportError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setImportingFiles(false); }
  };
  const createEmptyReference = () => {
    addTextReference(pickerType === "custom" ? "Uncategorized" : `New ${referenceTypeLabel(pickerType).toLocaleLowerCase()}`, "", pickerType, pickerSubcategory === "all" ? "" : pickerSubcategory);
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
            const matchedPreset = selectedReferencePreset(ref);
            const presetIcon = hasPresetIcon(matchedPreset) ? matchedPreset : undefined;
            return <button key={ref.id} className={selectedId === ref.id ? "selected" : ""} onClick={() => setSelectedId(ref.id)}>
            {ref.kind === "video"
              ? <span className="reference-art reference-art--photo"><MediaThumbnail
                  key={JSON.stringify([folderPath, ref.sourcePath, ref.relativePath])}
                  folderPath={folderPath}
                  asset={{ id: ref.id, kind: "video", name: ref.name, sourcePath: ref.sourcePath, relativePath: ref.relativePath, mimeType: "video/mp4", createdAt: ref.createdAt }}
                  posterTimeSeconds={0}
                /></span>
              : ref.refmods?.length && ref.iconRelativePath
                ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={ref.iconRelativePath} alt={`${ref.name} icon`} /></span>
              : cover
              ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={cover.relativePath} sourcePath={cover.sourcePath} alt={cover.name} /></span>
              : ref.iconRelativePath
                ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={ref.iconRelativePath} alt={`${ref.name} icon`} /></span>
              : presetIcon
                ? <span className="reference-art reference-art--photo"><PresetIcon preset={presetIcon} /></span>
              : <span className="reference-copy-art"><FileText size={26} /></span>}
            <span className="reference-card__body"><span><b>{ref.name}</b>{(images.length > 0 || ref.refmods?.length || ref.kind === "video" || ref.kind === "audio") && <small>{referenceKindLabel(ref)}</small>}</span>{isReferenceDescribed(ref)
              ? <p>{ref.description}</p>
              : <p className="reference-card__incomplete">{ref.refmods?.length ? "Pre-encoded reference." : ref.kind === "video" ? "The clip is sent as a reference. Add a prompt to describe what to keep." : images.length > 0
                ? "Not described yet — the picture is sent, but nothing tells the engine what to keep."
                : "Not described yet — it won’t be used until you add a definition."}</p>}<span className="use-tags"><i>{referenceTypeLabel(referenceType(ref))}</i></span></span>
          </button>;
          })}
          <button className="reference-add-card" onClick={openNewReference}><span><Plus size={22} /></span><b>Add a reference</b><small>Add images, video, or a definition</small></button>
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
          {selected.kind === "video" && <section className="reference-video" aria-label="Video reference">
            <ReferenceVideo folderPath={folderPath} reference={selected} />
            <p>Use 2–15 seconds per clip, up to 3 clips totaling 15 seconds. Requires a Ref2VA generator. Supports CUDA and Vulkan.</p>
            <ClipSecondsInput key={`${selected.id}-start`} label="Clip start (seconds)" min={0} value={selected.video?.startSeconds ?? 0}
              onChange={(startSeconds) => update(selected.id, { video: { durationSeconds: 2, includeAudio: true, ...selected.video, startSeconds } })} />
            <ClipSecondsInput key={`${selected.id}-duration`} label="Clip duration (seconds)" min={2} max={15} value={selected.video?.durationSeconds ?? 2}
              onChange={(durationSeconds) => update(selected.id, { video: { startSeconds: 0, includeAudio: true, ...selected.video, durationSeconds } })} />
            <label><input type="checkbox" checked={selected.video?.includeAudio ?? true}
              onChange={(event) => update(selected.id, { video: { startSeconds: 0, durationSeconds: 2, ...selected.video, includeAudio: event.target.checked } })} /> Include sound</label>
            <button className="secondary-button" onClick={() => update(selected.id, { kind: "text", sourcePath: null, relativePath: null, video: undefined })}><Trash2 size={16} /> Remove video</button>
          </section>}
          {(selected.kind !== "video" || showImages || hasRefmods) && <div className={`reference-detail-art${showImages || selected.iconRelativePath || (!hasRefmods && selectedPresetIcon) ? " reference-detail-art--photo" : " reference-detail-art--text"}${(!hasRefmods && selectedPresetIcon) || selected.iconRelativePath ? " reference-detail-art--preset" : ""}`}>
            {showImages
              ? <div className="reference-detail-images">{selectedImages.map((image) => <ReferenceImage key={image.id} folderPath={folderPath} relativePath={image.relativePath} sourcePath={image.sourcePath} alt={image.name} />)}</div>
              : selected.iconRelativePath
                ? <ReferenceImage className="reference-detail-preset-icon" folderPath={folderPath} relativePath={selected.iconRelativePath} alt={`${selected.name} reference icon`} />
              : !hasRefmods && selectedPresetIcon
                ? <PresetIcon className="reference-detail-preset-icon" preset={selectedPresetIcon} alt={`${selected.name} reference icon`} />
              : <span><Users size={30} /></span>}
            {/* A caption only where there is no picture to look at. It used
                to print the file's path over the thumbnail, which is neither
                what the reference IS nor anything the user acts on. */}
            {!showImages && !selected.iconRelativePath && (hasRefmods || !selectedPresetIcon) && <em>{referenceKindLabel(selected)}</em>}
            {!showImages && onRegenerateIcon && <button
              type="button"
              className="reference-icon-refresh"
              aria-label="Regenerate reference icon"
              title={pendingIconIds.has(selected.id) ? "Icon generation queued or running" : canGenerateIcon ? "Regenerate reference icon" : hasRefmods ? "Enable a refmod to generate an icon" : "Add a prompt to generate an icon"}
              disabled={!canGenerateIcon || pendingIconIds.has(selected.id)}
              onClick={() => {
                setIconError(null);
                try { onRegenerateIcon(selected.id); }
                catch (reason) { setIconError(reason instanceof Error ? reason.message : String(reason)); }
              }}
            ><RefreshCw size={14} aria-hidden="true" /></button>}
          </div>}
          <div className="reference-fields">
            <label><span>Prompt</span><textarea disabled={hasRefmods} value={selected.description} placeholder="Describe what should stay consistent — the traits, materials, colours, or wardrobe Slopus should preserve across shots." onChange={(event) => update(selected.id, { description: event.target.value, content: event.target.value || null, subcategory: selectedSubcategory })} /></label>
            <div className="reference-fields__actions">
              <button className="secondary-button" disabled={importingFiles || hasRefmods} onClick={() => void addFiles()}><ImagePlus size={16} /> {importingFiles ? "Adding files…" : "Add file"}</button>
            </div>
            {hasRefmods && <p>Remove the refmods to edit the prompt or add files.</p>}
          </div>
          {hasRefmods && <section className="reference-refmods" aria-label="Refmod attachments">
            <header>
              <h3>Refmods</h3>
              <button type="button" className="inspector-remove-button" aria-label="Remove refmods" title="Remove all refmods" onClick={() => update(selected.id, { iconRelativePath: undefined, refmods: [] })}><Trash2 size={16} aria-hidden="true" /></button>
            </header>
            <p>Requires a Ref2VA generator. Strength 0 disables a refmod. More copies use more GPU memory.</p>
            {selected.refmods!.map((refmod) => <div key={refmod.id}>
              <b title={refmod.name}>{refmod.name}</b>
              <label>Strength<input aria-label={`${refmod.name} strength`} type="number" min={0} max={1} step={0.05} value={refmod.strength} onChange={(event) => {
                const strength = Number(event.target.value);
                if (event.target.value && Number.isFinite(strength) && strength >= 0 && strength <= 1) update(selected.id, { iconRelativePath: undefined, refmods: selected.refmods!.map((entry) => entry.id === refmod.id ? { ...entry, strength } : entry) });
              }} /></label>
              <label>Copies<input aria-label={`${refmod.name} copies`} type="number" min={1} max={10} step={1} value={refmod.copies} onChange={(event) => {
                const copies = Number(event.target.value);
                if (Number.isInteger(copies) && copies >= 1 && copies <= 10) update(selected.id, { iconRelativePath: undefined, refmods: selected.refmods!.map((entry) => entry.id === refmod.id ? { ...entry, copies } : entry) });
              }} /></label>
            </div>)}
          </section>}
          {selectedLocation && <section className="reference-location-settings" aria-label="Location settings">
            {LOCATION_SETTING_GROUPS.map((group) => <label key={group.id} className="reference-location-settings__group">
              <span>{group.label}</span>
              <select disabled={hasRefmods} value={selectedLocation.settings[group.id] ?? ""} onChange={(event) => {
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
            {jobs.length ? jobs.map((job) => <button type="button" key={job.id} onClick={() => onOpenGenerator?.(job.id)} title={`Open ${job.title}`}><b>{job.title}</b><ChevronRight size={16} aria-hidden="true" /></button>) : <p>No shots use this reference yet. Each new shot picks up the first two it can use from this list, so it will be used once it reaches the top two of those.</p>}
          </section>
        </> : <div className="reference-empty"><BookOpen size={26} /><b>Select a reference</b><p>Pick one from the library, or add a new one, to edit its definition and see which generations use it.</p></div>}
      </div>
      {debugEnabled && selected && <div className="debug-prompt">
        <button type="button" className="secondary-button debug-prompt__toggle" aria-haspopup="dialog" aria-expanded={showDebugIconPrompt} onClick={() => setShowDebugIconPrompt(true)}>Debug Icon Prompt</button>
      </div>}
    </aside>
    {debugEnabled && showDebugIconPrompt && selected && <DebugPromptDialog
      title="Debug Icon Prompt"
      promptLabel="The reference icon generation prompt"
      sceneTitle={selected.name}
      segments={[{ kind: "brief", value: referenceIconPrompt(selected) }]}
      onClose={() => setShowDebugIconPrompt(false)}
    />}
    {builtinConfirmationCount > 0 && <ReferenceIconGenerationDialog builtins count={builtinConfirmationCount} onAnswer={(confirmed, remember) => {
      setBuiltinConfirmationCount(0);
      if (remember) saveBuiltinIconChoice(confirmed);
      if (confirmed) {
        try { onGenerateBuiltinIcons?.(); }
        catch (reason) { setIconError(String(reason)); }
      }
    }} />}
    {presetDialog && builtinConfirmationCount === 0 && <div className="reference-dialog-backdrop"><div className="reference-preset-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-preset-title">
      <header>
        <div><h2 id="reference-preset-title">Add a reference</h2><p>Choose a preset or create a new reference, then add a prompt, images, or video.</p></div>
        <button onClick={() => { catalogVisit.current += 1; setPresetDialog(false); }} aria-label="Close type picker"><X size={18} /></button>
      </header>
      <div className="reference-preset-dialog__body">
        <nav aria-label="Reference types">
          {PICKER_TYPES.map((type) => <button key={type.id} className={pickerType === type.id ? "active" : ""} aria-pressed={pickerType === type.id} onClick={() => { setPickerType(type.id); setPickerSubcategory("all"); setPresetSearch(""); }}>{type.label}<ChevronRight size={16} /></button>)}
        </nav>
        <section>
          <div className="reference-preset-toolbar">
            {pickerType !== "custom" && <label className="reference-preset-search"><Search size={17} /><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder={`Search ${referenceTypeLabel(pickerType).toLocaleLowerCase()} options`} aria-label="Search reference options" /></label>}
            <button className="primary-button" onClick={createEmptyReference}><Plus size={16} aria-hidden="true" /> New</button>
          </div>
            {pickerType !== "custom" && <><div className="reference-subcategories" role="group" aria-label={`${referenceTypeLabel(pickerType)} subcategories`}>
              <button className={pickerSubcategory === "all" ? "active" : ""} aria-pressed={pickerSubcategory === "all"} onClick={() => setPickerSubcategory("all")}>All</button>
              {subcategories.map((subcategory) => <button key={subcategory} className={pickerSubcategory === subcategory ? "active" : ""} aria-pressed={pickerSubcategory === subcategory} onClick={() => setPickerSubcategory(subcategory)}>{subcategory}</button>)}
            </div>
            <div className="reference-preset-grid">
              {visiblePresets.map((preset) => <button key={preset.id} className={hasPresetIcon(preset) ? "reference-preset-card--with-icon" : undefined} onClick={() => choosePreset(preset)}>
                {hasPresetIcon(preset) && <PresetIcon className="reference-preset-icon" preset={preset} />}
                <small>{preset.subcategory}</small><b>{preset.name}</b><span>{preset.prompt}</span>
              </button>)}
              {visiblePresets.length === 0 && <p>No options match that search.</p>}
            </div></>}
        </section>
      </div>
    </div></div>}
    {importError && <div className="toast" role="alert"><strong>Couldn’t add reference</strong><span>{importError}</span><button onClick={() => setImportError(null)}>Dismiss</button></div>}
    {iconError && <div className="toast" role="alert"><strong>Couldn’t regenerate icon</strong><span>{iconError}</span><button onClick={() => setIconError(null)}>Dismiss</button></div>}
  </div>;
}
