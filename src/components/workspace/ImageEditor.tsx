import { activeGenerationEffects } from "../../lib/generationEffects";
import { GenerationEffects } from "./GenerationEffects";
import { applyLassoStroke } from "../../lib/imageLasso";
import { EditBox16 } from "../ui/icons";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent } from "react";
import { Add14, Add16, Boxes16, Boxes16Filled, ChevronDown14, ChevronRight14, Copy16, Cube16, Cube16Filled, Cursor16, Cursor16Filled, Delete14, Delete16, Edit16, Film16, FolderAdd16, FolderOpen16, Group16, Group16Filled, Image16, Image32, Lasso16, Paste16, References16, Rename16, Sparkle16, Stop14, Text16, Text16Filled } from "../ui/icons";
import { invoke } from "@tauri-apps/api/core";
import { addImageNode, createImageEditScene, createImageScene, duplicateImageNode, imageDescendants, imageScenePrompt, imageLassoPath, imageLassoSchema, simplifyImageLasso, removeImageNode, resizeImageNode, type ImageBox, type ImageNode, type ImageScene, type ImageSource, type ImagePoint } from "../../lib/imageScene";
import { compileImageEdits, editGeneratedImage, imageEditDebugPrompt, imageEditOutputSize, imageEditSize } from "../../lib/imageEditing";
import { imageSettings } from "../../lib/imageSettings";
import { outputDimensions } from "../../lib/export";
import { compileImagePrompt } from "../../lib/imagePrompt";
import { createEmptyImage, imageFamily, imageFamilyRoot, makeImagePrimary, removeImageAsset, restoreGeneratedImage, saveImageDraft } from "../../lib/imageHistory";
import { isTauri } from "../../lib/persistence";
import { createDraftGenerationJob, isVideoReference, PROJECT_RESOLUTIONS, referenceTypeLabel, type ProjectConfig, type ProjectReference } from "../../lib/project";
import { defaultGeneratorTemplate, selectedImageGeneratorTemplate, generationStepsForTemplate, loadDebugOptionsEnabled, loadGeneratorTemplateSettings, MINIMAX_H3_MODEL_TYPE, generatorModel, templateSupportsImages, subscribeDebugOptions, subscribeGeneratorTemplates, templateUsable, type GeneratorTemplate } from "../../lib/settings";
import { isWorkActive, MAX_IMAGE_BATCH_COUNT, type WorkItem } from "../../lib/workQueue";
import type { ConfigUpdate } from "./TimelineView";
import { ReferenceImage } from "./ReferenceImage";
import { PromptTextField } from "./PromptTextField";
import { ReferenceIcon } from "./ReferenceIcon";
import { ImageBar } from "./ImageBar";
import { CharacterSheetSettings } from "./CharacterSheetSettings";
import { ExtendSettings } from "./ExtendSettings";
import { ExtendCanvas } from "./ExtendCanvas";
import { extendOutputDimensions, initialExtendBounds, type ExtendOptions } from "../../lib/extendImage";
import type { CharacterSheetOptions } from "../../lib/characterSheet";
import { referenceMediaTypes } from "../../lib/referenceSelection";
import { DebugPromptDialog } from "./DebugPromptDialog";
import { TagEditor } from "./TagEditor";
import styleSuggestions from "../../lib/imageStyleSuggestions.json";
import { applyImageCommand } from "../../lib/imageCommands";
import { copyImageNode, getImageNodeClipboard, pasteImageNode, subscribeImageNodeClipboard } from "../../lib/imageNodeClipboard";
import { HierarchyContextMenu } from "./HierarchyContextMenu";
import { useShortcut } from "../../lib/commands";
import { ComboBox, Flyout, InfoBar, ItemHeader, PaneHeader, ProgressBar, PropRow, PropSection, Splitter, tooltipProps, useContextMenu, usePaneSize } from "../ui";
import "../../styles/image-editor.css";

const MIN_IMAGE_ZOOM = 0.1;
const MAX_IMAGE_ZOOM = 8;

function UsedImageSeed({ id, seed, onError }: { id: string; seed: number | undefined; onError: (message: string) => void }) {
  return <PropRow label="Used seed" htmlFor={id}>
    <input id={id} className="text-field" readOnly value={seed ?? "Not recorded"} />
    <button type="button" className="icon-button" aria-label="Copy used seed" data-tooltip="Copy used seed" disabled={seed === undefined} onClick={async () => {
      try { await navigator.clipboard.writeText(String(seed)); }
      catch { onError("Could not copy the seed. Select and copy it from the field."); }
    }}><Copy16 aria-hidden="true" /></button>
  </PropRow>;
}

export function ImageEditor({ config, folderPath, onChange: changeConfig, onGenerate, onGenerateCharacterSheet, onGenerateExtend, onCancel, onOpenGenerator, onOpenReferences, workItems = [], openImage, onImageOpened }: {
  config: ProjectConfig; folderPath: string; onChange: (update: ConfigUpdate) => void;
  onGenerate: (template: GeneratorTemplate, count: number) => void; onCancel: (id: string) => Promise<void>; workItems?: readonly WorkItem[];
  onGenerateCharacterSheet?: (template: GeneratorTemplate, sourceId: string, options: CharacterSheetOptions) => void;
  onGenerateExtend?: (template: GeneratorTemplate, sourceId: string, options: ExtendOptions) => void;
  onOpenGenerator?: (jobId: string) => void;
  onOpenReferences?: () => void;
  openImage?: { id: string };
  onImageOpened?: () => void;
}) {
  const scene = useMemo(() => config.imageScene ?? { ...createImageScene(config.brief.prompt), steps: selectedImageGeneratorTemplate().defaultSteps }, [config.imageScene, config.brief.prompt]);
  const settings = imageSettings(config);
  const root = scene.nodes.find((node) => node.kind === "root")!;
  const imageRoot = scene.rootType === "image";
  const editSize = imageRoot && scene.sourceImage ? imageEditOutputSize(scene) : null;
  const sizeValue = (size: { width: number; height: number }) => `${size.width}x${size.height}`;
  const editSizes = imageRoot && scene.sourceImage ? [...new Map([
    imageEditSize(scene.sourceImage),
    ...PROJECT_RESOLUTIONS.map((resolution) => imageEditSize(scene.sourceImage!, Number.parseInt(resolution))),
    ...(editSize ? [editSize] : []),
  ].filter((size) => size.width <= 8192 && size.height <= 8192).map((size) => [sizeValue(size), size])).values()] : [];
  const generatedImage = config.assets.find((asset) => asset.id === scene.outputAssetId && !asset.imageDraft && asset.imageGeneration);
  const recordedSeed = generatedImage?.imageGeneration?.usedSeed ?? generatedImage?.imageGeneration?.scene.seed;
  const usedSeed = recordedSeed !== undefined && recordedSeed >= 0 ? recordedSeed : undefined;
  const [selection, setSelection] = useState(root.id);
  const selected = scene.nodes.find((node) => node.id === selection) ?? root;
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [draggedNode, setDraggedNode] = useState<string | null>(null);
  const [treeDrop, setTreeDrop] = useState<{ id: string; placement: "before" | "inside" | "after" } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [imageMenu, setImageMenu] = useState<{ id: string | null; x: number; y: number; inFamily: boolean; source: "bar" | "canvas" } | null>(null);
  const templateMenu = useContextMenu();
  const [templateSourceId, setTemplateSourceId] = useState<string | null>(null);
  const [extendSourceId, setExtendSourceId] = useState<string | null>(null);
  const [extendOptions, setExtendOptions] = useState<ExtendOptions | null>(null);
  const extendMode = extendSourceId !== null && extendSourceId === scene.outputAssetId;
  useEffect(() => { setTemplateSourceId(null); setExtendSourceId(null); }, [scene.outputAssetId]);
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
  const [templateId, setTemplateId] = useState(() => selectedImageGeneratorTemplate().id);
  const imageTemplates = templates.templates.filter(templateSupportsImages);
  const template = imageTemplates.find((candidate) => candidate.id === templateId) ?? imageTemplates.find(templateUsable) ?? imageTemplates[0];
  const model = generatorModel(template?.modelType);
  const editPlan = useMemo(() => {
    if (!imageRoot) return null;
    try { return { ...compileImageEdits(config, { modelType: template?.modelType }), error: null }; }
    catch (reason) { return { edits: [], error: String(reason instanceof Error ? reason.message : reason) }; }
  }, [config, imageRoot, template?.modelType]);
  const inputBlocked = useMemo(() => {
    if (imageRoot || !model.requiresImageInput) return null;
    try { compileImagePrompt(config, { modelType: template?.modelType }); return null; }
    catch (reason) { return reason instanceof Error ? reason.message : String(reason); }
  }, [config, imageRoot, model.requiresImageInput, template?.modelType]);
  const outpaintingBlocked = !model.imageOutpainting ? `${model.label} does not support Zoom.` : null;
  const effectsBlocked = activeGenerationEffects(scene.generationEffects) && !model.generationEffects ? "This model does not support generation effects. Bypass or remove the effects, or choose another generator." : null;
  const editingBlocked = !model.imageEditing ? `${model.label} does not support image editing. Choose an editing generator.` : null;
  const referencesBlocked = !model.characterSheets ? `${model.label} does not support character sheets. Choose a character sheet generator.` : null;
  const creationBlocked = !imageRoot && !model.imageCompositionCreation;
  const isMiniMaxH3 = !template || template.modelType === MINIMAX_H3_MODEL_TYPE;
  const onChange = (update: ConfigUpdate) => changeConfig((current) => {
    const next = typeof update === "function" ? update(current) : update;
    const selecting = next.imageScene?.outputAssetId && next.imageScene.outputAssetId !== current.imageScene?.outputAssetId;
    return saveImageDraft(next, selecting ? undefined : template?.id);
  });
  const [error, setError] = useState<string | null>(null);
  const [generationCount, setGenerationCount] = useState("1");
  const [generationOptionsOpen, setGenerationOptionsOpen] = useState(false);
  const generationOptionsButton = useRef<HTMLButtonElement>(null);
  const generationCountInput = useRef<HTMLInputElement>(null);
  const count = Number(generationCount);
  const validCount = Number.isInteger(count) && count >= 1 && count <= MAX_IMAGE_BATCH_COUNT;
  const debugEnabled = useSyncExternalStore(subscribeDebugOptions, loadDebugOptionsEnabled);
  const [debugPrompt, setDebugPrompt] = useState<string | null>(null);
  useEffect(() => { if (!debugEnabled) setDebugPrompt(null); }, [debugEnabled]);
  const [boxes, setBoxes] = useState(true);
  const [drawKind, setDrawKind] = useState<"object" | "text" | "group" | "lasso" | null>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const pan = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [draftBox, setDraftBox] = useState<ImageBox | null>(null);
  const [draftLasso, setDraftLasso] = useState<ImagePoint[] | null>(null);
  const [lassoModifier, setLassoModifier] = useState<"" | "add" | "subtract">("");
  const updateLassoModifier = (event: { altKey: boolean; ctrlKey: boolean }) => setLassoModifier(event.altKey ? "subtract" : event.ctrlKey ? "add" : "");
  useEffect(() => {
    if (drawKind !== "lasso") { setLassoModifier(""); return; }
    const reset = () => setLassoModifier("");
    window.addEventListener("keydown", updateLassoModifier); window.addEventListener("keyup", updateLassoModifier); window.addEventListener("blur", reset);
    return () => { window.removeEventListener("keydown", updateLassoModifier); window.removeEventListener("keyup", updateLassoModifier); window.removeEventListener("blur", reset); };
  }, [drawKind]);
  const undo = useRef<ImageScene[]>([]);
  const redo = useRef<ImageScene[]>([]);
  const [, historyChanged] = useState(0);
  const pointer = useRef<{ x: number; y: number; scene: ImageScene; id?: string; resize: boolean; box?: ImageBox; lasso?: ImagePoint[] } | null>(null);
  useEffect(() => {
    if (!creationBlocked) return;
    pointer.current = null; setDraftBox(null); setDraftLasso(null); setDrawKind(null);
  }, [creationBlocked]);
  useEffect(() => {
    // Applied edits belong to the old source and must not be resurrected by Undo.
    undo.current = []; redo.current = []; historyChanged((value) => value + 1);
    pointer.current = null; setDraftBox(null); setDraftLasso(null); setDrawKind(null); setRenaming(null);
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
  }, [extendMode]);
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (pan.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    pan.current = null; setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const work = workItems.filter((item) => (item.imageDraftId ?? item.imageAssetId ?? item.id) === scene.outputAssetId).at(-1);
  const active = work && isWorkActive(work);
  const output = config.assets.find((asset) => asset.id === scene.outputAssetId);
  const templateSnapshot = output?.imageDraft ? output.imageGeneration?.template : undefined;
  const runningTemplate = active ? templateSnapshot : undefined;
  const templateSource = runningTemplate && config.assets.find((asset) => asset.id === runningTemplate.sourceId);
  let extendSize: { width: number; height: number } | null = null;
  if (extendMode && extendOptions && output?.width && output.height) {
    try { extendSize = extendOutputDimensions(config, extendOptions.bounds); }
    catch { /* Invalid bounds are explained in Zoom settings. */ }
  }
  const images = config.assets.filter((asset) => asset.kind === "image");
  const menuImage = images.find((asset) => asset.id === imageMenu?.id);
  const canUseMenuImage = Boolean(menuImage?.relativePath || menuImage?.sourcePath);
  // Generated assets retain the dimensions returned by the native encoder.
  // Image settings size only the empty canvas and future generation requests.
  const showResult = Boolean(output && !output.imageDraft && output.imageGeneration && (output.relativePath || output.sourcePath));
  const { width, height } = showResult && output?.width && output.height ? { width: output.width, height: output.height } : imageRoot && scene.sourceImage ? scene.sourceImage : output?.width && output?.height
    ? { width: output.width, height: output.height }
    : outputDimensions(settings.resolution, settings.aspectRatio);
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
    if (creationBlocked || (imageRoot && editingBlocked)) return;
    const parent = imageRoot ? root.id : insertParent;
    const next = addImageNode(scene, parent, imageRoot ? "object" : kind, box);
    if (imageRoot) Object.assign(next.nodes.at(-1)!, { name: "Edit" });
    commit(next); setSelection(next.nodes.at(-1)!.id);
    setCollapsed((current) => { const next = new Set(current); next.delete(parent); return next; });
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
    setImageMenu(null); (imageMenu?.source === "canvas" ? viewport.current : button ?? imageResults.current)?.focus();
  };
  const openCanvasMenu = (x: number, y: number) => {
    setContextMenu(null);
    setImageMenu(output ? { id: output.id, x, y, inFamily: imageFamily(images, output.id).length > 1, source: "canvas" } : null);
  };
  const resetImageEditing = (id: string) => {
    const asset = config.assets.find((asset) => asset.id === id);
    const snapshot = asset?.imageGeneration;
    undo.current = []; redo.current = []; historyChanged((value) => value + 1);
    pointer.current = null; setDraftBox(null); setDraftLasso(null); setDrawKind(null); setRenaming(null);
    setCollapsed(new Set()); setSelection(snapshot?.scene.nodes.find((node) => node.kind === "root")?.id ?? "image-root");
    if (snapshot && imageTemplates.some((candidate) => candidate.id === snapshot.generatorTemplateId)) {
      setTemplateId(snapshot.generatorTemplateId);
      localStorage.setItem("slopus.image-generator-template.v1", snapshot.generatorTemplateId);
    }
  };
  const selectImage = (id: string) => {
    resetImageEditing(id);
    attempt(() => onChange((current) => restoreGeneratedImage(current, id, template?.defaultSteps)));
  };
  useEffect(() => {
    if (!openImage) return;
    if (config.assets.some((asset) => asset.kind === "image" && asset.id === openImage.id)) {
      if (scene.outputAssetId !== openImage.id) selectImage(openImage.id);
      setTemplateSourceId(null); setExtendSourceId(null);
      setView({ zoom: 1, x: 0, y: 0 });
    }
    onImageOpened?.();
  }, [openImage]);
  const measureImportedImage = (id: string, size: { width: number; height: number }) => attempt(() => {
    onChange((current) => {
      const asset = current.assets.find((item) => item.id === id);
      if (!asset?.relativePath || asset.imageGeneration || current.imageScene?.outputAssetId !== id || current.imageScene.rootType === "image") return current;
      const next = { ...current, assets: current.assets.map((item) => item.id === id ? { ...item, ...size } : item) };
      return restoreGeneratedImage(next, id, template?.defaultSteps);
    });
  });
  const createFromImage = (id: string, asScene: boolean) => {
    const asset = config.assets.find((candidate) => candidate.id === id && candidate.kind === "image");
    if (!asset || (!asset.relativePath && !asset.sourcePath)) return;
    const referenceId = `ref-${crypto.randomUUID()}`;
    const reference: ProjectReference = {
      id: referenceId, kind: "text", name: asset.name, description: "", intendedUse: [], createdAt: new Date().toISOString(),
      images: [{ id: `${referenceId}-image`, name: asset.name, relativePath: asset.relativePath, sourcePath: asset.sourcePath }],
    };
    const job = asScene ? createDraftGenerationJob("", {
      title: asset.name, sceneType: "first-last-frame", startFrameReferenceId: referenceId,
      steps: defaultGeneratorTemplate().defaultSteps,
    }) : null;
    onChange((current) => ({ ...current, references: [reference, ...current.references],
      generationJobs: job ? [...current.generationJobs, job] : current.generationJobs }));
    if (job) onOpenGenerator?.(job.id);
    else onOpenReferences?.();
  };
  const replaceScene = (next: ImageScene) => {
    undo.current = []; redo.current = []; historyChanged((value) => value + 1);
    pointer.current = null; setDraftBox(null); setDraftLasso(null); setDrawKind(null); setCollapsed(new Set());
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
      const family = imageFamily(currentImages, id);
      const familyLeft = imageFamily(removeImageAsset(currentImages, id), family.find((asset) => asset.id !== id)?.id);
      const next = !removingSelected ? remaining.find((asset) => asset.id === currentScene.outputAssetId)
        : familyLeft.length ? familyLeft[Math.min(family.findIndex((asset) => asset.id === id), familyLeft.length - 1)]
          : remaining[Math.min(currentImages.findIndex((asset) => asset.id === id), remaining.length - 1)];
      const updated = { ...current,
        assets: removeImageAsset(current.assets, id),
        imageScene: removingSelected && removed.imageDraft && !next ? currentScene.rootType === "image" ? createImageEditScene(null, currentScene) : { ...createImageScene(), steps: template?.defaultSteps ?? 20 } : { ...currentScene, outputAssetId: removingSelected ? next?.id ?? null : currentScene.outputAssetId },
        thumbnail: removingSelected || current.thumbnail === removed.relativePath ? next?.relativePath ?? null : current.thumbnail,
        timeline: { ...current.timeline, tracks: current.timeline.tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.assetId !== id) })) },
      };
      return removingSelected && next ? restoreGeneratedImage(updated, next.id, template?.defaultSteps) : updated;
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
    pointer.current = null; setDraftBox(null); setDraftLasso(null);
    const parent = selected.parentId ?? root.id;
    commit(removeImageNode(scene, selected.id)); setSelection(parent);
    requestAnimationFrame(() => focusNode(parent));
  };
  const paste = () => {
    if (creationBlocked) return;
    const result = pasteImageNode(scene, insertParent);
    if (!result) return;
    commit(result.scene); setSelection(result.id);
    setCollapsed((current) => { const next = new Set(current); next.delete(insertParent); return next; });
    requestAnimationFrame(() => focusNode(result.id));
  };
  const duplicate = () => {
    if (creationBlocked) return;
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
    if (event.button !== 0 || !boxes || (imageRoot && editingBlocked)) return;
    viewport.current?.focus({ preventScroll: true });
    const target = event.target as SVGElement;
    const id = drawKind ? undefined : target.dataset.node;
    if (!id && !drawKind) { setSelection(root.id); return; }
    if (id) setSelection(id);
    const at = point(event);
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    pointer.current = { ...at, scene, id, resize: target.dataset.resize === "true" && !scene.nodes.find((node) => node.id === id)?.lasso, ...(drawKind === "lasso" ? { lasso: [at] } : {}) };
    if (drawKind === "lasso") setDraftLasso([at]);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (drawKind === "lasso") updateLassoModifier(event);
    const start = pointer.current; if (!start) return;
    const at = point(event);
    if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
    const original = start.scene.nodes.find((node) => node.id === start.id)?.box;
    if (start.lasso) {
      if (Math.hypot(at.x - start.lasso.at(-1)!.x, at.y - start.lasso.at(-1)!.y) < 2) return;
      start.lasso.push(at);
      if (start.lasso.length > 2048) start.lasso = start.lasso.filter((_, index) => index % 2 === 0);
      setDraftLasso([...start.lasso]);
      return;
    }
    if (original) {
      const x = start.resize ? original.x : Math.max(0, Math.min(1000 - original.width, original.x + at.x - start.x));
      const y = start.resize ? original.y : Math.max(0, Math.min(1000 - original.height, original.y + at.y - start.y));
      start.box = { x, y, width: start.resize ? Math.max(1, Math.min(1000 - x, original.width + at.x - start.x)) : original.width, height: start.resize ? Math.max(1, Math.min(1000 - y, original.height + at.y - start.y)) : original.height };
    } else start.box = { x: Math.min(start.x, at.x), y: Math.min(start.y, at.y), width: Math.abs(at.x - start.x), height: Math.abs(at.y - start.y) };
    setDraftBox(start.box);
  };
  const pointerUp = (event: PointerEvent<SVGSVGElement>) => {
    pointerMove(event);
    const start = pointer.current;
    if (start?.lasso) {
      const points = simplifyImageLasso(start.lasso);
      const x = Math.min(...points.map((point) => point.x)), y = Math.min(...points.map((point) => point.y));
      const width = Math.max(...points.map((point) => point.x)) - x, height = Math.max(...points.map((point) => point.y)) - y;
      if (imageLassoSchema.safeParse(points).success && width >= 5 && height >= 5) {
        attempt(() => {
          const mode = event.altKey ? "subtract" : event.ctrlKey ? "add" : "new";
          const result = applyLassoStroke(start.scene, points, mode, selected.id);
          commit(result.scene); setSelection(result.id);
          setCollapsed((current) => { const next = new Set(current); next.delete(root.id); return next; });
          if (mode === "new") setDrawKind(null);
        });
      }
    } else if (start?.box && start.box.width > 0 && start.box.height > 0) {
      if (start.id) commit(resizeImageNode(start.scene, start.id, start.box));
      else if (drawKind && drawKind !== "lasso" && start.box.width >= 5 && start.box.height >= 5) { add(drawKind, start.box); setDrawKind(null); }
    }
    pointer.current = null; setDraftBox(null); setDraftLasso(null);
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
  useShortcut("Delete", removeSelected, { scope: viewport, enabled: !extendMode });

  /* Canvas tools: a radio group of icon toggles with one-letter keys. */
  const TOOLS = [
    { id: null, label: "Select", key: "V", icon: <Cursor16 />, onIcon: <Cursor16Filled /> },
    ...(imageRoot ? [{ id: "object", label: "Edit Box", key: "E", icon: <EditBox16 />, onIcon: <EditBox16 /> },
      { id: "lasso", label: "Lasso", key: "L", icon: <Lasso16 />, onIcon: <Lasso16 /> }] as const : [
      { id: "object", label: "Draw object", key: "O", icon: <Cube16 />, onIcon: <Cube16Filled /> },
      { id: "text", label: "Draw text", key: "T", icon: <Text16 />, onIcon: <Text16Filled /> },
      { id: "group", label: "Draw group", key: "G", icon: <Group16 />, onIcon: <Group16Filled /> },
    ] as const),
  ] as const;
  const chooseTool = (id: typeof drawKind) => { if (extendMode || (id && (creationBlocked || (imageRoot && editingBlocked)))) return; pointer.current = null; setDraftBox(null); setDraftLasso(null); setDrawKind(id); if (id) setBoxes(true); };
  useShortcut("V", () => chooseTool(null), { scope: editorRoot });
  useShortcut("E", () => chooseTool("object"), { scope: editorRoot, enabled: imageRoot && !editingBlocked });
  useShortcut("L", () => chooseTool("lasso"), { scope: editorRoot, enabled: imageRoot && !editingBlocked });
  useShortcut("O", () => chooseTool("object"), { scope: editorRoot, enabled: !imageRoot && !creationBlocked });
  useShortcut("T", () => chooseTool("text"), { scope: editorRoot, enabled: !imageRoot && !creationBlocked });
  useShortcut("G", () => chooseTool("group"), { scope: editorRoot, enabled: !imageRoot && !creationBlocked });
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
        }} /> : <button className="image-tree__select" tabIndex={selected.id === node.id ? 0 : -1} data-tooltip={node.name} onFocus={() => setSelection(node.id)} onClick={() => setSelection(node.id)}><span className="image-tree__icon" aria-hidden="true">{node.kind === "root" ? <Image16 /> : node.lasso ? <Lasso16 /> : imageRoot ? <Edit16 /> : node.kind === "text" ? <Text16 /> : node.kind === "group" ? <Group16 /> : <Cube16 />}</span><span>{node.name}</span></button>}
      </div>
      {open && children.length > 0 && <div role="group">{children.map((child) => tree(child, depth + 1))}</div>}
    </div>;
  };
  const rootField = (field: string) => `${editorId}-${field}`;
  const promptLabel = imageRoot ? "Edit prompt" : selected.kind === "root" ? "Prompt (high-level description)" : "Description";
  const promptReferences = config.references.filter((reference) => reference.kind !== "audio" && !isVideoReference(reference))
    .map((reference) => ({ id: reference.id, name: reference.name, mediaTypes: referenceMediaTypes(reference), detail: referenceTypeLabel(reference), icon: <ReferenceIcon reference={reference} folderPath={folderPath} fallback={reference.kind === "image" ? <Image16 /> : <Text16 />} /> }));
  // A chip for a video or audio reference names it; one deleted says so.
  const missingReference = (id: string) => config.references.find((reference) => reference.id === id)?.name ?? "Deleted reference";
  const templateInspector = Boolean((extendMode && output && extendOptions) || (output && templateSourceId === output.id) || (runningTemplate && templateSource));
  const generateDisabled = active ? work.cancelling || work.status === "encoding" : Boolean(inputBlocked || effectsBlocked) || Boolean(templateSnapshot && output?.imageDraft) || !isTauri() || !template || !templateUsable(template) || (imageRoot ? Boolean(editingBlocked || editPlan?.error) : !imageScenePrompt(scene));
  const generateButton = <div className={`image-generation-controls${active ? "" : " image-generation-controls--split"}`}>
    <button type="button" className="primary-button image-generate-button" data-tooltip={inputBlocked ?? effectsBlocked ?? (imageRoot ? editingBlocked : null) ?? editPlan?.error ?? undefined}
      disabled={generateDisabled || (!active && !validCount)} onClick={() => {
        if (active) { attempt(() => onCancel(work.id)); return; }
        setGenerationCount("1"); setGenerationOptionsOpen(false);
        attempt(() => onGenerate(template!, count));
      }}>{active ? <Stop14 aria-hidden="true" /> : <Sparkle16 aria-hidden="true" />}{active ? work.cancelling ? "Cancelling?" : "Cancel" : count > 1 && validCount ? `Generate (${count})` : "Generate"}</button>
    {!active && <button ref={generationOptionsButton} type="button" className="primary-button image-generation-options" aria-label="Generation options"
      aria-haspopup="dialog" aria-expanded={generationOptionsOpen} data-tooltip="Generation options" disabled={generateDisabled}
      onClick={() => setGenerationOptionsOpen(!generationOptionsOpen)}><ChevronDown14 aria-hidden="true" /></button>}
    <Flyout open={generationOptionsOpen && !active} anchor={generationOptionsButton} initialFocus={generationCountInput} onClose={() => setGenerationOptionsOpen(false)} placement="top" width={240} aria-label="Generation options" className="image-generation-options-panel">
      <PropRow label="Count" tooltip="Different seeds for each image. Resets after generating." htmlFor={rootField("generation-count")}>
        <input ref={generationCountInput} id={rootField("generation-count")} className="text-field" type="number" min={1} max={MAX_IMAGE_BATCH_COUNT} step={1}
          value={generationCount} aria-invalid={!validCount} aria-describedby={!validCount ? rootField("generation-count-help") : undefined} onChange={(event) => setGenerationCount(event.target.value)} />
      </PropRow>
      <p hidden={validCount} id={rootField("generation-count-help")}>{`Enter a whole number from 1 to ${MAX_IMAGE_BATCH_COUNT}.`}</p>
    </Flyout>
  </div>;

  return <div ref={editorRoot} className="image-editor" style={{ ...treePane.style, ...inspectorPane.style }}>
    <div className="image-canvas-tools" role="toolbar" aria-label="Image tools">
      {/* The generator leads; canvas tools and view controls share the centered group. */}
      <div className="image-tools__start">
        {templateInspector && active && generateButton}
        <span className="generator-runtime image-generator">
          <span className="generator-runtime__label" aria-hidden="true">Generator:</span>
          <ComboBox
            className="generator-template"
            aria-label="Generator"
            data-tooltip={template?.name ?? "Generator"}
            value={template?.id ?? ""}
            disabled={Boolean(active) || !imageTemplates.length}
            placeholder="No image generators"
            options={imageTemplates.map((item) => ({ value: item.id, label: item.name, disabled: !templateUsable(item) || (imageRoot && !generatorModel(item.modelType).imageEditing), description: imageRoot && !generatorModel(item.modelType).imageEditing ? "Does not support editing" : !templateUsable(item) ? "Download in Settings" : undefined }))}
            onChange={(id) => { setTemplateId(id); localStorage.setItem("slopus.image-generator-template.v1", id); const next = imageTemplates.find((candidate) => candidate.id === id); if (next) commit({ ...scene, steps: next.defaultSteps }); }}
          />
        </span>
      </div>
      <div className="image-tools__center">
        {extendMode ? <span className="extend-tool-active"><Boxes16Filled aria-hidden="true" /> Zoom box</span> : <>
        <div className="image-tools__group" role="radiogroup" aria-label="Canvas tool" onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const at = TOOLS.findIndex((tool) => tool.id === drawKind);
          const next = TOOLS[(at + (event.key === "ArrowRight" ? 1 : -1) + TOOLS.length) % TOOLS.length];
          chooseTool(next.id);
          requestAnimationFrame(() => event.currentTarget.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
        }}>
          {TOOLS.map((tool) => <button
            key={tool.label} disabled={tool.id !== null && (creationBlocked || (imageRoot && Boolean(editingBlocked)))}
            type="button"
            role="radio"
            aria-checked={drawKind === tool.id}
            aria-label={tool.label}
            aria-keyshortcuts={tool.key}
            tabIndex={drawKind === tool.id ? 0 : -1}
            className={`image-tool${drawKind === tool.id ? " image-tool--on" : ""}`}
            {...tooltipProps(tool.id === "lasso" ? "Lasso: Ctrl to combine, Alt to subtract" : tool.label, tool.key)}
            onClick={() => chooseTool(tool.id)}
          ><span aria-hidden="true">{drawKind === tool.id ? tool.onIcon : tool.icon}</span></button>)}
        </div>
        <span className="image-tools__separator" role="separator" aria-orientation="vertical" />
        <button className={`image-tool${boxes ? " image-tool--on" : ""}`} aria-label="Show placement boxes" aria-pressed={boxes} data-tooltip="Show placement boxes" onClick={() => { setBoxes(!boxes); setDrawKind(null); }}>{boxes ? <Boxes16Filled aria-hidden="true" /> : <Boxes16 aria-hidden="true" />}</button>
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
        </>}
      </div>
      <div className="image-tools__end">
        <button type="button" className="secondary-button" aria-haspopup="menu" aria-expanded={templateMenu.isOpen}
          disabled={!output || (!output.relativePath && !output.sourcePath)}
          onClick={(event) => templateMenu.open(event.currentTarget, [{ label: "Character sheet", icon: <Image16 />, disabled: Boolean(referencesBlocked),
            onSelect: () => { setExtendSourceId(null); setTemplateSourceId(output!.id); },
          }, { label: "Zoom", icon: <Boxes16 />, disabled: Boolean(outpaintingBlocked) || !output?.width || !output?.height || Boolean(active),
            onSelect: () => {
              setTemplateSourceId(null); setExtendSourceId(output!.id);
              setExtendOptions({ bounds: initialExtendBounds(output!.width!, output!.height!), prompt: "", steps: template?.defaultSteps ?? 20, seed: -1 });
              setDrawKind(null); setView({ zoom: 1, x: 0, y: 0 });
            },
          }], { "aria-label": "Image templates", placement: "bottom-end" })}>
          Template <ChevronDown14 aria-hidden="true" />
        </button>
      </div>
    </div>
    {templateMenu.element}
    <aside ref={hierarchy} className="image-tree" aria-label="Image hierarchy" onContextMenu={(event) => { if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return; event.preventDefault(); setSelection(root.id); setContextMenu({ x: event.clientX, y: event.clientY }); }} onKeyDown={treeKeys}>
      {/* Undo and Redo live in the title bar; Ctrl+Z / Ctrl+Y still step the image edits here. */}
      <PaneHeader title="Scene" />
      <div role="tree" aria-label="Image nodes">{tree(root, 0)}</div>
    </aside>
    <Splitter {...treePane.splitterProps} aria-label="Resize hierarchy" />
    {contextMenu && <HierarchyContextMenu {...contextMenu} onClose={closeContextMenu} items={[
      ...(imageRoot ? [{ label: "New Edit", icon: <Edit16 />, disabled: Boolean(editingBlocked), action: () => attempt(() => add("object")) }] : [
        { label: "New Object", icon: <Cube16 />, disabled: creationBlocked, action: () => attempt(() => add("object")) },
        { label: "New Text", icon: <Text16 />, disabled: creationBlocked, action: () => attempt(() => add("text")) },
        { label: "New Group", icon: <FolderAdd16 />, disabled: creationBlocked, action: () => attempt(() => add("group")) },
        { label: "New Background", icon: <Image16 />, disabled: creationBlocked, action: () => attempt(() => add("background")) },
      ]),
      { label: "Rename", icon: <Rename16 />, shortcut: "F2", separator: true, action: startRename },
      { label: "Copy", icon: <Copy16 />, shortcut: "Ctrl+C", separator: true, disabled: selected.kind === "root", action: () => copyImageNode(scene, selected.id) },
      { label: "Paste", icon: <Paste16 />, shortcut: "Ctrl+V", disabled: creationBlocked || !clipboard, action: () => attempt(paste) },
      { label: "Duplicate", icon: <Copy16 />, shortcut: "Ctrl+D", disabled: creationBlocked || selected.kind === "root", action: () => attempt(duplicate) },
      { label: "Delete", icon: <Delete16 />, shortcut: "Delete", separator: true, danger: true, disabled: selected.kind === "root", action: removeSelected },
    ]} />}
    {imageMenu && <HierarchyContextMenu {...imageMenu} label="Generated image actions" onClose={closeImageMenu} items={[
      ...(imageMenu.source === "bar" ? [
        { label: "New empty image", icon: <Add16 />, action: () => attempt(() => {
          undo.current = []; redo.current = []; pointer.current = null; setDraftBox(null); setDraftLasso(null); setDrawKind(null); setRenaming(null); setCollapsed(new Set()); setSelection("image-root");
          onChange((current) => createEmptyImage(current, template?.id, imageMenu.inFamily ? imageMenu.id ?? current.imageScene?.outputAssetId : undefined, template?.defaultSteps));
        }) },
        { label: "Add image file", icon: <FolderOpen16 />, disabled: !isTauri(), action: () => attempt(async () => {
          const source = await invoke<ImageSource | null>("open_image_source", { folderPath });
          if (source) replaceScene({ ...createImageEditScene(source, scene), steps: template?.defaultSteps ?? 20 });
        }) },
      ] : []),
      ...(imageMenu.id ? [
        ...(imageMenu.inFamily ? [{ label: "Make Primary", icon: <Image16 />, disabled: !canUseMenuImage || imageFamilyRoot(images, imageMenu.id) === imageMenu.id,
          action: () => onChange((current) => ({ ...current, assets: makeImagePrimary(current.assets, imageMenu.id!) })) }] : []),
        { label: "Edit", icon: <Edit16 />, separator: true, disabled: Boolean(editingBlocked), action: () => attempt(() => menuImage?.imageDraft || !menuImage?.width || !menuImage?.height ? selectImage(imageMenu.id!) : replaceScene(editGeneratedImage(config, imageMenu.id!).imageScene!)) },
        { label: "Create Scene", icon: <Film16 />, separator: true, disabled: !canUseMenuImage, action: () => attempt(() => createFromImage(imageMenu.id!, true)) },
        { label: "Create Reference", icon: <References16 />, disabled: !canUseMenuImage, action: () => attempt(() => createFromImage(imageMenu.id!, false)) },
        { label: "Remove", icon: <Delete16 />, danger: true,
          separator: true,
          disabled: workItems.some((item) => isWorkActive(item) && (item.imageAssetId === imageMenu.id || item.imageDraftId === imageMenu.id || item.id === imageMenu.id)) || (!imageMenu.inFamily && imageFamily(images, imageMenu.id).length > 1),
          action: () => removeImage(imageMenu.id!) },
      ] : []),
    ]} />}
    <section className="image-center" aria-label="Image panel">
      {extendMode && output && extendOptions ? <ExtendCanvas source={output} folderPath={folderPath} bounds={extendOptions.bounds}
        onChange={(bounds) => setExtendOptions((current) => current ? { ...current, bounds } : current)} disabled={Boolean(active)} /> :
      <div ref={viewport} tabIndex={0} className={`image-viewport${panning ? " panning" : ""}`}
        onContextMenu={(event) => { event.preventDefault(); openCanvasMenu(event.clientX, event.clientY); }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault(); event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          openCanvasMenu(bounds.left, bounds.top);
        }}
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
        {active && output?.imageDraft && !(imageRoot && scene.sourceImage) ? <div className="image-empty" role="status"><Image32 aria-hidden="true" /><strong>{work.status === "queued" ? "Queued" : "Generating"}</strong><span>The generated image will appear here.</span></div> : showResult ? <ReferenceImage key={output!.id} folderPath={folderPath} relativePath={output!.relativePath} sourcePath={output!.sourcePath} alt={output!.name} /> : imageRoot && scene.sourceImage ? <ReferenceImage folderPath={folderPath} relativePath={scene.sourceImage.relativePath} alt={scene.sourceImage.name} /> : output && !imageRoot && (output.relativePath || output.sourcePath) ? <ReferenceImage key={output.id} folderPath={folderPath} relativePath={output.relativePath} sourcePath={output.sourcePath} alt={output.name} onMeasured={!output.imageGeneration ? (size) => measureImportedImage(output.id, size) : undefined} /> : <div className="image-empty"><Image32 aria-hidden="true" /><strong>{templateSnapshot ? output!.name : imageRoot ? "Add an image to edit" : "Compose your image"}</strong><span>{templateSnapshot ? active ? "The generated image will appear here." : "No generated image yet." : imageRoot ? "Choose Add image file in the image bar menu, then enter an edit prompt." : "Add objects, text and groups, then describe them in the inspector."}</span></div>}
        <svg className={`image-overlay ${drawKind ? "drawing" : ""} ${drawKind === "lasso" && lassoModifier ? `lasso-${lassoModifier}` : ""}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Image placement canvas" onPointerEnter={(event) => { if (drawKind === "lasso") updateLassoModifier(event); }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { pointer.current = null; setDraftBox(null); setDraftLasso(null); }}>
          {boxes && scene.nodes.filter((node) => node.box).map((node) => {
            const box = pointer.current?.id === node.id && draftBox ? draftBox : node.box!;
            return <g key={node.id} className={selected.id === node.id ? "selected" : ""}>{node.lasso ? <path data-node={node.id} d={imageLassoPath(node, box)} fillRule="evenodd" vectorEffect="non-scaling-stroke" /> : <rect data-node={node.id} x={box.x} y={box.y} width={box.width} height={box.height} vectorEffect="non-scaling-stroke" />}{selected.id === node.id && !node.lasso && <rect className="image-box-handle" data-node={node.id} data-resize="true" x={box.x + box.width - 16} y={box.y + box.height - 16} width="16" height="16" />}</g>;
          })}
          {draftLasso && <polygon className="image-box-draft" points={draftLasso.map(({ x, y }) => `${x},${y}`).join(" ")} fillRule="evenodd" vectorEffect="non-scaling-stroke" />}
          {draftBox && !pointer.current?.id && <rect className="image-box-draft" {...{ x: draftBox.x, y: draftBox.y, width: draftBox.width, height: draftBox.height }} />}
        </svg>
        {boxes && scene.nodes.filter((node) => node.box).map((node) => { const box = pointer.current?.id === node.id && draftBox ? draftBox : node.box!; return <span key={node.id} className="image-box-label" style={{ left: `${box.x / 10}%`, top: `${box.y / 10}%` }}>{node.name}</span>; })}
      </div></div>}
      {(error || work?.error) && <InfoBar className="image-error" severity="error" title="Couldn’t update the image" message={error ?? work?.error ?? ""} onClose={error ? () => setError(null) : undefined} />}
      <div className="image-status" role="status">{active && <ProgressBar value={work.progress * 100} aria-label="Image generation progress" />}<span>{active ? work.detail : extendMode && extendOptions ? `Zoom: ${extendSize?.width ?? "-"} \u00d7 ${extendSize?.height ?? "-"} px` : templateSnapshot ? `${templateSnapshot.kind === "extend" ? "Zoom" : "Character sheet"} · ${width} × ${height} px` : imageRoot ? editingBlocked ?? editPlan?.error ?? `${width} × ${height} · ${editPlan?.edits.length} edits in hierarchy order` : inputBlocked ?? (!isTauri() ? "Image generation is available in the desktop app." : `${width} × ${height}${isMiniMaxH3 ? "" : " · Placement boxes guide the prompt"}`)}</span></div>
      <ImageBar ref={imageResults} workItems={workItems} images={images} selectedId={scene.outputAssetId} folderPath={folderPath} onSelect={selectImage}
        onMenu={(id, x, y, inFamily) => { setContextMenu(null); setImageMenu({ id, x, y, inFamily, source: "bar" }); }} />
    </section>
    <Splitter {...inspectorPane.splitterProps} reverse aria-label="Resize inspector" />
    {extendMode && output && extendOptions ? <ExtendSettings config={config} source={output} options={extendOptions} onChange={setExtendOptions}
      onResolutionChange={(resolution) => onChange((current) => ({ ...current, imageSettings: { ...imageSettings(current), resolution } }))}
      references={promptReferences} missingLabel={missingReference} busy={Boolean(active)}
      disabledReason={outpaintingBlocked ?? (!isTauri() ? "Template execution is available in the desktop app." : !onGenerateExtend || !template || !templateUsable(template) ? "Choose a downloaded generator to execute this template." : null)}
      onExecute={() => attempt(() => onGenerateExtend?.(template!, output.id, extendOptions))} onClose={() => setExtendSourceId(null)}
    /> : output && templateSourceId === output.id ? <CharacterSheetSettings
      config={config} source={output} references={promptReferences} missingLabel={missingReference} defaultSteps={template?.defaultSteps ?? 20} busy={Boolean(active)}
      disabledReason={referencesBlocked ?? (!isTauri() ? "Template execution is available in the desktop app." : !onGenerateCharacterSheet || !template || !templateUsable(template) ? "Choose a downloaded generator to execute this template." : null)}
      onExecute={(options) => onGenerateCharacterSheet?.(template!, output.id, options)} onClose={() => setTemplateSourceId(null)}
    /> : runningTemplate && templateSource ? runningTemplate.kind === "extend" ? <ExtendSettings
      config={config} source={templateSource} options={runningTemplate} onChange={() => {}}
      references={promptReferences} missingLabel={missingReference} busy disabledReason={null}
      onExecute={() => {}} onClose={() => selectImage(templateSource.id)}
    /> : <CharacterSheetSettings key={output!.id}
      config={config} source={templateSource} initialOptions={runningTemplate} defaultSteps={runningTemplate.steps}
      references={promptReferences} missingLabel={missingReference} busy disabledReason={null}
      onExecute={() => {}} onClose={() => selectImage(templateSource.id)}
    /> : <aside className="image-inspector" aria-label="Image node inspector">
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
        meta={imageRoot ? selected.kind === "root" ? "Image" : "Edit" : selected.kind[0].toUpperCase() + selected.kind.slice(1)}
      />
      <div className="image-inspector__fields">
        {selected.kind === "root" && imageRoot && <>
          {scene.sourceImage && <p className="image-inspector__caption">{scene.sourceImage.name} · {scene.sourceImage.width} × {scene.sourceImage.height}</p>}
        </>}
        <div className="image-inspector__area"><span id={rootField("prompt-label")} tabIndex={selected.kind === "root" && imageRoot ? 0 : undefined} data-tooltip={selected.kind === "root" && imageRoot ? "Applies to the whole image before the individual edits." : undefined}>{promptLabel}</span><PromptTextField key={selected.id} aria-labelledby={rootField("prompt-label")} value={selected.description} references={promptReferences} missingLabel={missingReference} onChange={(description) => patchNode({ description })} /></div>
        {selected.kind === "text" && <PropRow label="Text to render" htmlFor={rootField("text")}><input id={rootField("text")} className="text-field" value={selected.text} onChange={(event) => patchNode({ text: event.target.value })} /></PropRow>}
        {selected.kind === "root" && <>
          {(model.negativePrompt || model.negativePromptDisabledReason) && <div className="image-inspector__area">
            <label htmlFor={rootField("negative-prompt")} tabIndex={0} data-tooltip={model.negativePromptDisabledReason ?? "Describe what to avoid. MOSS uses this with CFG; CFG 1 uses only the positive prompt."}>Negative prompt</label>
            <textarea id={rootField("negative-prompt")} className="text-field" rows={3} disabled={!model.negativePrompt}
              placeholder={model.negativePromptDisabledReason ? "Not supported by Fibo 2.0 Turbo" : undefined}
              value={scene.negativePrompts?.[template?.modelType ?? ""] ?? ""}
              onChange={(event) => { if (template) commit({ ...scene, negativePrompts: { ...scene.negativePrompts, [template.modelType]: event.target.value } }); }} />
          </div>}
          <PropSection title="Image generation" persistKey="image.generation" summary={`${generationStepsForTemplate(scene.steps, template)} steps`}>
            <PropRow label="Steps" htmlFor={rootField("steps")}><input id={rootField("steps")} className="text-field" type="number" min="2" max="1000" value={scene.steps} onChange={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 2 && value <= 1000) commit({ ...scene, steps: value }); }} /></PropRow>
            {model.cfg && template && <PropRow label="CFG" htmlFor={rootField("cfg")} tooltip="Classifier-free guidance. 1 uses only the positive prompt; higher values strengthen guidance." value={scene.cfgScales?.[template.modelType] ?? model.cfg.default} defaultValue={model.cfg.default} onReset={active ? undefined : () => commit({ ...scene, cfgScales: { ...scene.cfgScales, [template.modelType]: model.cfg!.default } })}>
              <input id={rootField("cfg")} className="text-field" type="number" min="0" max={3.4028234663852886e38} step="0.1" disabled={active} value={scene.cfgScales?.[template.modelType] ?? model.cfg.default} onChange={(event) => {
                const value = event.target.valueAsNumber;
                if (Number.isFinite(value) && value >= 0 && value <= 3.4028234663852886e38) commit({ ...scene, cfgScales: { ...scene.cfgScales, [template.modelType]: value } });
              }} />
            </PropRow>}
            <PropRow label="Seed" htmlFor={rootField("seed")} tooltip="-1 picks a random seed"><input id={rootField("seed")} className="text-field" type="number" min="-1" max={Number.MAX_SAFE_INTEGER} value={scene.seed} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= -1) commit({ ...scene, seed: value }); }} /></PropRow>
            {generatedImage && <UsedImageSeed id={rootField("used-seed")} seed={usedSeed} onError={setError} />}
            {!imageRoot && <PropRow label="Aspect ratio" htmlFor={rootField("ratio")}><ComboBox id={rootField("ratio")} aria-label="Aspect ratio" value={settings.aspectRatio} options={["16:9", "9:16", "1:1", "4:5"].map((ratio) => ({ value: ratio, label: ratio }))} onChange={(value) => { const aspectRatio = value as ProjectConfig["settings"]["aspectRatio"]; onChange((current) => ({ ...current, imageSettings: { ...imageSettings(current), aspectRatio } })); }} /></PropRow>}
            {imageRoot ? editSize && <PropRow label="Resolution" htmlFor={rootField("resolution")}><ComboBox id={rootField("resolution")} aria-label="Resolution" value={sizeValue(editSize)} options={editSizes.map((size) => ({ value: sizeValue(size), label: `${size.width} × ${size.height}` }))} onChange={(value) => { const size = editSizes.find((size) => sizeValue(size) === value); if (size) commit({ ...scene, outputSize: size }); }} /></PropRow> : <PropRow label="Resolution" htmlFor={rootField("resolution")}><ComboBox id={rootField("resolution")} aria-label="Resolution" value={settings.resolution} options={[...new Set([...PROJECT_RESOLUTIONS, settings.resolution])].map((resolution) => { const size = outputDimensions(resolution, settings.aspectRatio); return { value: resolution, label: `${size.width} × ${size.height}` }; })} onChange={(value) => { const resolution = value as ProjectConfig["settings"]["resolution"]; onChange((current) => ({ ...current, imageSettings: { ...imageSettings(current), resolution } })); }} /></PropRow>}
          </PropSection>
          {!imageRoot && <PropSection title="Style" persistKey="image.style">
            <PropRow label="Mode" htmlFor={rootField("mode")}><ComboBox id={rootField("mode")} aria-label="Mode" value={scene.style.mode} options={[{ value: "none", label: "None" }, { value: "photo", label: "Photo" }, { value: "art", label: "Art" }]} onChange={(value) => commit({ ...scene, style: { ...scene.style, mode: value as "none" | "photo" | "art" } })} /></PropRow>
            {scene.style.mode !== "none" && <>
            <TagEditor label="Aesthetics" value={scene.style.aesthetics} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoAestheticsSuggestions : styleSuggestions.ArtAestheticsSuggestions} onChange={(aesthetics) => commit({ ...scene, style: { ...scene.style, aesthetics } })} />
            <TagEditor label="Lighting" value={scene.style.lighting} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoLightingSuggestions : styleSuggestions.ArtLightingSuggestions} onChange={(lighting) => commit({ ...scene, style: { ...scene.style, lighting } })} />
            {scene.style.mode === "art" && <TagEditor label="Medium" value={scene.style.medium} suggestions={styleSuggestions.MediumSuggestions} onChange={(medium) => commit({ ...scene, style: { ...scene.style, medium } })} />}
            <TagEditor key={scene.style.mode} label={scene.style.mode === "photo" ? "Camera / lens" : "Art style"} value={scene.style.detail} suggestions={scene.style.mode === "photo" ? styleSuggestions.PhotoSuggestions : styleSuggestions.ArtSuggestions} onChange={(detail) => commit({ ...scene, style: { ...scene.style, detail } })} />
            </>}
          </PropSection>}
          <GenerationEffects key={selected.id} value={scene.generationEffects} supported={model.generationEffects} disabled={active} onChange={(generationEffects) => commit({ ...scene, generationEffects })} />
        </>}
        {!isMiniMaxH3 && selected.kind !== "root" && <PropSection title="Placement (0–1000)" persistKey="image.placement">
          <label className="image-check"><input type="checkbox" disabled={Boolean(selected.lasso)} checked={Boolean(selected.box)} onChange={(event) => patchNode({ box: event.target.checked ? { x: 250, y: 250, width: 500, height: 500 } : null })} />Explicit placement</label>
          {selected.box && (["x", "y", "width", "height"] as const).map((field) => <PropRow key={field} label={field === "x" ? "X" : field === "y" ? "Y" : field === "width" ? "Width" : "Height"} htmlFor={rootField(field)}>
            <input id={rootField(field)} className="text-field" type="number" min={field === "x" || field === "y" ? 0 : 1} max="1000" disabled={Boolean(selected.lasso) && (field === "width" || field === "height")} value={selected.box![field]} onChange={(event) => { const value = Number(event.target.value); const box = { ...selected.box!, [field]: value }; if (Number.isFinite(value) && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1000 && box.y + box.height <= 1000) commit(resizeImageNode(scene, selected.id, box)); }} />
          </PropRow>)}
        </PropSection>}
        {!isMiniMaxH3 && (!imageRoot || selected.colors.length > 0) && <PropSection title="Color palette" persistKey="image.palette">
          <div className="image-palette">{selected.colors.map((color, index) => <div key={index}><input aria-label={`Palette color ${index + 1}`} type="color" value={color} onChange={(event) => patchNode({ colors: selected.colors.map((old, i) => i === index ? event.target.value : old) })} /><button className="icon-button image-pane-button" aria-label={`Remove color ${index + 1}`} data-tooltip="Remove color" onClick={() => patchNode({ colors: selected.colors.filter((_, i) => i !== index) })}><Delete14 aria-hidden="true" /></button></div>)}<button className="secondary-button" disabled={selected.colors.length >= (selected.kind === "root" ? 16 : 5)} onClick={() => patchNode({ colors: [...selected.colors, "#808080"] })}><Add14 aria-hidden="true" />Color</button></div>
        </PropSection>}
      </div>
      <div className="inspector-actions">
        {debugEnabled && <button type="button" className="secondary-button debug-prompt__toggle" aria-haspopup="dialog" onClick={() => attempt(() => setDebugPrompt(imageRoot ? imageEditDebugPrompt(compileImageEdits(config, { modelType: template?.modelType }).edits) : compileImagePrompt(config, { modelType: template?.modelType }).prompt))}>Debug prompt</button>}
        {(!extendMode || active) && generateButton}
      </div>
    </aside>}
    {debugEnabled && debugPrompt !== null && <DebugPromptDialog sceneTitle={config.name} segments={[{ kind: "brief", value: debugPrompt }]} onClose={() => setDebugPrompt(null)} />}
  </div>;
}
