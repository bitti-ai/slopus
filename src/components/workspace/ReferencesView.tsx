import { BookOpen, Check, FileText, Image, Link2, Plus, Sparkles, Trash2, Upload, Users } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { isReferenceDescribed, type ProjectConfig, type ProjectReference } from "../../lib/project";
import { isTauri } from "../../lib/persistence";
import { ReferenceImage } from "./ReferenceImage";

type ReferenceUse = ProjectReference["intendedUse"][number];

/* No "audio" here on purpose: references in this app are visual only. Images are
   the only assets sent to the video engine, and the H3 prompt's two audio fields
   (overall_soundscape, non_diegetic_music) are not reference-driven — so an
   audio tag promised a route that never existed. It stays in the zod enum so
   projects saved with it still load. */
const uses: readonly ReferenceUse[] = ["character", "product", "location", "style"];

export function ReferencesView({ config, folderPath, onChange }: { config: ProjectConfig; folderPath: string; onChange: (next: ProjectConfig) => void }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(config.references[0]?.id);
  const [definitionDialog, setDefinitionDialog] = useState(false);
  const [definitionName, setDefinitionName] = useState("Visual style reference");
  const [definitionDescription, setDefinitionDescription] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const selected = config.references.find((ref) => ref.id === selectedId);
  // A reference saved before the audio tag was withdrawn still carries it, so
  // keep the chip on that one reference — it can be seen and cleared, never
  // added fresh.
  const useOptions: readonly ReferenceUse[] = selected?.intendedUse.includes("audio") ? [...uses, "audio"] : uses;
  const jobs = useMemo(() => config.generationJobs.filter((job) => job.referenceIds.includes(selectedId ?? "")), [config.generationJobs, selectedId]);
  const update = (id: string, patch: Partial<ProjectReference>) => onChange({ ...config, references: config.references.map((ref) => ref.id === id ? { ...ref, ...patch } : ref) });
  // Starts empty on purpose. Seeding it with the instruction text meant an
  // unedited definition shipped "Describe the traits…" to the model as if the
  // user had written it. The guidance lives in the field's placeholder instead.
  const addTextReference = (name = "New definition", description = "") => {
    const id = `ref-${Date.now()}`;
    const reference: ProjectReference = { id, kind: "text", name, description, content: description || null, intendedUse: ["style"], createdAt: new Date().toISOString() };
    onChange({ ...config, references: [reference, ...config.references] });
    setSelectedId(id);
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
      const reference: ProjectReference = { id, kind: "image", name: imported.name, description: "", relativePath: imported.relativePath, intendedUse: ["style"], createdAt: new Date().toISOString() };
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

  return <div className="references-view">
    <header className="references-heading">
      <div>
        <span className="eyebrow">Consistency library</span>
        <h1>References</h1>
        <p>Keep the people, places, products, and visual rules for this project in one place. Each new shot uses the first two it can use from this list.</p>
      </div>
      <div>
        <button className="secondary-button" onClick={() => addTextReference()}><FileText size={16} /> New definition</button>
        <button className="primary-button" onClick={() => void addImage()}><Upload size={16} /> Add image</button>
      </div>
    </header>
    <div className="reference-layout">
      <section className="reference-library" aria-labelledby="reference-library-heading">
        {/* Both regions used to start at h3, so the outline jumped h1 → h3. */}
        <h2 className="sr-only" id="reference-library-heading">Reference library</h2>
        <div className="reference-library__toolbar"><span>{config.references.length === 1 ? "1 reference" : `${config.references.length} references`}</span></div>
        <div className="reference-grid">
          {config.references.map((ref) => <button key={ref.id} className={selectedId === ref.id ? "selected" : ""} onClick={() => setSelectedId(ref.id)}>
            {ref.kind === "image" && (ref.relativePath || ref.sourcePath)
              ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={ref.relativePath} sourcePath={ref.sourcePath} alt={ref.name} /></span>
              : ref.kind === "image"
                ? <span className="reference-art"><Image size={26} /><em>Image file</em></span>
                : <span className="reference-copy-art"><FileText size={26} /><em>Text definition</em></span>}
            <span className="reference-card__body"><span><b>{ref.name}</b><small>{ref.kind === "text" ? "Text definition" : ref.relativePath ?? ref.sourcePath}</small></span>{isReferenceDescribed(ref)
              ? <p>{ref.description}</p>
              : <p className="reference-card__incomplete">{ref.kind === "image"
                ? "Not described yet — the picture is sent, but nothing tells the engine what to keep."
                : "Not described yet — it won’t be used until you add a definition."}</p>}<span className="use-tags">{ref.intendedUse.map((use) => <i key={use}>{use}</i>)}</span></span>
          </button>)}
          <button className="reference-add-card" onClick={() => void addImage()}><span><Plus size={22} /></span><b>Add a reference</b><small>Import an image or write a definition</small></button>
        </div>
        <div className="reference-explainer"><Sparkles size={18} /><div><b>References guide new shots, not your timeline</b>{/* The rule the code actually implements: isReferenceUsable qualifies an
            image on its FILE alone, so an imported picture is bound and sent
            whether or not it has been described. Saying it was "skipped until
            you write its definition" contradicted the card 30px away, which
            correctly says the picture is sent. */}
        <p>Each new shot uses the first two it can use from this list. An image counts as soon as you import it: its file is copied into the project’s <code>references/</code> folder and sent to the video engine, and describing it tells the engine what to keep about it. A text definition isn’t used until you write it, and then it reaches the engine as words in the shot’s prompt. Newest additions go to the top.</p></div></div>
      </section>

      <aside className="reference-inspector">
        <div className="panel-chrome"><h2>Reference details</h2>{selected && <button onClick={remove} aria-label="Delete reference" title="Delete this reference"><Trash2 size={16} /></button>}</div>
        {selected ? <>
          <div className={`reference-detail-art reference-detail-art--${selected.kind}${selected.kind === "image" && (selected.relativePath || selected.sourcePath) ? " reference-detail-art--photo" : ""}`}>
            {selected.kind === "image" && (selected.relativePath || selected.sourcePath)
              ? <ReferenceImage folderPath={folderPath} relativePath={selected.relativePath} sourcePath={selected.sourcePath} alt={selected.name} />
              : <span>{selected.kind === "image" ? <Image size={30} /> : <Users size={30} />}</span>}
            <em>{selected.kind === "image" ? selected.relativePath ?? selected.sourcePath : "Reusable text definition"}</em>
          </div>
          <div className="reference-fields">
            <label><span>Name</span><input value={selected.name} onChange={(event) => update(selected.id, { name: event.target.value || "Untitled reference" })} /></label>
            <label><span>Definition</span><textarea value={selected.description} placeholder="Describe what should stay consistent — the traits, materials, colours, or wardrobe PolStudio should preserve across shots." onChange={(event) => update(selected.id, { description: event.target.value, content: event.target.value || null })} /></label>
          </div>
          <section className="intended-use">
            <h3>Intended use</h3>
            <p>These tags are your own notes for keeping the library tidy. They don’t change what is sent to the video engine. Select any that apply.</p>
            <div>{useOptions.map((use) => <button key={use} className={selected.intendedUse.includes(use) ? "active" : ""} aria-pressed={selected.intendedUse.includes(use)} onClick={() => update(selected.id, { intendedUse: selected.intendedUse.includes(use) ? selected.intendedUse.filter((item) => item !== use) : [...selected.intendedUse, use] })}>{selected.intendedUse.includes(use) && <Check size={14} />}{use}</button>)}</div>
          </section>
          <section className="reference-used-by">
            <h3>Used by <span>{jobs.length}</span></h3>
            {jobs.length ? jobs.map((job) => <div key={job.id}><span className={`job-link-dot job-link-dot--${job.status}`} /><div><b>{job.title}</b><small>{job.status} · {job.stage}</small></div><Link2 size={16} /></div>) : <p>No shots use this reference yet. Each new shot picks up the first two it can use from this list, so it will be used once it reaches the top two of those.</p>}
          </section>
          <section className="portable-path"><BookOpen size={16} /><div><b>Where this lives</b><code>{selected.relativePath ?? selected.sourcePath ?? "Stored in polstudio.json"}</code></div></section>
        </> : <div className="reference-empty"><BookOpen size={26} /><b>Select a reference</b><p>Pick one from the library, or add a new one, to edit its definition and see which generations use it.</p></div>}
      </aside>
    </div>
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
    {importError && <div className="toast" role="alert"><strong>Couldn’t add image</strong><span>{importError}</span><button onClick={() => setImportError(null)}>Dismiss</button></div>}
  </div>;
}
