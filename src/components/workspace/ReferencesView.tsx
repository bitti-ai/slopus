import { BookOpen, Check, FileText, Image, Link2, MoreHorizontal, Plus, Sparkles, Trash2, Upload, Users } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProjectConfig, ProjectReference } from "../../lib/project";

const uses = ["character", "product", "location", "style", "audio"] as const;

export function ReferencesView({ config, onChange }: { config: ProjectConfig; onChange: (next: ProjectConfig) => void }) {
  const [selectedId, setSelectedId] = useState<string | undefined>(config.references[0]?.id);
  const selected = config.references.find((ref) => ref.id === selectedId);
  const jobs = useMemo(() => config.generationJobs.filter((job) => job.referenceIds.includes(selectedId ?? "")), [config.generationJobs, selectedId]);
  const update = (id: string, patch: Partial<ProjectReference>) => onChange({ ...config, references: config.references.map((ref) => ref.id === id ? { ...ref, ...patch } : ref) });
  const addReference = (kind: "text" | "image") => {
    const id = `ref-${Date.now()}`;
    const reference: ProjectReference = { id, kind, name: kind === "text" ? "New definition" : "New visual reference", description: kind === "text" ? "Describe the traits Pol should keep consistent across generated clips." : "Visual reference added to this portable project.", ...(kind === "image" ? { relativePath: `references/reference-${Date.now()}.jpg` } : {}), intendedUse: [kind === "text" ? "character" : "style"], createdAt: new Date().toISOString() };
    onChange({ ...config, references: [reference, ...config.references] });
    setSelectedId(id);
  };
  const remove = () => {
    if (!selected) return;
    onChange({ ...config, references: config.references.filter((ref) => ref.id !== selected.id), generationJobs: config.generationJobs.map((job) => ({ ...job, referenceIds: job.referenceIds.filter((id) => id !== selected.id) })) });
    setSelectedId(config.references.find((ref) => ref.id !== selected.id)?.id);
  };

  return <div className="references-view">
    <header className="references-heading"><div><span className="eyebrow">Consistency library</span><h1>References</h1><p>Define the people, places, products, and visual rules Pol should preserve across every generation.</p></div><div><button className="secondary-button" onClick={() => addReference("text")}><FileText size={14} /> New definition</button><button className="primary-button" onClick={() => addReference("image")}><Upload size={14} /> Add image</button></div></header>
    <div className="reference-layout">
      <section className="reference-library">
        <div className="reference-library__toolbar"><span>{config.references.length} REFERENCES</span><button><MoreHorizontal size={15} /></button></div>
        <div className="reference-grid">
          {config.references.map((ref, index) => <button key={ref.id} className={`${selectedId === ref.id ? "selected" : ""} ref-card--${ref.kind}`} onClick={() => setSelectedId(ref.id)}>
            {ref.kind === "image" ? <span className={`reference-art reference-art--${index}`}><i /><em><Image size={14} /> IMAGE</em></span> : <span className="reference-copy-art"><i>{index === 0 ? "M" : "Aa"}</i><FileText size={14} /></span>}
            <span className="reference-card__body"><span><b>{ref.name}</b><small>{ref.kind === "text" ? "TEXT DEFINITION" : ref.relativePath}</small></span><p>{ref.description}</p><span className="use-tags">{ref.intendedUse.map((use) => <i key={use}>{use}</i>)}</span></span>
          </button>)}
          <button className="reference-add-card" onClick={() => addReference("image")}><span><Plus size={20} /></span><b>Add a reference</b><small>Image or text definition</small></button>
        </div>
        <div className="reference-explainer"><Sparkles size={17} /><div><b>References guide generation, not your timeline</b><p>Attach them to any job so characters, products, and art direction stay coherent. All files are copied into the project’s <code>references/</code> folder.</p></div></div>
      </section>

      <aside className="reference-inspector">
        <div className="panel-chrome"><span>Reference details</span>{selected && <button onClick={remove} aria-label="Delete reference"><Trash2 size={13} /></button>}</div>
        {selected ? <>
          <div className={`reference-detail-art reference-detail-art--${selected.kind}`}><span>{selected.kind === "image" ? <Image size={28} /> : <Users size={28} />}</span><em>{selected.kind === "image" ? selected.relativePath : "Reusable text definition"}</em></div>
          <div className="reference-fields"><label><span>NAME</span><input value={selected.name} onChange={(event) => update(selected.id, { name: event.target.value || "Untitled reference" })} /></label><label><span>DEFINITION</span><textarea value={selected.description} onChange={(event) => update(selected.id, { description: event.target.value || "Add a reference description." })} /></label></div>
          <section className="intended-use"><h3>INTENDED USE</h3><p>Tell Pol what must remain consistent.</p><div>{uses.map((use) => <button key={use} className={selected.intendedUse.includes(use) ? "active" : ""} onClick={() => update(selected.id, { intendedUse: selected.intendedUse.includes(use) ? selected.intendedUse.filter((item) => item !== use) : [...selected.intendedUse, use] })}>{selected.intendedUse.includes(use) && <Check size={11} />}{use}</button>)}</div></section>
          <section className="reference-used-by"><h3>USED BY <span>{jobs.length}</span></h3>{jobs.length ? jobs.map((job) => <div key={job.id}><span className={`job-link-dot job-link-dot--${job.status}`} /><div><b>{job.title}</b><small>{job.status} · {job.stage}</small></div><Link2 size={13} /></div>) : <p>No generation jobs use this reference yet.</p>}</section>
          <section className="portable-path"><BookOpen size={14} /><div><b>Portable project path</b><code>{selected.relativePath ?? "Stored in polstudio.project.json"}</code></div></section>
        </> : <div className="reference-empty"><BookOpen size={23} /><b>Select a reference</b><p>Its definition, intended use, and connected jobs will appear here.</p></div>}
      </aside>
    </div>
  </div>;
}
