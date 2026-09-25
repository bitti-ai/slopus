import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type PointerEvent } from "react";
import { Box, ChevronDown, ChevronRight, ClipboardPaste, Copy, FolderPlus, Image, Pencil, Plus, Redo2, Sparkles, Square, Trash2, Type, Undo2 } from "lucide-react";
import { addImageNode, createImageScene, duplicateImageNode, imageDescendants, imageScenePrompt, removeImageNode, resizeImageNode, type ImageBox, type ImageNode, type ImageScene } from "../../lib/imageScene";
import { outputDimensions } from "../../lib/export";
import { compileImagePrompt } from "../../lib/imagePrompt";
import { isTauri } from "../../lib/persistence";
import { PROJECT_RESOLUTIONS, type ProjectConfig } from "../../lib/project";
import { defaultGeneratorTemplate, loadDebugOptionsEnabled, loadGeneratorTemplateSettings, subscribeDebugOptions, subscribeGeneratorTemplates, templateNeedsDownload, type GeneratorTemplate } from "../../lib/settings";
import { isWorkActive, type WorkItem } from "../../lib/workQueue";
import type { ConfigUpdate } from "./TimelineView";
import { ReferenceImage } from "./ReferenceImage";
import { DebugPromptDialog } from "./DebugPromptDialog";
import { TagEditor } from "./TagEditor";
import styleSuggestions from "../../lib/imageStyleSuggestions.json";
import { applyImageCommand } from "../../lib/imageCommands";
import { copyImageNode, getImageNodeClipboard, pasteImageNode, subscribeImageNodeClipboard } from "../../lib/imageNodeClipboard";
import { HierarchyContextMenu } from "./HierarchyContextMenu";
import "../../styles/image-editor.css";

const MIN_IMAGE_ZOOM = 0.1;
const MAX_IMAGE_ZOOM = 8;

export function ImageEditor({ config, folderPath, onChange, onGenerate, onCancel, work }: {
  config: ProjectConfig; folderPath: string; onChange: (update: ConfigUpdate) => void;
  onGenerate: (template: GeneratorTemplate) => void; onCancel: (id: string) => Promise<void>; work?: WorkItem;
}) {
  const scene = useMemo(() => config.imageScene ?? createImageScene(config.brief.prompt), [config.imageScene, config.brief.prompt]);
  const root = scene.nodes.find((node) => node.kind === "root")!;
  const [selection, setSelection] = useState(root.id);
  const selected = scene.nodes.find((node) => node.id === selection) ?? root;
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [treeDrop, setTreeDrop] = useState<{ id: string; placement: "before" | "inside" | "after" } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [imageMenu, setImageMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const imageResults = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const renameEnding = useRef(false);
  const hierarchy = useRef<HTMLElement>(null);
  const clipboard = useSyncExternalStore(subscribeImageNodeClipboard, getImageNodeClipboard);
  const [templates, setTemplates] = useState(loadGeneratorTemplateSettings);
  const [templateId, setTemplateId] = useState(() => localStorage.getItem("slopus.image-generator-template.v1") ?? defaultGeneratorTemplate().id);
  const imageTemplates = templates.templates.filter((template) => template.mode !== "animate");
  const template = imageTemplates.find((candidate) => candidate.id === templateId) ?? imageTemplates.find((candidate) => !templateNeedsDownload(candidate)) ?? imageTemplates[0];
  const [error, setError] = useState<string | null>(null);
  const debugEnabled = useSyncExternalStore(subscribeDebugOptions, loadDebugOptionsEnabled);
  const [debugPrompt, setDebugPrompt] = useState<string | null>(null);
  useEffect(() => { if (!debugEnabled) setDebugPrompt(null); }, [debugEnabled]);
  const [boxes, setBoxes] = useState(true);
  const [drawKind, setDrawKind] = useState<"object" | "text" | "group" | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [draftBox, setDraftBox] = useState<ImageBox | null>(null);
  const undo = useRef<ImageScene[]>([]);
  const redo = useRef<ImageScene[]>([]);
  const [, historyChanged] = useState(0);
  const pointer = useRef<{ x: number; y: number; scene: ImageScene; id?: string; resize: boolean } | null>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (pointer.current) return;
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      const x = event.clientX - bounds.left - bounds.width / 2;
      const y = event.clientY - bounds.top - bounds.height / 2;
      setView((current) => {
        const zoom = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, current.zoom * Math.exp(-delta * 0.002)));
        const ratio = zoom / current.zoom;
        return { zoom, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio };
      });
    };
    // React's delegated wheel listener is passive; canvas zoom must consume it.
    element.addEventListener("wheel", wheel, { passive: false });
    const stopPan = () => {
      const start = pan.current;
      pan.current = null; setPanning(false);
      if (start && element.hasPointerCapture(start.pointerId)) element.releasePointerCapture(start.pointerId);
    };
    window.addEventListener("blur", stopPan);
    return () => { element.removeEventListener("wheel", wheel); window.removeEventListener("blur", stopPan); };
  }, []);
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    pan.current = null; setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
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
  const insertParent = selected.kind === "object" || selected.kind === "text" ? selected.parentId ?? root.id : selected.id;
  const add = (kind: Exclude<ImageNode["kind"], "root">, box?: ImageBox) => {
    const next = addImageNode(scene, insertParent, kind, box); commit(next); setSelection(next.nodes.at(-1)!.id);
    setCollapsed((current) => { const next = new Set(current); next.delete(insertParent); return next; });
  };
  const attempt = (action: () => void | Promise<unknown>) => {
    setError(null);
    try { void Promise.resolve(action()).catch((reason) => setError(String(reason))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const focusNode = (id: string) => [...(hierarchy.current?.querySelectorAll<HTMLElement>("[data-image-node]") ?? [])].find((row) => row.dataset.imageNode === id)?.querySelector<HTMLButtonElement>(".image-tree__select")?.focus();
  const closeContextMenu = () => { setContextMenu(null); focusNode(selected.id); };
  const closeImageMenu = () => {
    const button = [...(imageResults.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((element) => element.dataset.imageAsset === imageMenu?.id);
    setImageMenu(null); button?.focus();
  };
  const removeImage = (id: string) => {
    onChange((current) => {
      const removed = current.assets.find((asset) => asset.id === id && asset.kind === "image");
      if (!removed) return current;
      const currentImages = current.assets.filter((asset) => asset.kind === "image");
      const remaining = currentImages.filter((asset) => asset.id !== id);
      const currentScene = current.imageScene ?? scene;
      const removingSelected = currentScene.outputAssetId === id;
      const next = removingSelected
        ? remaining[Math.min(currentImages.findIndex((asset) => asset.id === id), remaining.length - 1)]
        : remaining.find((asset) => asset.id === currentScene.outputAssetId);
      return { ...current,
        assets: current.assets.filter((asset) => asset.id !== id),
        imageScene: { ...currentScene, outputAssetId: removingSelected ? next?.id ?? null : currentScene.outputAssetId },
        thumbnail: removingSelected || current.thumbnail === removed.relativePath ? next?.relativePath ?? null : current.thumbnail,
        timeline: { ...current.timeline, tracks: current.timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.assetId !== id) })) },
      };
    });
    requestAnimationFrame(() => (imageResults.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ?? imageResults.current?.querySelector<HTMLButtonElement>("button") ?? viewport.current)?.focus());
  };
  const startRename = () => { renameEnding.current = false; setRenaming({ id: selected.id, value: selected.name }); };
  const finishRename = (save: boolean, restoreFocus = true) => {
    if (!renaming || renameEnding.current) return;
    renameEnding.current = true;
    if (save && renaming.value.trim()) commit({ ...scene, nodes: scene.nodes.map((node) => node.id === renaming.id ? { ...node, name: renaming.value.trim() } : node) });
    const id = renaming.id;
    setRenaming(null);
    if (restoreFocus) requestAnimationFrame(() => focusNode(id));
  };
  const removeSelected = () => {
    if (selected.kind === "root") return;
    const parent = selected.parentId ?? root.id;
    commit(removeImageNode(scene, selected.id)); setSelection(parent);
    requestAnimationFrame(() => focusNode(parent));
  };
  const paste = () => {
    const result = pasteImageNode(scene, insertParent);
    if (!result) return;
    commit(result.scene); setSelection(result.id);
    setCollapsed((current) => { const next = new Set(current); next.delete(insertParent); return next; });
    requestAnimationFrame(() => focusNode(result.id));
  };
  const duplicate = () => {
    if (selected.kind === "root") return;
    const next = duplicateImageNode(scene, selected.id);
    const oldIds = new Set(scene.nodes.map((node) => node.id));
    const copy = next.nodes.find((node) => !oldIds.has(node.id) && node.parentId === selected.parentId)!;
    commit(next); setSelection(copy.id);
    requestAnimationFrame(() => focusNode(copy.id));
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
  const dropDestination = (event: DragEvent<HTMLDivElement>, target: ImageNode) => {
    const source = scene.nodes.find((node) => node.id === draggedNode);
    if (!source || source.kind === "root" || imageDescendants(scene, source.id).has(target.id)) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = bounds.height ? (event.clientY - bounds.top) / bounds.height : 0.5;
    const placement = target.kind === "root" ? "inside" : fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "inside";
    const parent = placement === "inside" ? target.id : target.parentId!;
    const siblings = scene.nodes.filter((node) => node.parentId === parent && node.id !== source.id);
    const before = placement === "before" ? target.id : placement === "after" ? siblings[siblings.findIndex((node) => node.id === target.id) + 1]?.id : undefined;
    return { id: target.id, placement, parent, before } as const;
  };
  const tree = (node: ImageNode, depth: number) => {
    const children = scene.nodes.filter((child) => child.parentId === node.id);
    const open = !collapsed.has(node.id);
    return <div key={node.id} role="treeitem" aria-selected={selected.id === node.id} aria-expanded={children.length ? open : undefined}>
      <div className={`image-tree__row ${selected.id === node.id ? "selected" : ""}${draggedNode === node.id ? " dragging" : ""}${treeDrop?.id === node.id ? ` image-tree__drop--${treeDrop.placement}` : ""}`} style={{ paddingLeft: `calc(var(--space-2) + ${depth} * var(--space-4))` }}
        data-image-node={node.id}
        onContextMenu={(event) => { if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return; event.preventDefault(); event.stopPropagation(); setSelection(node.id); setContextMenu({ x: event.clientX, y: event.clientY }); }}
        draggable={node.kind !== "root" && renaming?.id !== node.id}
        onDragStart={(event) => {
          if (node.kind === "root") { event.preventDefault(); return; }
          event.stopPropagation();
          event.dataTransfer.setData("application/x-slopus-image-node", node.id);
          event.dataTransfer.effectAllowed = "move";
          setDraggedNode(node.id); setSelection(node.id);
        }}
        onDragEnd={() => { setDraggedNode(null); setTreeDrop(null); }}
        onDragOver={(event) => {
          event.stopPropagation();
          const destination = dropDestination(event, node);
          if (destination) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setTreeDrop(destination); }
          else { event.dataTransfer.dropEffect = "none"; setTreeDrop(null); }
        }}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setTreeDrop(null); }}
        onDrop={(event) => {
          event.preventDefault(); event.stopPropagation();
          const destination = dropDestination(event, node);
          if (destination && draggedNode) attempt(() => {
            commit(applyImageCommand(scene, { op: "image.node.move", id: draggedNode, parent: destination.parent, before: destination.before }));
            setCollapsed((current) => { const next = new Set(current); next.delete(destination.parent); return next; });
          });
          setDraggedNode(null); setTreeDrop(null);
        }}>
        {children.length ? <button className="icon-button" aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (open) next.add(node.id); else next.delete(node.id); return next; })}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="image-tree__spacer" />}
        {renaming?.id === node.id ? <input className="image-tree__rename" aria-label="Rename image node" maxLength={120} ref={(element) => { if (element && document.activeElement !== element) { element.focus(); element.select(); } }} value={renaming.value} onChange={(event) => setRenaming({ ...renaming, value: event.target.value })} onBlur={() => finishRename(true, false)} onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(true); }
          if (event.key === "Escape") { event.preventDefault(); finishRename(false); }
        }} /> : <button className="image-tree__select" onFocus={() => setSelection(node.id)} onClick={() => setSelection(node.id)}><span aria-hidden="true">{node.kind === "text" ? "T" : node.kind === "root" ? <Image size={16} /> : <Box size={16} />}</span><span>{node.name}</span></button>}
      </div>
      {open && children.length > 0 && <div role="group">{children.map((child) => tree(child, depth + 1))}</div>}
    </div>;
  };
  return <div className="image-editor">
    <aside ref={hierarchy} className="image-tree" aria-label="Image hierarchy" onContextMenu={(event) => { if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return; event.preventDefault(); setSelection(root.id); setContextMenu({ x: event.clientX, y: event.clientY }); }} onKeyDown={(event) => {
      if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]") || contextMenu) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === "c" || key === "v")) {
        event.preventDefault(); event.stopPropagation();
        attempt(() => key === "c" ? copyImageNode(scene, selected.id) : paste());
      } else if (key === "delete") { event.preventDefault(); event.stopPropagation(); removeSelected(); }
      else if (key === "f2") { event.preventDefault(); event.stopPropagation(); startRename(); }
      else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); event.stopPropagation();
        const bounds = (event.target as HTMLElement).getBoundingClientRect();
        setContextMenu({ x: bounds.left, y: bounds.bottom });
      }
    }}>
      <header><strong>Scene</strong><div className="image-editor__actions"><button className="icon-button" title="Undo" aria-label="Undo image edit" disabled={!undo.current.length} onClick={() => history(true)}><Undo2 size={16} /></button><button className="icon-button" title="Redo" aria-label="Redo image edit" disabled={!redo.current.length} onClick={() => history(false)}><Redo2 size={16} /></button></div></header>
      <div role="tree" aria-label="Image nodes">{tree(root, 0)}</div>
      <p className="image-tree__hint">Right-click to add or edit nodes. Drag onto a node to nest, or between nodes to reorder.</p>
    </aside>
    {contextMenu && <HierarchyContextMenu {...contextMenu} onClose={closeContextMenu} items={[
      { label: "New Object", icon: <Box size={15} />, action: () => attempt(() => add("object")) },
      { label: "New Text", icon: <Type size={15} />, action: () => attempt(() => add("text")) },
      { label: "New Group", icon: <FolderPlus size={15} />, action: () => attempt(() => add("group")) },
      { label: "New Background", icon: <Image size={15} />, action: () => attempt(() => add("background")) },
      { label: "Rename", icon: <Pencil size={15} />, shortcut: "F2", separator: true, action: startRename },
      { label: "Copy", icon: <Copy size={15} />, shortcut: "Ctrl+C", separator: true, disabled: selected.kind === "root", action: () => copyImageNode(scene, selected.id) },
      { label: "Paste", icon: <ClipboardPaste size={15} />, shortcut: "Ctrl+V", disabled: !clipboard, action: () => attempt(paste) },
      { label: "Duplicate", icon: <Copy size={15} />, disabled: selected.kind === "root", action: () => attempt(duplicate) },
      { label: "Delete", icon: <Trash2 size={15} />, shortcut: "Delete", separator: true, danger: true, disabled: selected.kind === "root", action: removeSelected },
    ]} />}
    {imageMenu && <HierarchyContextMenu {...imageMenu} label="Generated image actions" onClose={closeImageMenu} items={[
      { label: "Remove", icon: <Trash2 size={15} />, danger: true, action: () => removeImage(imageMenu.id) },
    ]} />}
    <section className="image-center" aria-label="Image panel">
      <div className="image-canvas-tools">
        <button className="primary-button" disabled={active ? work.cancelling || work.status === "encoding" : !isTauri() || !template || templateNeedsDownload(template) || !imageScenePrompt(scene)} onClick={() => attempt(() => active ? onCancel(work.id) : onGenerate(template!))}><Sparkles size={16} />{active ? work.cancelling ? "Cancelling…" : "Cancel" : "Generate"}</button>
        <label className="image-generator">Generator<select aria-label="Generator" value={template?.id ?? ""} disabled={Boolean(active)} onChange={(event) => { setTemplateId(event.target.value); localStorage.setItem("slopus.image-generator-template.v1", event.target.value); const next = imageTemplates.find((candidate) => candidate.id === event.target.value); if (next) commit({ ...scene, steps: next.defaultSteps }); }}>
          {!imageTemplates.length && <option value="">No MiniMax H3 templates</option>}{imageTemplates.map((item) => <option key={item.id} value={item.id} disabled={templateNeedsDownload(item)}>{item.name}{templateNeedsDownload(item) ? " (download in Settings)" : ""}</option>)}
        </select></label>
        <button className={`icon-button ${boxes ? "active" : ""}`} aria-label="Show placement boxes" aria-pressed={boxes} onClick={() => { setBoxes(!boxes); setDrawKind(null); }}><Square size={16} /></button>
        <select aria-label="Canvas tool" value={drawKind ?? "select"} onChange={(event) => { setDrawKind(event.target.value === "select" ? null : event.target.value as typeof drawKind); setBoxes(true); }}><option value="select">Select / move</option><option value="object">Draw object</option><option value="text">Draw text</option><option value="group">Draw group</option></select>
        <button className="secondary-button" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>Fit</button><input aria-label="Image zoom" type="range" min={MIN_IMAGE_ZOOM} max={MAX_IMAGE_ZOOM} step="0.01" value={view.zoom} onChange={(event) => { const zoom = Number(event.target.value); setView((current) => ({ zoom, x: current.x * zoom / current.zoom, y: current.y * zoom / current.zoom })); }} /><span>{Math.round(view.zoom * 100)}%</span>
      </div>
      <div ref={viewport} tabIndex={-1} className={`image-viewport${panning ? " panning" : ""}`} title="Scroll to zoom · Drag with the middle mouse button to pan"
        onPointerDownCapture={(event) => {
          if (event.button !== 1 || pointer.current || pan.current) return;
          event.preventDefault(); event.stopPropagation();
          pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          setPanning(true); event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMoveCapture={(event) => {
          const start = pan.current;
          if (!start || start.pointerId !== event.pointerId) return;
          if (!(event.buttons & 4)) { endPan(event); return; }
          event.preventDefault(); event.stopPropagation();
          const dx = event.clientX - start.x; const dy = event.clientY - start.y;
          pan.current = { ...start, x: event.clientX, y: event.clientY };
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUpCapture={endPan} onPointerCancelCapture={endPan} onLostPointerCapture={endPan}
        onAuxClick={(event) => { if (event.button === 1) event.preventDefault(); }}>
        <div className="image-frame" style={{ "--image-ratio": width / height, "--image-zoom": view.zoom, "--image-pan-x": `${view.x}px`, "--image-pan-y": `${view.y}px` } as CSSProperties}>
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
      {images.length > 0 && <div ref={imageResults} className="image-results" aria-label="Generated images">{images.map((asset) => <button key={asset.id} data-image-asset={asset.id} title={asset.name} aria-label={`View ${asset.name}`} aria-pressed={asset.id === scene.outputAssetId}
        onContextMenu={(event) => { event.preventDefault(); setContextMenu(null); setImageMenu({ id: asset.id, x: event.clientX, y: event.clientY }); }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            setContextMenu(null); setImageMenu({ id: asset.id, x: bounds.left, y: bounds.bottom });
          }
        }}
        onClick={() => onChange((current) => ({ ...current, thumbnail: asset.relativePath ?? null, imageScene: { ...(current.imageScene ?? scene), outputAssetId: asset.id } }))}><ReferenceImage folderPath={folderPath} relativePath={asset.relativePath} sourcePath={asset.sourcePath} alt={asset.name} /></button>)}</div>}
    </section>
    <aside className="image-inspector" aria-label="Image node inspector"><header><strong>Inspector</strong><span>{selected.kind}</span></header><div className="image-inspector__fields">
      <label>Name<input value={selected.name} maxLength={120} onChange={(event) => { if (event.target.value.trim()) patchNode({ name: event.target.value }); }} /></label>
      <label>{selected.kind === "root" ? "Prompt (high-level description)" : "Description"}<textarea rows={4} value={selected.description} onChange={(event) => patchNode({ description: event.target.value })} /></label>
      {selected.kind === "text" && <label>Text to render<input value={selected.text} onChange={(event) => patchNode({ text: event.target.value })} /></label>}
      {selected.kind === "root" && <>
        <label>Background (environment)<textarea rows={3} value={scene.background} onChange={(event) => commit({ ...scene, background: event.target.value })} /></label>
        <h3>Image generation</h3><label>Steps<input type="number" min="2" max="1000" value={scene.steps} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 2 && value <= 1000) commit({ ...scene, steps: value }); }} /></label>
        <label>Seed (−1 = random)<input type="number" min="-1" max={Number.MAX_SAFE_INTEGER} value={scene.seed} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= -1) commit({ ...scene, seed: value }); }} /></label>
        <label>Aspect ratio<select value={config.settings.aspectRatio} onChange={(event) => { const aspectRatio = event.target.value as ProjectConfig["settings"]["aspectRatio"]; onChange((current) => ({ ...current, settings: { ...current.settings, aspectRatio }, brief: { ...current.brief, aspectRatio } })); }}>{["16:9", "9:16", "1:1", "4:5"].map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
        <label>Resolution<select value={config.settings.resolution} onChange={(event) => { const resolution = event.target.value as ProjectConfig["settings"]["resolution"]; onChange((current) => ({ ...current, settings: { ...current.settings, resolution }, brief: { ...current.brief, resolution } })); }}>{[...new Set([...PROJECT_RESOLUTIONS, config.settings.resolution])].map((resolution) => { const size = outputDimensions(resolution, config.settings.aspectRatio); return <option key={resolution} value={resolution}>{size.width} × {size.height}</option>; })}</select></label>
        <h3>Style</h3><label>Mode<select value={scene.style.mode} onChange={(event) => commit({ ...scene, style: { ...scene.style, mode: event.target.value as "photo" | "art" } })}><option value="photo">Photo</option><option value="art">Art</option></select></label>
        <TagEditor label="Aesthetics" value={scene.style.aesthetics} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoAestheticsSuggestions : styleSuggestions.ArtAestheticsSuggestions} onChange={(aesthetics) => commit({ ...scene, style: { ...scene.style, aesthetics } })} />
        <TagEditor label="Lighting" value={scene.style.lighting} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoLightingSuggestions : styleSuggestions.ArtLightingSuggestions} onChange={(lighting) => commit({ ...scene, style: { ...scene.style, lighting } })} />
        {scene.style.mode === "art" && <TagEditor label="Medium" value={scene.style.medium} suggestions={styleSuggestions.MediumSuggestions} onChange={(medium) => commit({ ...scene, style: { ...scene.style, medium } })} />}
        <TagEditor key={scene.style.mode} label={scene.style.mode === "photo" ? "Camera / lens" : "Art style"} value={scene.style.detail} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoSuggestions : styleSuggestions.ArtSuggestions} onChange={(detail) => commit({ ...scene, style: { ...scene.style, detail } })} />
        <h3>References</h3>{config.references.filter((reference) => reference.kind === "image" || reference.kind === "text").map((reference) => <label className="image-check" key={reference.id}><input type="checkbox" checked={scene.referenceIds.includes(reference.id)} onChange={(event) => commit({ ...scene, referenceIds: event.target.checked ? [...scene.referenceIds, reference.id] : scene.referenceIds.filter((id) => id !== reference.id) })} />{reference.name}</label>)}{!config.references.length && <p>Add image or text references in the References tab.</p>}
      </>}
      {selected.kind !== "root" && <><h3>Placement (0–1000)</h3><label className="image-check"><input type="checkbox" checked={Boolean(selected.box)} onChange={(event) => patchNode({ box: event.target.checked ? { x: 250, y: 250, width: 500, height: 500 } : null })} />Explicit placement</label>{selected.box && <div className="image-box-fields">{(["x", "y", "width", "height"] as const).map((field) => <label key={field}>{field}<input type="number" min={field === "x" || field === "y" ? 0 : 1} max="1000" value={selected.box![field]} onChange={(event) => { const value = Number(event.target.value); const box = { ...selected.box!, [field]: value }; if (Number.isFinite(value) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1000 && box.y + box.height <= 1000) commit(resizeImageNode(scene, selected.id, box)); }} /></label>)}</div>}</>}
      <h3>Color palette</h3><div className="image-palette">{selected.colors.map((color, index) => <div key={index}><input aria-label={`Palette color ${index + 1}`} type="color" value={color} onChange={(event) => patchNode({ colors: selected.colors.map((old, i) => i === index ? event.target.value : old) })} /><button className="icon-button" aria-label={`Remove color ${index + 1}`} onClick={() => patchNode({ colors: selected.colors.filter((_, i) => i !== index) })}><Trash2 size={13} /></button></div>)}<button className="secondary-button" disabled={selected.colors.length >= (selected.kind === "root" ? 16 : 5)} onClick={() => patchNode({ colors: [...selected.colors, "#808080"] })}><Plus size={14} />Color</button></div>
    </div>
      {debugEnabled && <div className="debug-prompt"><button type="button" className="secondary-button debug-prompt__toggle" aria-haspopup="dialog" onClick={() => attempt(() => setDebugPrompt(compileImagePrompt(config).prompt))}>Debug Prompt</button></div>}
    </aside>
    {debugEnabled && debugPrompt !== null && <DebugPromptDialog sceneTitle={config.name} segments={[{ kind: "brief", value: debugPrompt }]} onClose={() => setDebugPrompt(null)} />}
  </div>;
}
