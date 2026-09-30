import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { Add14, Add16, Boxes16, Boxes16Filled, ChevronDown14, ChevronRight14, Copy16, Cube16, Cube16Filled, Cursor16, Cursor16Filled, Delete14, Delete16, Edit16, FolderAdd16, FolderOpen16, Group16, Group16Filled, Image16, Image32, Paste16, Rename16, Sparkle16, Stop14, Text16, Text16Filled } from "../ui/icons";
import { invoke } from "@tauri-apps/api/core";
import { addImageNode, createImageEditScene, createImageScene, duplicateImageNode, imageDescendants, imageScenePrompt, removeImageNode, resizeImageNode, type ImageBox, type ImageNode, type ImageScene, type ImageSource } from "../../lib/imageScene";
import { compileImageEdits, editGeneratedImage, imageEditDebugPrompt } from "../../lib/imageEditing";
import { outputDimensions } from "../../lib/export";
import { compileImagePrompt } from "../../lib/imagePrompt";
import { createEmptyImage, restoreGeneratedImage, saveImageDraft } from "../../lib/imageHistory";
import { isTauri } from "../../lib/persistence";
import { IMAGE_RESOLUTIONS, type ProjectConfig } from "../../lib/project";
import { defaultGeneratorTemplate, loadDebugOptionsEnabled, loadGeneratorTemplateSettings, subscribeDebugOptions, subscribeGeneratorTemplates, templateNeedsDownload, type GeneratorTemplate } from "../../lib/settings";
import { isWorkActive, type WorkItem } from "../../lib/workQueue";
import type { ConfigUpdate } from "./TimelineView";
import { ReferenceImage } from "./ReferenceImage";
import { ImageBar } from "./ImageBar";
import { DebugPromptDialog } from "./DebugPromptDialog";
import { TagEditor } from "./TagEditor";
import styleSuggestions from "../../lib/imageStyleSuggestions.json";
import { applyImageCommand } from "../../lib/imageCommands";
import { copyImageNode, getImageNodeClipboard, pasteImageNode, subscribeImageNodeClipboard } from "../../lib/imageNodeClipboard";
import { HierarchyContextMenu } from "./HierarchyContextMenu";
import { useShortcut } from "../../lib/commands";
import { ComboBox, InfoBar, ItemHeader, PaneHeader, ProgressBar, PropRow, PropSection, Splitter, tooltipProps, usePaneSize } from "../ui";
import "../../styles/image-editor.css";

const MIN_IMAGE_ZOOM = 0.1;
const MAX_IMAGE_ZOOM = 8;

export function ImageEditor({ config, folderPath, onChange: changeConfig, onGenerate, onCancel, workItems = [] }: {
  config: ProjectConfig; folderPath: string; onChange: (update: ConfigUpdate) => void;
  onGenerate: (template: GeneratorTemplate) => void; onCancel: (id: string) => Promise<void>; workItems?: readonly WorkItem[];
}) {
  const scene = useMemo(() => config.imageScene ?? createImageScene(config.brief.prompt), [config.imageScene, config.brief.prompt]);
  const root = scene.nodes.find((node) => node.kind === "root")!;
  const imageRoot = scene.rootType === "image";
  const editPlan = useMemo(() => {
    if (!imageRoot) return null;
    try { return { ...compileImageEdits(config), error: null }; }
    catch (reason) { return { edits: [], error: String(reason instanceof Error ? reason.message : reason) }; }
  }, [config, imageRoot]);
  const [selection, setSelection] = useState(root.id);
  const selected = scene.nodes.find((node) => node.id === selection) ?? root;
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [treeDrop, setTreeDrop] = useState<{ id: string; placement: "before" | "inside" | "after" } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [imageMenu, setImageMenu] = useState<{ id: string | null; x: number; y: number } | null>(null);
  const imageResults = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const renameEnding = useRef(false);
  const hierarchy = useRef<HTMLElement>(null);
  const editorRoot = useRef<HTMLDivElement>(null);
  const editorId = useId();
  const treePane = usePaneSize("image.tree", 240, { min: 180, max: 420 });
  const inspectorPane = usePaneSize("image.inspector", 300, { min: 240, max: 520 });
  const clipboard = useSyncExternalStore(subscribeImageNodeClipboard, getImageNodeClipboard);
  const [templates, setTemplates] = useState(loadGeneratorTemplateSettings);
  const [templateId, setTemplateId] = useState(() => localStorage.getItem("slopus.image-generator-template.v1") ?? defaultGeneratorTemplate().id);
  const imageTemplates = templates.templates.filter((template) => template.mode !== "animate");
  const template = imageTemplates.find((candidate) => candidate.id === templateId) ?? imageTemplates.find((candidate) => !templateNeedsDownload(candidate)) ?? imageTemplates[0];
  const onChange = (update: ConfigUpdate) => changeConfig((current) => {
    const next = typeof update === "function" ? update(current) : update;
    const selecting = next.imageScene?.outputAssetId && next.imageScene.outputAssetId !== current.imageScene?.outputAssetId;
    return saveImageDraft(next, selecting ? undefined : template?.id);
  });
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
    // Applied edits belong to the old source and must not be resurrected by Undo.
    undo.current = []; redo.current = []; historyChanged((value) => value + 1);
    pointer.current = null; setDraftBox(null); setDrawKind(null); setRenaming(null);
    setSelection(root.id); setCollapsed(new Set());
  }, [scene.sourceImage?.relativePath, root.id]);
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
  const work = workItems.filter((item) => item.imageAssetId === scene.outputAssetId).at(-1);
  const active = work && isWorkActive(work);
  const output = config.assets.find((asset) => asset.id === scene.outputAssetId);
  const images = config.assets.filter((asset) => asset.kind === "image");
  // Generated assets retain the dimensions returned by the native encoder.
  // Project settings size only the empty canvas and future generation requests.
  const { width, height } = imageRoot && scene.sourceImage ? scene.sourceImage : output?.width && output?.height
    ? { width: output.width, height: output.height }
    : outputDimensions(config.settings.resolution, config.settings.aspectRatio);
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
    setImageMenu(null); (button ?? imageResults.current)?.focus();
  };
  const resetImageEditing = (id: string) => {
    const snapshot = config.assets.find((asset) => asset.id === id)?.imageGeneration;
    if (!snapshot) return;
    undo.current = []; redo.current = []; historyChanged((value) => value + 1);
    pointer.current = null; setDraftBox(null); setDrawKind(null); setRenaming(null);
    setCollapsed(new Set()); setSelection(snapshot.scene.nodes.find((node) => node.kind === "root")!.id);
    if (imageTemplates.some((candidate) => candidate.id === snapshot.generatorTemplateId)) {
      setTemplateId(snapshot.generatorTemplateId);
      localStorage.setItem("slopus.image-generator-template.v1", snapshot.generatorTemplateId);
    }
  };
  const selectImage = (id: string) => {
    resetImageEditing(id);
    onChange((current) => restoreGeneratedImage(current, id));
  };
  const replaceScene = (next: ImageScene) => {
    undo.current = []; redo.current = []; historyChanged((value) => value + 1);
    pointer.current = null; setDraftBox(null); setDrawKind(null); setCollapsed(new Set());
    setSelection(next.nodes.find((node) => node.kind === "root")!.id);
    onChange((current) => ({ ...current, imageScene: next }));
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
      const updated = { ...current,
        assets: current.assets.filter((asset) => asset.id !== id),
        imageScene: removingSelected && removed.imageDraft && !next ? currentScene.rootType === "image" ? createImageEditScene(null, currentScene) : createImageScene() : { ...currentScene, outputAssetId: removingSelected ? next?.id ?? null : currentScene.outputAssetId },
        thumbnail: removingSelected || current.thumbnail === removed.relativePath ? next?.relativePath ?? null : current.thumbnail,
        timeline: { ...current.timeline, tracks: current.timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.assetId !== id) })) },
      };
      return removingSelected && next ? restoreGeneratedImage(updated, next.id) : updated;
    });
    requestAnimationFrame(() => {
      const selectedButton = imageResults.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (scene.outputAssetId === id && selectedButton?.dataset.imageAsset) resetImageEditing(selectedButton.dataset.imageAsset);
      (selectedButton ?? imageResults.current?.querySelector<HTMLButtonElement>("button") ?? viewport.current)?.focus();
    });
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
    pointer.current = null; setDraftBox(null);
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
    viewport.current?.focus({ preventScroll: true });
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
  /* --- Keyboard ---------------------------------------------------------------
     The tree is one Tab stop (roving tabindex): Up/Down walk the visible rows,
     Right opens a node or steps into it, Left closes it or steps out,
     Home/End jump. F2, Delete, Ctrl+C/V/D and Shift+F10 act on the selection.
     Undo and redo are this editor's own history, bound to its root so they
     never reach the project's undo while focus is in here. */
  const visibleNodes = (): ImageNode[] => {
    const out: ImageNode[] = [];
    const walk = (node: ImageNode) => {
      out.push(node);
      if (collapsed.has(node.id)) return;
      scene.nodes.filter((child) => child.parentId === node.id).forEach(walk);
    };
    walk(root);
    return out;
  };
  const selectAndFocus = (id: string) => { setSelection(id); requestAnimationFrame(() => focusNode(id)); };
  const treeKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]") || contextMenu) return;
    const key = event.key.toLowerCase();
    const handled = () => { event.preventDefault(); event.stopPropagation(); };
    if ((event.ctrlKey || event.metaKey) && (key === "c" || key === "v")) {
      handled();
      attempt(() => key === "c" ? copyImageNode(scene, selected.id) : paste());
    } else if ((event.ctrlKey || event.metaKey) && key === "d") { handled(); attempt(duplicate); }
    else if (key === "delete") { handled(); removeSelected(); }
    else if (key === "f2") { handled(); startRename(); }
    else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      handled();
      const bounds = (event.target as HTMLElement).getBoundingClientRect();
      setContextMenu({ x: bounds.left, y: bounds.bottom });
    } else if (["ArrowUp", "ArrowDown", "Home", "End", "ArrowLeft", "ArrowRight"].includes(event.key) && !event.altKey && !event.ctrlKey) {
      const rows = visibleNodes();
      const at = rows.findIndex((node) => node.id === selected.id);
      const children = scene.nodes.filter((child) => child.parentId === selected.id);
      const open = children.length > 0 && !collapsed.has(selected.id);
      let next: ImageNode | undefined;
      if (event.key === "ArrowUp") next = rows[at - 1];
      else if (event.key === "ArrowDown") next = rows[at + 1];
      else if (event.key === "Home") next = rows[0];
      else if (event.key === "End") next = rows.at(-1);
      else if (event.key === "ArrowRight") {
        if (children.length && !open) { handled(); setCollapsed((current) => { const set = new Set(current); set.delete(selected.id); return set; }); return; }
        next = open ? children[0] : undefined;
      } else if (event.key === "ArrowLeft") {
        if (open) { handled(); setCollapsed((current) => new Set(current).add(selected.id)); return; }
        next = scene.nodes.find((node) => node.id === selected.parentId);
      }
      handled();
      if (next) selectAndFocus(next.id);
    }
  };
  useShortcut(["Ctrl+Z"], () => { if (!undo.current.length) return false; history(true); }, { scope: editorRoot });
  useShortcut(["Ctrl+Y", "Ctrl+Shift+Z"], () => { if (!redo.current.length) return false; history(false); }, { scope: editorRoot });
  useShortcut("Delete", removeSelected, { scope: viewport });

  /* Canvas tools: a radio group of icon toggles with one-letter keys. */
  const TOOLS = [
    { id: null, label: "Select", key: "V", icon: <Cursor16 />, onIcon: <Cursor16Filled /> },
    { id: "object", label: "Draw object", key: "O", icon: <Cube16 />, onIcon: <Cube16Filled /> },
    { id: "text", label: "Draw text", key: "T", icon: <Text16 />, onIcon: <Text16Filled /> },
    { id: "group", label: "Draw group", key: "G", icon: <Group16 />, onIcon: <Group16Filled /> },
  ] as const;
  const chooseTool = (id: typeof drawKind) => { setDrawKind(id); if (id) setBoxes(true); };
  useShortcut("V", () => chooseTool(null), { scope: editorRoot });
  useShortcut("O", () => chooseTool("object"), { scope: editorRoot });
  useShortcut("T", () => chooseTool("text"), { scope: editorRoot });
  useShortcut("G", () => chooseTool("group"), { scope: editorRoot });
  useShortcut("Escape", () => { if (!drawKind) return false; chooseTool(null); }, { scope: editorRoot });

  /* Zoom: Fit is the frame fitted to the viewport (100% of the fit); the
     percentages scale from there. */
  const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
  const zoomTo = (zoom: number) => setView((current) => {
    const next = Math.max(MIN_IMAGE_ZOOM, Math.min(MAX_IMAGE_ZOOM, zoom));
    return { zoom: next, x: current.x * next / current.zoom, y: current.y * next / current.zoom };
  });
  const fit = () => setView({ zoom: 1, x: 0, y: 0 });
  const zoomStep = (direction: 1 | -1) => {
    const next = direction > 0 ? ZOOM_STEPS.find((step) => step > view.zoom + 1e-6) : [...ZOOM_STEPS].reverse().find((step) => step < view.zoom - 1e-6);
    if (next) zoomTo(next);
  };
  useShortcut("Ctrl+0", fit, { scope: editorRoot });
  useShortcut("Ctrl+1", () => zoomTo(1), { scope: editorRoot });
  useShortcut(["Ctrl+=", "Ctrl++", "Ctrl+Shift+="], () => zoomStep(1), { scope: editorRoot });
  useShortcut("Ctrl+-", () => zoomStep(-1), { scope: editorRoot });
  const fitted = view.zoom === 1 && view.x === 0 && view.y === 0;
  const zoomPresets = [0.25, 0.5, 0.75, 1, 1.5, 2];
  const zoomValue = fitted ? "fit" : zoomPresets.find((step) => Math.abs(step - view.zoom) < 1e-6)?.toString() ?? "custom";
  const zoomOptions = [
    { value: "fit", label: "Fit" },
    ...zoomPresets.map((step) => ({ value: String(step), label: `${step * 100}%` })),
  ];
  /* The field is editable: any percentage between the zoom limits can be
     typed ("137", "137%", "fit"). Anything else is refused and the field
     goes back to the current zoom. */
  const zoomText = fitted ? "Fit" : `${Math.round(view.zoom * 100)}%`;
  const parseZoom = (text: string): string | null => {
    if (/^\s*fit\s*$/i.test(text)) return "fit";
    const match = /^\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(text);
    if (!match) return null;
    const zoom = Number(match[1].replace(",", ".")) / 100;
    return zoom >= MIN_IMAGE_ZOOM - 1e-9 && zoom <= MAX_IMAGE_ZOOM + 1e-9 ? String(zoom) : null;
  };

  const tree = (node: ImageNode, depth: number) => {
    const children = scene.nodes.filter((child) => child.parentId === node.id);
    const open = !collapsed.has(node.id);
    return <div key={node.id} role="treeitem" aria-selected={selected.id === node.id} aria-expanded={children.length ? open : undefined} aria-level={depth + 1}>
      <div className={`image-tree__row ${selected.id === node.id ? "selected" : ""}${draggedNode === node.id ? " dragging" : ""}${treeDrop?.id === node.id ? ` image-tree__drop--${treeDrop.placement}` : ""}`} style={{ paddingLeft: `calc(var(--space-1) + ${depth} * 12px)` }}
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
        {children.length
          ? <button className="image-tree__chevron" tabIndex={-1} aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`} onClick={() => setCollapsed((current) => { const next = new Set(current); if (open) next.add(node.id); else next.delete(node.id); return next; })}>{open ? <ChevronDown14 aria-hidden="true" /> : <ChevronRight14 aria-hidden="true" />}</button>
          : <span className="image-tree__spacer" />}
        {renaming?.id === node.id ? <input className="image-tree__rename" aria-label="Rename image node" maxLength={120} ref={(element) => { if (element && document.activeElement !== element) { element.focus(); element.select(); } }} value={renaming.value} onChange={(event) => setRenaming({ ...renaming, value: event.target.value })} onBlur={() => finishRename(true, false)} onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finishRename(true); }
          if (event.key === "Escape") { event.preventDefault(); finishRename(false); }
        }} /> : <button className="image-tree__select" tabIndex={selected.id === node.id ? 0 : -1} data-tooltip={node.name} onFocus={() => setSelection(node.id)} onClick={() => setSelection(node.id)}><span className="image-tree__icon" aria-hidden="true">{node.kind === "text" ? <Text16 /> : node.kind === "root" ? <Image16 /> : node.kind === "group" ? <Group16 /> : <Cube16 />}</span><span>{node.name}</span></button>}
      </div>
      {open && children.length > 0 && <div role="group">{children.map((child) => tree(child, depth + 1))}</div>}
    </div>;
  };
  const rootField = (field: string) => `${editorId}-${field}`;
  return <div ref={editorRoot} className="image-editor" style={{ ...treePane.style, ...inspectorPane.style }}>
    <aside ref={hierarchy} className="image-tree" aria-label="Image hierarchy" onContextMenu={(event) => { if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return; event.preventDefault(); setSelection(root.id); setContextMenu({ x: event.clientX, y: event.clientY }); }} onKeyDown={treeKeys}>
      {/* Undo and Redo live in the title bar; Ctrl+Z / Ctrl+Y still step the image edits here. */}
      <PaneHeader title="Scene" />
      <div role="tree" aria-label="Image nodes">{tree(root, 0)}</div>
    </aside>
    <Splitter {...treePane.splitterProps} aria-label="Resize hierarchy" />
    {contextMenu && <HierarchyContextMenu {...contextMenu} onClose={closeContextMenu} items={[
      { label: "New Object", icon: <Cube16 />, action: () => attempt(() => add("object")) },
      { label: "New Text", icon: <Text16 />, action: () => attempt(() => add("text")) },
      { label: "New Group", icon: <FolderAdd16 />, action: () => attempt(() => add("group")) },
      { label: "New Background", icon: <Image16 />, action: () => attempt(() => add("background")) },
      { label: "Rename", icon: <Rename16 />, shortcut: "F2", separator: true, action: startRename },
      { label: "Copy", icon: <Copy16 />, shortcut: "Ctrl+C", separator: true, disabled: selected.kind === "root", action: () => copyImageNode(scene, selected.id) },
      { label: "Paste", icon: <Paste16 />, shortcut: "Ctrl+V", disabled: !clipboard, action: () => attempt(paste) },
      { label: "Duplicate", icon: <Copy16 />, shortcut: "Ctrl+D", disabled: selected.kind === "root", action: () => attempt(duplicate) },
      { label: "Delete", icon: <Delete16 />, shortcut: "Delete", separator: true, danger: true, disabled: selected.kind === "root", action: removeSelected },
    ]} />}
    {imageMenu && <HierarchyContextMenu {...imageMenu} label="Generated image actions" onClose={closeImageMenu} items={[
      { label: "New empty image", icon: <Add16 />, action: () => attempt(() => {
        undo.current = []; redo.current = []; pointer.current = null; setDraftBox(null); setDrawKind(null); setRenaming(null); setCollapsed(new Set()); setSelection("image-root");
        onChange((current) => createEmptyImage(current, template?.id));
      }) },
      ...(imageMenu.id ? [
        { label: "Edit", icon: <Edit16 />, action: () => attempt(() => config.assets.find((asset) => asset.id === imageMenu.id)?.imageDraft ? selectImage(imageMenu.id!) : replaceScene(editGeneratedImage(config, imageMenu.id!).imageScene!)) },
        { label: "Remove", icon: <Delete16 />, danger: true, disabled: workItems.some((item) => isWorkActive(item) && item.imageAssetId === imageMenu.id), action: () => removeImage(imageMenu.id!) },
      ] : []),
    ]} />}
    <section className="image-center" aria-label="Image panel">
      <div className="image-canvas-tools" role="toolbar" aria-label="Image tools">
        {/* Three columns: Generate and the generator lead, the canvas tools
            sit in the middle, the view controls at the trailing edge. */}
        <div className="image-tools__start">
          <button className="primary-button image-generate-button" data-tooltip={editPlan?.error ?? undefined} disabled={active ? work.cancelling || work.status === "encoding" : !isTauri() || !template || templateNeedsDownload(template) || (imageRoot ? Boolean(editPlan?.error) : !imageScenePrompt(scene))} onClick={() => attempt(() => active ? onCancel(work.id) : onGenerate(template!))}>{active ? <Stop14 aria-hidden="true" /> : <Sparkle16 aria-hidden="true" />}{active ? work.cancelling ? "Cancelling…" : "Cancel" : "Generate"}</button>
          <ComboBox
            className="image-generator"
            aria-label="Generator"
            data-tooltip="Generator"
            value={template?.id ?? ""}
            disabled={Boolean(active) || !imageTemplates.length}
            placeholder="No MiniMax H3 templates"
            options={imageTemplates.map((item) => ({ value: item.id, label: item.name, disabled: templateNeedsDownload(item), description: templateNeedsDownload(item) ? "Download in Settings" : undefined }))}
            onChange={(id) => { setTemplateId(id); localStorage.setItem("slopus.image-generator-template.v1", id); const next = imageTemplates.find((candidate) => candidate.id === id); if (next) commit({ ...scene, steps: next.defaultSteps }); }}
          />
        </div>
        <div className="image-tools__group" role="radiogroup" aria-label="Canvas tool" onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const at = TOOLS.findIndex((tool) => tool.id === drawKind);
          const next = TOOLS[(at + (event.key === "ArrowRight" ? 1 : -1) + TOOLS.length) % TOOLS.length];
          chooseTool(next.id);
          requestAnimationFrame(() => event.currentTarget.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
        }}>
          {TOOLS.map((tool) => <button
            key={tool.label}
            type="button"
            role="radio"
            aria-checked={drawKind === tool.id}
            aria-label={tool.label}
            aria-keyshortcuts={tool.key}
            tabIndex={drawKind === tool.id ? 0 : -1}
            className={`image-tool${drawKind === tool.id ? " image-tool--on" : ""}`}
            {...tooltipProps(tool.label, tool.key)}
            onClick={() => chooseTool(tool.id)}
          ><span aria-hidden="true">{drawKind === tool.id ? tool.onIcon : tool.icon}</span></button>)}
        </div>
        <div className="image-tools__end">
          <button className={`image-tool${boxes ? " image-tool--on" : ""}`} aria-label="Show placement boxes" aria-pressed={boxes} data-tooltip="Show placement boxes" onClick={() => { setBoxes(!boxes); setDrawKind(null); }}>{boxes ? <Boxes16Filled aria-hidden="true" /> : <Boxes16 aria-hidden="true" />}</button>
          <span className="image-tools__separator" role="separator" aria-orientation="vertical" />
          <ComboBox
            editable
            className="image-zoom"
            aria-label="Image zoom"
            data-tooltip="Zoom (Ctrl+0 fit, Ctrl+1 100%, Ctrl+= in, Ctrl+- out)"
            value={zoomValue}
            displayText={zoomText}
            parseText={parseZoom}
            options={zoomOptions}
            onChange={(value) => { if (value === "fit") fit(); else zoomTo(Number(value)); }}
          />
        </div>
      </div>
      <div ref={viewport} tabIndex={-1} className={`image-viewport${panning ? " panning" : ""}`} data-tooltip="Scroll to zoom · drag with the middle button to pan"
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
        {imageRoot && scene.sourceImage ? <ReferenceImage folderPath={folderPath} relativePath={scene.sourceImage.relativePath} alt={scene.sourceImage.name} /> : output && !imageRoot && (output.relativePath || output.sourcePath) ? <ReferenceImage folderPath={folderPath} relativePath={output.relativePath} sourcePath={output.sourcePath} alt={output.name} /> : <div className="image-empty"><Image32 aria-hidden="true" /><strong>{imageRoot ? "Open an image to edit" : "Compose your image"}</strong><span>{imageRoot ? "Choose Open image in the inspector, then add Object nodes for edits." : "Add objects, text and groups, then describe them in the inspector."}</span></div>}
        <svg className={`image-overlay ${drawKind ? "drawing" : ""}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Image placement canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { pointer.current = null; setDraftBox(null); }}>
          {boxes && scene.nodes.filter((node) => node.box).map((node) => {
            const box = pointer.current?.id === node.id && draftBox ? draftBox : node.box!;
            return <g key={node.id} className={selected.id === node.id ? "selected" : ""}><rect data-node={node.id} x={box.x} y={box.y} width={box.width} height={box.height} vectorEffect="non-scaling-stroke" />{selected.id === node.id && <rect className="image-box-handle" data-node={node.id} data-resize="true" x={box.x + box.width - 16} y={box.y + box.height - 16} width="16" height="16" />}</g>;
          })}
          {draftBox && !pointer.current?.id && <rect className="image-box-draft" {...{ x: draftBox.x, y: draftBox.y, width: draftBox.width, height: draftBox.height }} />}
        </svg>
        {boxes && scene.nodes.filter((node) => node.box).map((node) => { const box = pointer.current?.id === node.id && draftBox ? draftBox : node.box!; return <span key={node.id} className="image-box-label" style={{ left: `${box.x / 10}%`, top: `${box.y / 10}%` }}>{node.name}</span>; })}
      </div></div>
      {(error || work?.error) && <InfoBar className="image-error" severity="error" title="Couldn’t update the image" message={error ?? work?.error ?? ""} onClose={error ? () => setError(null) : undefined} />}
      <div className="image-status" role="status">{active && <ProgressBar value={work.progress * 100} aria-label="Image generation progress" />}<span>{active ? work.detail : imageRoot ? editPlan?.error ?? `${width} × ${height} · ${editPlan?.edits.length} edits in hierarchy order` : !isTauri() ? "Image generation is available in the desktop app." : `${width} × ${height} · Placement boxes guide the prompt`}</span></div>
      <ImageBar ref={imageResults} images={images} selectedId={scene.outputAssetId} folderPath={folderPath} onSelect={selectImage}
        onMenu={(id, x, y) => { setContextMenu(null); setImageMenu({ id, x, y }); }} />
    </section>
    <Splitter {...inspectorPane.splitterProps} reverse aria-label="Resize inspector" />
    <aside className="image-inspector" aria-label="Image node inspector">
      {/* The selected node heads the inspector, not an "Inspector" title. */}
      {/* The name is edited in place in the header, as a shot's or a clip's
          is; an image-edit root has no name of its own to change. */}
      <ItemHeader
        name={selected.kind === "root" && imageRoot ? selected.name : <h2 className="image-inspector__name" aria-label={selected.name}><input
          className="ui-item-header__input"
          value={selected.name}
          maxLength={120}
          aria-label="Name"
          data-tooltip="Rename"
          onChange={(event) => { if (event.target.value.trim()) patchNode({ name: event.target.value }); }}
        /></h2>}
        meta={selected.kind[0].toUpperCase() + selected.kind.slice(1)}
      />
      <div className="image-inspector__fields">
        {selected.kind === "root" && <PropRow label="Type" htmlFor={rootField("type")}>
          <ComboBox id={rootField("type")} aria-label="Type" value={imageRoot ? "image" : "prompt"} options={[{ value: "prompt", label: "Prompt" }, { value: "image", label: "Image" }]}
            onChange={(value) => replaceScene(value === "image" ? createImageEditScene(null, scene) : { ...createImageScene(), steps: scene.steps, seed: scene.seed })} />
        </PropRow>}
        {selected.kind === "root" && imageRoot ? <>
          <button className="secondary-button" disabled={!isTauri()} onClick={() => attempt(async () => {
            const source = await invoke<ImageSource | null>("open_image_source", { folderPath });
            if (source) replaceScene(createImageEditScene(source, scene));
          })}><FolderOpen16 aria-hidden="true" />Open image</button>
          {scene.sourceImage && <p className="image-inspector__caption">{scene.sourceImage.name} · {scene.sourceImage.width} × {scene.sourceImage.height}</p>}
        </> : <>
          <label className="image-inspector__area">{selected.kind === "root" ? "Prompt (high-level description)" : "Description"}<textarea className="text-field" rows={4} value={selected.description} onChange={(event) => patchNode({ description: event.target.value })} /></label>
        </>}
        {selected.kind === "text" && <PropRow label="Text to render" htmlFor={rootField("text")}><input id={rootField("text")} className="text-field" value={selected.text} onChange={(event) => patchNode({ text: event.target.value })} /></PropRow>}
        {selected.kind === "root" && !imageRoot && <>
          <label className="image-inspector__area">Background (environment)<textarea className="text-field" rows={3} value={scene.background} onChange={(event) => commit({ ...scene, background: event.target.value })} /></label>
          <PropSection title="Image generation" persistKey="image.generation">
            <PropRow label="Steps" htmlFor={rootField("steps")}><input id={rootField("steps")} className="text-field" type="number" min="2" max="1000" value={scene.steps} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 2 && value <= 1000) commit({ ...scene, steps: value }); }} /></PropRow>
            <PropRow label="Seed" htmlFor={rootField("seed")}><input id={rootField("seed")} className="text-field" type="number" min="-1" max={Number.MAX_SAFE_INTEGER} value={scene.seed} data-tooltip="-1 picks a random seed" onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= -1) commit({ ...scene, seed: value }); }} /></PropRow>
            <PropRow label="Aspect ratio" htmlFor={rootField("ratio")}><ComboBox id={rootField("ratio")} aria-label="Aspect ratio" value={config.settings.aspectRatio} options={["16:9", "9:16", "1:1", "4:5"].map((ratio) => ({ value: ratio, label: ratio }))} onChange={(value) => { const aspectRatio = value as ProjectConfig["settings"]["aspectRatio"]; onChange((current) => ({ ...current, settings: { ...current.settings, aspectRatio }, brief: { ...current.brief, aspectRatio } })); }} /></PropRow>
            <PropRow label="Resolution" htmlFor={rootField("resolution")}><ComboBox id={rootField("resolution")} aria-label="Resolution" value={config.settings.resolution} options={[...new Set([...IMAGE_RESOLUTIONS, config.settings.resolution])].map((resolution) => { const size = outputDimensions(resolution, config.settings.aspectRatio); return { value: resolution, label: `${size.width} × ${size.height}` }; })} onChange={(value) => { const resolution = value as ProjectConfig["settings"]["resolution"]; onChange((current) => ({ ...current, settings: { ...current.settings, resolution }, brief: { ...current.brief, resolution } })); }} /></PropRow>
          </PropSection>
          <PropSection title="Style" persistKey="image.style">
            <PropRow label="Mode" htmlFor={rootField("mode")}><ComboBox id={rootField("mode")} aria-label="Mode" value={scene.style.mode} options={[{ value: "photo", label: "Photo" }, { value: "art", label: "Art" }]} onChange={(value) => commit({ ...scene, style: { ...scene.style, mode: value as "photo" | "art" } })} /></PropRow>
            <TagEditor label="Aesthetics" value={scene.style.aesthetics} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoAestheticsSuggestions : styleSuggestions.ArtAestheticsSuggestions} onChange={(aesthetics) => commit({ ...scene, style: { ...scene.style, aesthetics } })} />
            <TagEditor label="Lighting" value={scene.style.lighting} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoLightingSuggestions : styleSuggestions.ArtLightingSuggestions} onChange={(lighting) => commit({ ...scene, style: { ...scene.style, lighting } })} />
            {scene.style.mode === "art" && <TagEditor label="Medium" value={scene.style.medium} suggestions={styleSuggestions.MediumSuggestions} onChange={(medium) => commit({ ...scene, style: { ...scene.style, medium } })} />}
            <TagEditor key={scene.style.mode} label={scene.style.mode === "photo" ? "Camera / lens" : "Art style"} value={scene.style.detail} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoSuggestions : styleSuggestions.ArtSuggestions} onChange={(detail) => commit({ ...scene, style: { ...scene.style, detail } })} />
          </PropSection>
          <PropSection title="References" persistKey="image.references">
            {config.references.filter((reference) => reference.kind === "image" || reference.kind === "text").map((reference) => <label className="image-check" key={reference.id}><input type="checkbox" checked={scene.referenceIds.includes(reference.id)} onChange={(event) => commit({ ...scene, referenceIds: event.target.checked ? [...scene.referenceIds, reference.id] : scene.referenceIds.filter((id) => id !== reference.id) })} />{reference.name}</label>)}
            {!config.references.length && <p className="image-inspector__caption">None yet — add them under References.</p>}
          </PropSection>
        </>}
        {selected.kind !== "root" && <PropSection title="Placement (0–1000)" persistKey="image.placement">
          <label className="image-check"><input type="checkbox" checked={Boolean(selected.box)} onChange={(event) => patchNode({ box: event.target.checked ? { x: 250, y: 250, width: 500, height: 500 } : null })} />Explicit placement</label>
          {selected.box && (["x", "y", "width", "height"] as const).map((field) => <PropRow key={field} label={field === "x" ? "X" : field === "y" ? "Y" : field === "width" ? "Width" : "Height"} htmlFor={rootField(field)}>
            <input id={rootField(field)} className="text-field" type="number" min={field === "x" || field === "y" ? 0 : 1} max="1000" value={selected.box![field]} onChange={(event) => { const value = Number(event.target.value); const box = { ...selected.box!, [field]: value }; if (Number.isFinite(value) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1000 && box.y + box.height <= 1000) commit(resizeImageNode(scene, selected.id, box)); }} />
          </PropRow>)}
        </PropSection>}
        {!(selected.kind === "root" && imageRoot) && <PropSection title="Color palette" persistKey="image.palette">
          <div className="image-palette">{selected.colors.map((color, index) => <div key={index}><input aria-label={`Palette color ${index + 1}`} type="color" value={color} onChange={(event) => patchNode({ colors: selected.colors.map((old, i) => i === index ? event.target.value : old) })} /><button className="icon-button image-pane-button" aria-label={`Remove color ${index + 1}`} data-tooltip="Remove color" onClick={() => patchNode({ colors: selected.colors.filter((_, i) => i !== index) })}><Delete14 aria-hidden="true" /></button></div>)}<button className="secondary-button" disabled={selected.colors.length >= (selected.kind === "root" ? 16 : 5)} onClick={() => patchNode({ colors: [...selected.colors, "#808080"] })}><Add14 aria-hidden="true" />Color</button></div>
        </PropSection>}
      </div>
      {debugEnabled && <div className="debug-prompt"><button type="button" className="secondary-button debug-prompt__toggle" aria-haspopup="dialog" onClick={() => attempt(() => setDebugPrompt(imageRoot ? imageEditDebugPrompt(compileImageEdits(config).edits) : compileImagePrompt(config).prompt))}>Debug prompt</button></div>}
    </aside>
    {debugEnabled && debugPrompt !== null && <DebugPromptDialog sceneTitle={config.name} segments={[{ kind: "brief", value: debugPrompt }]} onClose={() => setDebugPrompt(null)} />}
  </div>;
}
