import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Box, ChevronDown, ChevronRight, Copy, Download, Image, Plus, Redo2, Sparkles, Square, Trash2, Undo2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { addImageNode, createImageScene, duplicateImageNode, imageDescendants, imageScenePrompt, removeImageNode, resizeImageNode, type ImageBox, type ImageNode, type ImageScene } from "../../lib/imageScene";
import { outputDimensions } from "../../lib/export";
import { isTauri } from "../../lib/persistence";
import { PROJECT_RESOLUTIONS, type ProjectConfig } from "../../lib/project";
import { defaultGeneratorTemplate, loadGeneratorTemplateSettings, subscribeGeneratorTemplates, templateNeedsDownload, type GeneratorTemplate } from "../../lib/settings";
import { isWorkActive, type WorkItem } from "../../lib/workQueue";
import type { ConfigUpdate } from "./TimelineView";
import { ReferenceImage } from "./ReferenceImage";
import "../../styles/image-editor.css";

export function ImageEditor({ config, folderPath, onChange, onGenerate, onCancel, work }: {
  config: ProjectConfig; folderPath: string; onChange: (update: ConfigUpdate) => void;
  onGenerate: (template: GeneratorTemplate) => void; onCancel: (id: string) => Promise<void>; work?: WorkItem;
}) {
  const scene = useMemo(() => config.imageScene ?? createImageScene(config.brief.prompt), [config.imageScene, config.brief.prompt]);
  const root = scene.nodes.find((node) => node.kind === "root")!;
  const [selection, setSelection] = useState(root.id);
  const selected = scene.nodes.find((node) => node.id === selection) ?? root;
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [templates, setTemplates] = useState(loadGeneratorTemplateSettings);
  const [templateId, setTemplateId] = useState(() => localStorage.getItem("slopus.image-generator-template.v1") ?? defaultGeneratorTemplate().id);
  const imageTemplates = templates.templates.filter((template) => template.mode !== "animate");
  const template = imageTemplates.find((candidate) => candidate.id === templateId) ?? imageTemplates.find((candidate) => !templateNeedsDownload(candidate)) ?? imageTemplates[0];
  const [error, setError] = useState<string | null>(null);
  const [boxes, setBoxes] = useState(true);
  const [drawKind, setDrawKind] = useState<"object" | "text" | "group" | null>(null);
  const [zoom, setZoom] = useState(1);
  const [draftBox, setDraftBox] = useState<ImageBox | null>(null);
  const undo = useRef<ImageScene[]>([]);
  const redo = useRef<ImageScene[]>([]);
  const [, historyChanged] = useState(0);
  const pointer = useRef<{ x: number; y: number; scene: ImageScene; id?: string; resize: boolean } | null>(null);
  const active = work && isWorkActive(work);
  const output = config.assets.find((asset) => asset.id === scene.outputAssetId);
  const images = config.assets.filter((asset) => asset.kind === "image");
  const { width, height } = outputDimensions(config.settings.resolution, config.settings.aspectRatio);
  useEffect(() => subscribeGeneratorTemplates(() => setTemplates(loadGeneratorTemplateSettings())), []);

  const commit = (next: ImageScene) => {
    if (JSON.stringify(next) === JSON.stringify(scene)) return;
    undo.current = [...undo.current.slice(-99), scene]; redo.current = [];
    onChange((current) => ({ ...current, imageScene: { ...next, outputAssetId: current.imageScene?.outputAssetId ?? null } }));
    historyChanged((value) => value + 1);
  };
  const history = (back: boolean) => {
    const from = back ? undo : redo; const to = back ? redo : undo;
    const next = from.current.pop(); if (!next) return;
    to.current.push(scene);
    onChange((current) => ({ ...current, imageScene: { ...next, outputAssetId: current.imageScene?.outputAssetId ?? null } }));
    historyChanged((value) => value + 1);
  };
  const patchNode = (patch: Partial<ImageNode>) => commit({ ...scene, nodes: scene.nodes.map((node) => node.id === selected.id ? { ...node, ...patch } : node) });
  const add = (kind: Exclude<ImageNode["kind"], "root">, box?: ImageBox) => {
    const next = addImageNode(scene, selected.id, kind, box); commit(next); setSelection(next.nodes.at(-1)!.id);
    setCollapsed((current) => { const next = new Set(current); next.delete(selected.id); return next; });
  };
  const attempt = (action: () => void | Promise<unknown>) => {
    setError(null);
    try { void Promise.resolve(action()).catch((reason) => setError(String(reason))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(1000, (event.clientX - bounds.left) / bounds.width * 1000))), y: Math.round(Math.max(0, Math.min(1000, (event.clientY - bounds.top) / bounds.height * 1000))) };
  };
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || !boxes) return;
    const target = event.target as SVGElement;
    const id = drawKind ? undefined : target.dataset.node;
    if (!id && !drawKind) { setSelection(root.id); return; }
    if (id) setSelection(id);
    pointer.current = { ...point(event), scene, id, resize: target.dataset.resize === "true" };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const start = pointer.current; if (!start) return;
    const at = point(event); const original = start.scene.nodes.find((node) => node.id === start.id)?.box;
    if (original) {
      const x = start.resize ? original.x : Math.max(0, Math.min(1000 - original.width, original.x + at.x - start.x));
      const y = start.resize ? original.y : Math.max(0, Math.min(1000 - original.height, original.y + at.y - start.y));
      setDraftBox({ x, y, width: start.resize ? Math.max(1, Math.min(1000 - x, original.width + at.x - start.x)) : original.width, height: start.resize ? Math.max(1, Math.min(1000 - y, original.height + at.y - start.y)) : original.height });
    } else setDraftBox({ x: Math.min(start.x, at.x), y: Math.min(start.y, at.y), width: Math.abs(at.x - start.x), height: Math.abs(at.y - start.y) });
  };
  const pointerUp = () => {
    const start = pointer.current;
    if (start && draftBox && draftBox.width > 0 && draftBox.height > 0) {
      if (start.id) commit(resizeImageNode(start.scene, start.id, draftBox));
      else if (drawKind && draftBox.width >= 5 && draftBox.height >= 5) { add(drawKind, draftBox); setDrawKind(null); }
    }
    pointer.current = null; setDraftBox(null);
  };
  const descendants = imageDescendants(scene, selected.id);
  const tree = (node: ImageNode, depth: number) => {
    const children = scene.nodes.filter((child) => child.parentId === node.id);
    const open = !collapsed.has(node.id);
    return <div key={node.id} role="treeitem" aria-selected={selected.id === node.id} aria-expanded={children.length ? open : undefined}>
      <div className={`image-tree__row ${selected.id === node.id ? "selected" : ""}`} style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-4))` }}>
        {children.length ? <button className="icon-button" aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (open) next.add(node.id); else next.delete(node.id); return next; })}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="image-tree__spacer" />}
        <button className="image-tree__select" onClick={() => setSelection(node.id)}><span aria-hidden="true">{node.kind === "text" ? "T" : node.kind === "root" ? <Image size={16} /> : <Box size={16} />}</span><span>{node.name}</span></button>
      </div>
      {open && children.length > 0 && <div role="group">{children.map((child) => tree(child, depth + 1))}</div>}
    </div>;
  };
  return <div className="image-editor">
    <aside className="image-tree" aria-label="Image hierarchy">
      <header><strong>Scene</strong><div className="image-editor__actions"><button className="icon-button" title="Undo" aria-label="Undo image edit" disabled={!undo.current.length} onClick={() => history(true)}><Undo2 size={16} /></button><button className="icon-button" title="Redo" aria-label="Redo image edit" disabled={!redo.current.length} onClick={() => history(false)}><Redo2 size={16} /></button></div></header>
      <div className="image-tree__add">{(["object", "text", "group", "background"] as const).map((kind) => <button className="secondary-button" key={kind} onClick={() => add(kind)}><Plus size={14} />{kind[0].toUpperCase() + kind.slice(1)}</button>)}</div>
      <div role="tree" aria-label="Image nodes">{tree(root, 0)}</div>
      <div className="image-tree__footer"><button className="secondary-button" disabled={selected.kind === "root"} onClick={() => { const next = duplicateImageNode(scene, selected.id); commit(next); setSelection(next.nodes[scene.nodes.length].id); }}><Copy size={15} /> Duplicate</button><button className="icon-button" aria-label="Delete selected node and children" disabled={selected.kind === "root"} onClick={() => { commit(removeImageNode(scene, selected.id)); setSelection(selected.parentId ?? root.id); }}><Trash2 size={16} /></button></div>
    </aside>
    <section className="image-center" aria-label="Image panel">
      <header className="image-toolbar"><button className="primary-button" disabled={active ? work.cancelling || work.status === "encoding" : !isTauri() || !template || templateNeedsDownload(template) || !imageScenePrompt(scene)} onClick={() => attempt(() => active ? onCancel(work.id) : onGenerate(template!))}><Sparkles size={16} />{active ? work.cancelling ? "Cancelling…" : "Cancel" : "Generate"}</button>
        <label>Generator template<select aria-label="Image generator template" value={template?.id ?? ""} disabled={Boolean(active)} onChange={(event) => { setTemplateId(event.target.value); localStorage.setItem("slopus.image-generator-template.v1", event.target.value); const next = imageTemplates.find((candidate) => candidate.id === event.target.value); if (next) commit({ ...scene, steps: next.defaultSteps }); }}>
          {!imageTemplates.length && <option value="">No MiniMax H3 templates</option>}{imageTemplates.map((item) => <option key={item.id} value={item.id} disabled={templateNeedsDownload(item)}>{item.name}{templateNeedsDownload(item) ? " (download in Settings)" : ""}</option>)}
        </select></label><span className="image-model">MiniMax H3</span>
      </header>
      <div className="image-canvas-tools"><button className={`icon-button ${boxes ? "active" : ""}`} aria-label="Show placement boxes" aria-pressed={boxes} onClick={() => { setBoxes(!boxes); setDrawKind(null); }}><Square size={16} /></button>
        <select aria-label="Canvas tool" value={drawKind ?? "select"} onChange={(event) => { setDrawKind(event.target.value === "select" ? null : event.target.value as typeof drawKind); setBoxes(true); }}><option value="select">Select / move</option><option value="object">Draw object</option><option value="text">Draw text</option><option value="group">Draw group</option></select>
        <button className="secondary-button" onClick={() => setZoom(1)}>Fit</button><input aria-label="Image zoom" type="range" min="0.5" max="3" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><span>{Math.round(zoom * 100)}%</span>
        <button className="icon-button" aria-label="Export image" title="Export image" disabled={!output || !isTauri()} onClick={() => attempt(() => invoke("export_generated_image", { folderPath, relativePath: output!.relativePath }))}><Download size={16} /></button>
      </div>
      <div className="image-viewport"><div className="image-frame" style={{ "--image-ratio": width / height, "--image-zoom": zoom } as CSSProperties}>
        {output ? <ReferenceImage folderPath={folderPath} relativePath={output.relativePath} sourcePath={output.sourcePath} alt={output.name} /> : <div className="image-empty"><Image size={42} /><strong>Compose your image</strong><span>Add objects, text, and groups, then describe them in the inspector.</span></div>}
        <svg className={`image-overlay ${drawKind ? "drawing" : ""}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Image placement canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { pointer.current = null; setDraftBox(null); }}>
          {boxes && scene.nodes.filter((node) => node.box).map((node) => {
            const box = pointer.current?.id === node.id && draftBox ? draftBox : node.box!;
            return <g key={node.id} className={selected.id === node.id ? "selected" : ""}><rect data-node={node.id} x={box.x} y={box.y} width={box.width} height={box.height} vectorEffect="non-scaling-stroke" />{selected.id === node.id && <rect className="image-box-handle" data-node={node.id} data-resize="true" x={box.x + box.width - 16} y={box.y + box.height - 16} width="16" height="16" />}</g>;
          })}
          {draftBox && !pointer.current?.id && <rect className="image-box-draft" {...{ x: draftBox.x, y: draftBox.y, width: draftBox.width, height: draftBox.height }} />}
        </svg>
        {boxes && scene.nodes.filter((node) => node.box).map((node) => { const box = pointer.current?.id === node.id && draftBox ? draftBox : node.box!; return <span key={node.id} className="image-box-label" style={{ left: `${box.x / 10}%`, top: `${box.y / 10}%` }}>{node.name}</span>; })}
      </div></div>
      <div className="image-status" role="status">{active && <progress value={work.progress} max="1" />}<span>{active ? work.detail : !isTauri() ? "Image generation is available in the desktop app." : `${width} × ${height} · Placement boxes guide the prompt.`}</span></div>
      {(error || work?.error) && <p className="image-error" role="alert">{error ?? work?.error}</p>}
      {images.length > 0 && <div className="image-results" aria-label="Generated images">{images.map((asset) => <button key={asset.id} title={asset.name} aria-label={`View ${asset.name}`} aria-pressed={asset.id === scene.outputAssetId} onClick={() => onChange((current) => ({ ...current, thumbnail: asset.relativePath ?? null, imageScene: { ...(current.imageScene ?? scene), outputAssetId: asset.id } }))}><ReferenceImage folderPath={folderPath} relativePath={asset.relativePath} sourcePath={asset.sourcePath} alt={asset.name} /></button>)}</div>}
    </section>
    <aside className="image-inspector" aria-label="Image node inspector"><header><strong>Inspector</strong><span>{selected.kind}</span></header><div className="image-inspector__fields">
      <label>Name<input value={selected.name} maxLength={120} onChange={(event) => { if (event.target.value.trim()) patchNode({ name: event.target.value }); }} /></label>
      <label>{selected.kind === "root" ? "Prompt (high-level description)" : "Description"}<textarea rows={4} value={selected.description} onChange={(event) => patchNode({ description: event.target.value })} /></label>
      {selected.kind === "text" && <label>Text to render<input value={selected.text} onChange={(event) => patchNode({ text: event.target.value })} /></label>}
      {selected.kind !== "root" && <label>Parent<select value={selected.parentId ?? root.id} onChange={(event) => patchNode({ parentId: event.target.value })}>{scene.nodes.filter((node) => !descendants.has(node.id)).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select></label>}
      {selected.kind === "root" && <>
        <label>Background (environment)<textarea rows={3} value={scene.background} onChange={(event) => commit({ ...scene, background: event.target.value })} /></label>
        <h3>Image generation</h3><label>Steps<input type="number" min="2" max="1000" value={scene.steps} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 2 && value <= 1000) commit({ ...scene, steps: value }); }} /></label>
        <label>Seed (−1 = random)<input type="number" min="-1" max={Number.MAX_SAFE_INTEGER} value={scene.seed} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= -1) commit({ ...scene, seed: value }); }} /></label>
        <label>Aspect ratio<select value={config.settings.aspectRatio} onChange={(event) => { const aspectRatio = event.target.value as ProjectConfig["settings"]["aspectRatio"]; onChange((current) => ({ ...current, settings: { ...current.settings, aspectRatio }, brief: { ...current.brief, aspectRatio } })); }}>{["16:9", "9:16", "1:1", "4:5"].map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
        <label>Resolution<select value={config.settings.resolution} onChange={(event) => { const resolution = event.target.value as ProjectConfig["settings"]["resolution"]; onChange((current) => ({ ...current, settings: { ...current.settings, resolution }, brief: { ...current.brief, resolution } })); }}>{[...new Set([...PROJECT_RESOLUTIONS, config.settings.resolution])].map((resolution) => { const size = outputDimensions(resolution, config.settings.aspectRatio); return <option key={resolution} value={resolution}>{size.width} × {size.height}</option>; })}</select></label>
        <h3>Style</h3><label>Mode<select value={scene.style.mode} onChange={(event) => commit({ ...scene, style: { ...scene.style, mode: event.target.value as "photo" | "art" } })}><option value="photo">Photo</option><option value="art">Art</option></select></label>
        {(["aesthetics", "lighting", ...(scene.style.mode === "art" ? ["medium" as const] : []), "detail"] as const).map((field) => <label key={field}>{field === "detail" ? scene.style.mode === "photo" ? "Camera / lens" : "Art style" : field[0].toUpperCase() + field.slice(1)}<input value={scene.style[field]} onChange={(event) => commit({ ...scene, style: { ...scene.style, [field]: event.target.value } })} /></label>)}
        <h3>References</h3>{config.references.filter((reference) => reference.kind === "image" || reference.kind === "text").map((reference) => <label className="image-check" key={reference.id}><input type="checkbox" checked={scene.referenceIds.includes(reference.id)} onChange={(event) => commit({ ...scene, referenceIds: event.target.checked ? [...scene.referenceIds, reference.id] : scene.referenceIds.filter((id) => id !== reference.id) })} />{reference.name}</label>)}{!config.references.length && <p>Add image or text references in the References tab.</p>}
      </>}
      {selected.kind !== "root" && <><h3>Placement (0–1000)</h3><label className="image-check"><input type="checkbox" checked={Boolean(selected.box)} onChange={(event) => patchNode({ box: event.target.checked ? { x: 250, y: 250, width: 500, height: 500 } : null })} />Explicit placement</label>{selected.box && <div className="image-box-fields">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}>{field}<input type="number" min={field === "x" || field === "y" ? 0 : 1} max="1000" value={selected.box![field]} onChange={(event) => { const value = Number(event.target.value); const box = { ...selected.box!, [field]: value }; if (Number.isFinite(value) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1000 && box.y + box.height <= 1000) commit(resizeImageNode(scene, selected.id, box)); }} /></label>)}</div>}</>}
      <h3>Color palette</h3><div className="image-palette">{selected.colors.map((color, index) => <div key={index}><input aria-label={`Palette color ${index + 1}`} type="color" value={color} onChange={(event) => patchNode({ colors: selected.colors.map((old, i) => i === index ? event.target.value : old) })} /><button className="icon-button" aria-label={`Remove color ${index + 1}`} onClick={() => patchNode({ colors: selected.colors.filter((_, i) => i !== index) })}><Trash2 size={13} /></button></div>)}<button className="secondary-button" disabled={selected.colors.length >= (selected.kind === "root" ? 16 : 5)} onClick={() => patchNode({ colors: [...selected.colors, "#808080"] })}><Plus size={14} />Color</button></div>
    </div></aside>
  </div>;
}
