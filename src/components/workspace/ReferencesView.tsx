import { Add16, Audio22, ArrowDown12, ArrowUp12, ChevronLeft16, ChevronRight16, CursorClick32, Delete14, Delete16, FolderOpen16, GridView16, GridView16Filled, ImageAdd14, ImageAdd16, Images32, ListView16, ListView16Filled, OpenExternal16, Refresh16, Refresh20, Rename16, Search16, TextFile14, TextFile16, TextFile24 } from "../ui/icons";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { isReferenceDescribed, projectItemPath, referenceImages, type ProjectConfig, type ProjectReference, type ProjectReferenceImage } from "../../lib/project";
import { activeReferenceRefmods, isVideoReference } from "../../lib/project";
import {
  composeLocationPrompt,
  composeClothingPrompt,
  clothingSelectionFromPrompt,
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
import { CLOTHING_SETTING_GROUPS, LOCATION_SETTING_GROUPS } from "../../lib/expanded-reference-options";
import { isTauri } from "../../lib/persistence";
import { useShortcut } from "../../lib/commands";
import { revealInExplorer } from "../../lib/nativeShell";
import { ReferenceImage } from "./ReferenceImage";
import { PresetIcon } from "./PresetIcon";
import { ReferenceIconGenerationDialog } from "../ReferenceIconGenerationDialog";
import { builtinIconRevision, refreshBuiltinIcons, subscribeBuiltinIcons } from "../../lib/builtinReferenceIcons";
import { builtinIconVisitAction, saveBuiltinIconChoice } from "../../lib/referenceIconSettings";
import { ReferenceVideo } from "./ReferenceVideo";
import { ReferenceAudio } from "./ReferenceAudio";
import { ProjectStatus } from "./ProjectStatus";
import { MediaThumbnail } from "./MediaThumbnail";
import { inspectReferenceVideo } from "../../lib/referenceVideo";
import { inspectReferenceAudio } from "../../lib/referenceAudio";
import { DebugPromptDialog } from "./DebugPromptDialog";
import { referenceIconPrompt } from "../../lib/referenceIcons";
import { loadDebugOptionsEnabled, subscribeDebugOptions } from "../../lib/settings";
import {
  CommandBar, CommandBarButton, CommandBarSeparator, ComboBox, ContentDialog, EmptyState, InfoBar, ItemHeader, PropRow, PropSection, SelectorBar, Splitter,
  tooltipProps, useContextMenu, usePaneSize, type MenuEntry,
} from "../ui";
import { isMenuKey } from "./SceneBoard";

/** What a reference IS, in a word. This replaced the file path in both places
 *  it used to be printed: a path is a fact about the disk, not about the
 *  reference, and neither the card nor the inspector does anything with it. */
const referenceKindLabel = (reference: ProjectReference) => {
  const count = referenceImages(reference).length;
  if (reference.refmods?.length) return `${reference.refmods.length} refmod${reference.refmods.length === 1 ? "" : "s"}`;
  if (isVideoReference(reference)) return `Video clip${count ? ` + ${count} image${count === 1 ? "" : "s"}` : ""}`;
  if (reference.kind === "video" && count === 0) return "No frames selected";
  if (count === 0) return reference.kind === "audio" ? "Sound" : "Text definition";
  return `${count} image${count === 1 ? "" : "s"}${isReferenceDescribed(reference) ? " + text" : ""}`;
};

/** The file a reference is made of, for "Show in File Explorer". */
const referenceFile = (folderPath: string, reference: ProjectReference): string | null => {
  const image = referenceImages(reference)[0];
  if (reference.kind === "video" || reference.kind === "audio") return projectItemPath(folderPath, reference);
  if (image) return projectItemPath(folderPath, image);
  const refmod = reference.refmods?.[0];
  return refmod ? projectItemPath(folderPath, refmod) : null;
};

type LibraryView = "icons" | "details";
type SortKey = "name" | "type" | "contents" | "usedBy";
const VIEW_KEY = "slopus.references.view";
const readView = (): LibraryView => {
  try { return localStorage.getItem(VIEW_KEY) === "details" ? "details" : "icons"; } catch { return "icons"; }
};

export function ReferencesView({ config, folderPath, onChange, onRegenerateIcon, onGenerateBuiltinIcons, onRegenerateBuiltinIcon, pendingBuiltinIconIds = new Set<string>(), pendingIconIds = new Set<string>(), onOpenGenerator }: {
  config: ProjectConfig;
  folderPath: string;
  /** `key` groups rapid edits of one reference into one undo step. */
  onChange: (next: ProjectConfig, key?: string) => void;
  onRegenerateIcon?: (referenceId: string) => void;
  onGenerateBuiltinIcons?: () => void;
  onRegenerateBuiltinIcon?: (presetId: string) => void;
  pendingBuiltinIconIds?: ReadonlySet<string>;
  pendingIconIds?: ReadonlySet<string>;
  onOpenGenerator?: (jobId: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(config.references[0]?.id);
  /* Ctrl/Shift multi-select. `selectedId` stays the one reference the
     inspector edits (the last one clicked); `selectedIds` is what Delete acts
     on. A plain click makes them the same single reference again. */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set(config.references[0] ? [config.references[0].id] : []));
  const anchorId = useRef<string | undefined>(selectedId);
  const [imagePage, setImagePage] = useState(0);
  useEffect(() => setImagePage(0), [selectedId]);
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
  const [pickerType, setPickerType] = useState<PresetReferenceType>("character");
  const [pickerSubcategory, setPickerSubcategory] = useState("all");
  const [presetSearch, setPresetSearch] = useState("");
  const [view, setView] = useState<LibraryView>(readView);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "name", descending: false });
  const inspectorPane = usePaneSize("references.inspector", 340, { min: 280, max: 560 });
  const root = useRef<HTMLDivElement>(null);
  const library = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const menu = useContextMenu();

  const selected = config.references.find((ref) => ref.id === selectedId);
  const selectedImages = selected ? referenceImages(selected) : [];
  const currentImagePage = Math.min(imagePage, Math.max(0, selectedImages.length - 1));
  const selectedImage = selectedImages[currentImagePage];
  const hasRefmods = Boolean(selected?.refmods?.length);
  const showImages = selectedImages.length > 0 && !hasRefmods;
  const canGenerateIcon = Boolean(selected && (hasRefmods ? activeReferenceRefmods(selected).length : selected.description.trim()));
  const selectedPreset = selected ? selectedReferencePreset(selected) : undefined;
  const selectedType = selected ? referenceType(selected) : "custom";
  const selectedSubcategory = selected?.subcategory ?? selectedPreset?.subcategory ?? "";
  const selectedLocation = useMemo(() => selected && referenceType(selected) === "location"
    ? locationSelectionFromPrompt(selected.description)
    : undefined, [selected]);
  const selectedClothing = useMemo(() => selected && referenceType(selected) === "clothing"
    ? clothingSelectionFromPrompt(selected.description)
    : undefined, [selected]);
  const selectedPresetIcon = selectedImages.length === 0 && hasPresetIcon(selectedPreset) ? selectedPreset : undefined;
  const usedBy = (id: string | undefined) => config.generationJobs.filter((job) => job.referenceIds.includes(id ?? ""));
  const jobs = useMemo(() => usedBy(selectedId), [config.generationJobs, selectedId]);
  const selection = [...selectedIds].filter((id) => config.references.some((reference) => reference.id === id));

  /* Details view order. Icons keep the project's own order. */
  const ordered = useMemo(() => {
    if (view !== "details") return config.references;
    const value = (reference: ProjectReference): string | number => {
      switch (sort.key) {
        case "name": return reference.name.toLocaleLowerCase();
        case "type": return referenceTypeLabel(referenceType(reference)).toLocaleLowerCase();
        case "contents": return referenceKindLabel(reference).toLocaleLowerCase();
        case "usedBy": return config.generationJobs.filter((job) => job.referenceIds.includes(reference.id)).length;
      }
    };
    const sorted = [...config.references].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      return typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    });
    return sort.descending ? sorted.reverse() : sorted;
  }, [config.references, config.generationJobs, view, sort]);

  const update = (id: string, patch: Partial<ProjectReference>) => {
    const current = configRef.current;
    const references = current.references.map((ref) => ref.id === id ? { ...ref, ...patch } : ref);
    const changed = references.find((ref) => ref.id === id);
    const lostImages = changed && !referenceImages(changed).length;
    onChange({ ...current, references, generationJobs: lostImages ? current.generationJobs.map((job) => ({
      ...job,
      startFrameReferenceId: job.startFrameReferenceId === id ? undefined : job.startFrameReferenceId,
      endFrameReferenceId: job.endFrameReferenceId === id ? undefined : job.endFrameReferenceId,
    })) : current.generationJobs }, `reference:${id}`);
  };
  const selectOnly = (id: string | undefined) => {
    setSelectedId(id);
    setSelectedIds(new Set(id ? [id] : []));
    anchorId.current = id;
  };
  /* Windows list selection: click selects one, Ctrl+click toggles, Shift+click
     selects the range from the anchor (Ctrl+Shift adds the range). */
  const pick = (id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey && anchorId.current) {
      const ids = ordered.map((reference) => reference.id);
      const from = ids.indexOf(anchorId.current);
      const to = ids.indexOf(id);
      if (from >= 0 && to >= 0) {
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        setSelectedIds((current) => new Set(toggle ? [...current, ...range] : range));
        setSelectedId(id);
        return;
      }
    }
    if (toggle) {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (next.has(id) && next.size > 1) next.delete(id); else next.add(id);
        return next;
      });
      setSelectedId(id);
      anchorId.current = id;
      return;
    }
    selectOnly(id);
  };
  const removeImage = () => {
    if (!selected || !selectedImage) return;
    const current = configRef.current.references.find((ref) => ref.id === selected.id);
    if (!current) return;
    if (current.video?.frames?.some((frame) => frame.id === selectedImage.id)) {
      update(current.id, { video: { ...current.video, frames: current.video.frames.filter((frame) => frame.id !== selectedImage.id) } });
      setImagePage(Math.max(0, currentImagePage - 1));
      return;
    }
    const images = referenceImages({ ...current, video: undefined }).filter((image) => image.id !== selectedImage.id);
    update(current.id, {
      images,
      // Move any remaining legacy image into attachments before clearing its path.
      ...(current.kind === "image" ? { kind: "text", relativePath: null, sourcePath: null } : {}),
    });
    setImagePage(Math.min(currentImagePage, Math.max(0, images.length - 1)));
  };
  // Starts empty on purpose. Seeding it with the instruction text meant an
  // unedited definition shipped "Describe the traits…" to the model as if the
  // user had written it. The guidance lives in the field's placeholder instead.
  const addTextReference = (name: string, description: string, type: ReferenceType, subcategory = "") => {
    const id = `ref-${crypto.randomUUID()}`;
    const reference: ProjectReference = { id, kind: "text", name, description, content: description || null, intendedUse: type === "custom" ? [] : [type], subcategory, createdAt: new Date().toISOString() };
    onChange({ ...config, references: [reference, ...config.references] });
    selectOnly(id);
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
  /** Delete references (the selection by default) and every place that points
   *  at them: scene bindings, start/end frames and the image scene. */
  const remove = (ids: readonly string[] = selection.length ? selection : selected ? [selected.id] : []) => {
    if (!ids.length) return;
    const gone = new Set(ids);
    const current = configRef.current;
    onChange({
      ...current,
      ...(current.imageScene ? { imageScene: { ...current.imageScene, referenceIds: current.imageScene.referenceIds.filter((id) => !gone.has(id)) } } : {}),
      references: current.references.filter((ref) => !gone.has(ref.id)),
      generationJobs: current.generationJobs.map((job) => ({
        ...job,
        referenceIds: job.referenceIds.filter((id) => !gone.has(id)),
        startFrameReferenceId: job.startFrameReferenceId && gone.has(job.startFrameReferenceId) ? undefined : job.startFrameReferenceId,
        endFrameReferenceId: job.endFrameReferenceId && gone.has(job.endFrameReferenceId) ? undefined : job.endFrameReferenceId,
      })),
    });
    const list = ordered.map((reference) => reference.id);
    const at = Math.min(...ids.map((id) => list.indexOf(id)).filter((index) => index >= 0));
    const remaining = list.filter((id) => !gone.has(id));
    selectOnly(remaining[Math.min(Number.isFinite(at) ? at : 0, remaining.length - 1)]);
  };
  const addFiles = async (id = selected?.id, imagesOnly = false) => {
    const chosen = configRef.current.references.find((reference) => reference.id === id);
    if (!chosen || chosen.refmods?.length || importingFiles) return;
    setImportError(null);
    if (!isTauri()) { setImportError("File import is available in the desktop app."); return; }
    setImportingFiles(true);
    try {
      const files = imagesOnly
        ? (await invoke<Array<{ name: string; relativePath: string }>>("choose_reference_images", { folderPath })).map((image) => ({ ...image, kind: "image" as const, sourcePath: null }))
        : await invoke<Array<{ kind: "image" | "video" | "audio" | "refmod"; name: string; relativePath?: string | null; sourcePath?: string | null }>>("choose_reference_files", { folderPath });
      if (!files.length) return;
      // A sound is cited as <Audio N>, never as a subject, so pictures on the
      // same reference would have nothing to belong to.
      const sound = files.find((file) => file.kind === "audio");
      if (sound && (files.length > 1 || chosen.kind === "video" || referenceImages(chosen).length)) {
        throw new Error("Add a sound to its own reference, without images or a video.");
      }
      if (chosen.kind === "audio" && !sound) throw new Error("A sound reference can’t hold images or videos. Use another reference.");
      const clip = files.find((file) => file.kind === "video");
      const video = clip ? { startSeconds: 0, ...await inspectReferenceVideo(folderPath, clip.sourcePath!) } : undefined;
      const audio = sound ? await inspectReferenceAudio(folderPath, sound.sourcePath!) : undefined;
      const current = configRef.current;
      const target = current.references.find((reference) => reference.id === chosen.id);
      if (!target) throw new Error("The reference was removed while the files were importing.");
      if (target.refmods?.length) throw new Error("Remove the refmods before adding more files.");
      if (sound) {
        update(target.id, { kind: "audio", relativePath: null, sourcePath: sound.sourcePath, audio, video: undefined, images: [] });
        return;
      }
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
  const closePicker = () => { catalogVisit.current += 1; setPresetDialog(false); };
  const visiblePresets = REFERENCE_PRESETS.filter((preset) => {
    if (preset.type !== pickerType) return false;
    if (pickerSubcategory !== "all" && preset.subcategory !== pickerSubcategory) return false;
    const query = presetSearch.trim().toLocaleLowerCase();
    return !query || `${preset.name} ${preset.prompt} ${preset.subcategory} ${preset.searchTerms ?? ""}`.toLocaleLowerCase().includes(query);
  });
  const subcategories = referenceSubcategories(pickerType);

  const rename = (id?: string) => {
    if (id) selectOnly(id);
    requestAnimationFrame(() => { nameInput.current?.focus(); nameInput.current?.select(); });
  };
  const chooseView = (next: LibraryView) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* storage unavailable */ }
  };
  const focusItem = (id: string) => requestAnimationFrame(() =>
    library.current?.querySelector<HTMLElement>(`[data-reference-id="${CSS.escape(id)}"]`)?.focus());

  /* --- Keyboard: F2 renames, Delete deletes the selection, Ctrl+A selects the
     whole library. Scoped to this screen and ignored while typing. */
  useShortcut("F2", () => { if (!selected) return false; rename(); }, { scope: root, enabled: Boolean(selected) });
  useShortcut("Delete", () => { if (!selection.length) return false; remove(); }, { scope: root, enabled: selection.length > 0 });
  useShortcut("Ctrl+A", () => { setSelectedIds(new Set(config.references.map((reference) => reference.id))); }, { scope: library, enabled: config.references.length > 0 });

  /* Arrow keys move the focus and the selection through the library (one Tab
     stop — the roving tabindex); Shift+arrows extend it. The icon grid's Up
     and Down pick the nearest tile in the next row. */
  const libraryKeys = (event: KeyboardEvent<HTMLElement>, id: string) => {
    if (isMenuKey(event)) {
      event.preventDefault();
      openMenu(event, id);
      return;
    }
    if (event.key === " " && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      pick(id, { ctrlKey: true, metaKey: false, shiftKey: false });
      return;
    }
    const ids = ordered.map((reference) => reference.id);
    const at = ids.indexOf(id);
    let next = -1;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else if (view === "icons" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) next = at + (event.key === "ArrowRight" ? 1 : -1);
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const down = event.key === "ArrowDown";
      next = at + (down ? 1 : -1);
      if (view === "icons") {
        const tiles = [...(library.current?.querySelectorAll<HTMLElement>("[data-reference-id]") ?? [])];
        const here = tiles[at]?.getBoundingClientRect();
        if (here && here.width > 0) {
          const row = tiles.map((tile, index) => ({ index, box: tile.getBoundingClientRect() }))
            .filter(({ box }) => (down ? box.top > here.top + 1 : box.top < here.top - 1));
          if (row.length) {
            const edge = down ? Math.min(...row.map(({ box }) => box.top)) : Math.max(...row.map(({ box }) => box.top));
            next = row.filter(({ box }) => box.top === edge)
              .reduce((best, candidate) => Math.abs(candidate.box.left - here.left) < Math.abs(best.box.left - here.left) ? candidate : best).index;
          } else next = at;
        }
      }
    } else return;
    event.preventDefault();
    if (next < 0 || next >= ids.length || next === at) return;
    pick(ids[next], { ctrlKey: false, metaKey: false, shiftKey: event.shiftKey });
    focusItem(ids[next]);
  };

  const referenceMenu = (reference: ProjectReference): MenuEntry[] => {
    const users = usedBy(reference.id);
    const file = referenceFile(folderPath, reference);
    const many = selection.length > 1 && selection.includes(reference.id);
    return [
      { id: "rename", label: "Rename", icon: <Rename16 />, shortcut: "F2", disabled: many, onSelect: () => rename(reference.id) },
      { id: "add-file", label: "Add file…", icon: <ImageAdd16 />, disabled: many || Boolean(reference.refmods?.length) || importingFiles, onSelect: () => { selectOnly(reference.id); void addFiles(reference.id); } },
      { id: "reveal", label: "Show in File Explorer", icon: <FolderOpen16 />, disabled: many || !file || !isTauri(), onSelect: () => { if (file) void revealInExplorer(file).catch((reason) => setImportError(String(reason))); } },
      { separator: true },
      ...(users.length
        ? users.map((job): MenuEntry => ({ id: `open-${job.id}`, label: `Open ${job.title}`, icon: <OpenExternal16 />, disabled: !onOpenGenerator, onSelect: () => onOpenGenerator?.(job.id) }))
        : [{ id: "unused", label: "Not used by any scene", disabled: true, onSelect: () => undefined } as MenuEntry]),
      { separator: true },
      { id: "delete", label: many ? `Delete ${selection.length} references` : "Delete", icon: <Delete16 />, shortcut: "Delete", danger: true, onSelect: () => remove(many ? selection : [reference.id]) },
    ];
  };
  const openMenu = (source: MouseEvent | KeyboardEvent, id: string) => {
    if (!selectedIds.has(id)) selectOnly(id);
    else setSelectedId(id);
    const reference = config.references.find((item) => item.id === id);
    if (reference) menu.open(source, referenceMenu(reference), { "aria-label": `${reference.name} actions` });
  };

  const art = (ref: ProjectReference) => {
    const images = referenceImages(ref);
    const cover = images[0];
    const matchedPreset = selectedReferencePreset(ref);
    const presetIcon = hasPresetIcon(matchedPreset) ? matchedPreset : undefined;
    return isVideoReference(ref)
      ? <span className="reference-art reference-art--photo"><MediaThumbnail
          key={JSON.stringify([folderPath, ref.sourcePath, ref.relativePath])}
          folderPath={folderPath}
          asset={{ id: ref.id, kind: "video", name: ref.name, sourcePath: ref.sourcePath, relativePath: ref.relativePath, mimeType: "video/mp4", createdAt: ref.createdAt }}
          posterTimeSeconds={0}
        /></span>
      : ref.kind === "audio"
        ? <span className="reference-art reference-art--text"><Audio22 aria-hidden="true" /></span>
      : ref.refmods?.length && ref.iconRelativePath
        ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={ref.iconRelativePath} alt={`${ref.name} icon`} /></span>
      : cover
        ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={cover.relativePath} sourcePath={cover.sourcePath} alt={cover.name} /></span>
      : ref.iconRelativePath
        ? <span className="reference-art reference-art--photo"><ReferenceImage folderPath={folderPath} relativePath={ref.iconRelativePath} alt={`${ref.name} icon`} /></span>
      : presetIcon
        ? <span className="reference-art reference-art--photo"><PresetIcon preset={presetIcon} /></span>
      : <span className="reference-art reference-art--text"><TextFile24 aria-hidden="true" /></span>;
  };

  const rovingId = selectedId && ordered.some((reference) => reference.id === selectedId) ? selectedId : ordered[0]?.id;
  const itemProps = (ref: ProjectReference) => ({
    "data-reference-id": ref.id,
    tabIndex: ref.id === rovingId ? 0 : -1,
    "aria-selected": selectedIds.has(ref.id),
    onClick: (event: MouseEvent) => pick(ref.id, event),
    onContextMenu: (event: MouseEvent) => openMenu(event, ref.id),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => libraryKeys(event, ref.id),
  });
  const sortHeader = (key: SortKey, label: string) => {
    const active = sort.key === key;
    return <th scope="col" aria-sort={active ? (sort.descending ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => setSort((current) => ({ key, descending: current.key === key ? !current.descending : false }))}>
        {label}{active && (sort.descending ? <ArrowDown12 aria-hidden="true" /> : <ArrowUp12 aria-hidden="true" />)}
      </button>
    </th>;
  };

  return <div ref={root} className="references-view" style={inspectorPane.style}>
    <main className="references-main">
      <CommandBar
        aria-label="References"
        className="references-command"
        end={<>
          <CommandBarButton icon={view === "icons" ? <GridView16Filled /> : <GridView16 />} label="Icons" pressed={view === "icons"} onClick={() => chooseView("icons")} />
          <CommandBarButton icon={view === "details" ? <ListView16Filled /> : <ListView16 />} label="Details" pressed={view === "details"} onClick={() => chooseView("details")} />
        </>}
      >
        <CommandBarButton icon={<Add16 />} label="Add reference" tooltip="Add reference" showLabel onClick={openNewReference} />
        <CommandBarButton icon={<TextFile16 />} label="Add Empty" showLabel onClick={() => addTextReference("Uncategorized", "", "custom")} />
        <CommandBarSeparator />
        <CommandBarButton icon={<ImageAdd16 />} label="Add file" showLabel disabled={!selected || importingFiles || hasRefmods || selection.length > 1} onClick={() => void addFiles()} />
        <CommandBarButton icon={<Delete16 />} label="Delete" shortcut="Delete" disabled={!selection.length} onClick={() => remove()} />
      </CommandBar>
      {importError && <InfoBar severity="error" title="Couldn’t add reference" message={importError} onClose={() => setImportError(null)} />}
      {iconError && <InfoBar severity="error" title="Couldn’t regenerate icon" message={iconError} onClose={() => setIconError(null)} />}
      <section ref={library} className="reference-library" aria-labelledby="reference-library-heading">
        <h2 className="sr-only" id="reference-library-heading">Reference library</h2>
        {config.references.length === 0
          ? <EmptyState
            icon={<Images32 />}
            title="No references yet"
            description="A reference keeps a character, a place or a look the same in every scene that uses it."
            action={<button type="button" className="secondary-button" onClick={openNewReference}>New reference</button>}
          />
          : view === "icons"
            ? <div className="reference-grid" role="listbox" aria-label="References" aria-multiselectable="true" aria-orientation="horizontal">
              {ordered.map((ref) => <div
                key={ref.id}
                role="option"
                className="reference-tile ui-selectable ui-selectable--card"
                aria-label={`${ref.name} ${referenceKindLabel(ref)}`}
                data-tooltip={isReferenceDescribed(ref) ? ref.description : `${ref.name} · not described yet`}
                {...itemProps(ref)}
              >
                {art(ref)}
                <span className="reference-tile__name">{ref.name}</span>
              </div>)}
            </div>
            : <div className="reference-details">
              <table role="grid" aria-label="References" aria-multiselectable="true">
                <thead>
                  <tr>
                    {sortHeader("name", "Name")}
                    {sortHeader("type", "Type")}
                    {sortHeader("contents", "Contents")}
                    {sortHeader("usedBy", "Used by")}
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((ref) => {
                    const users = usedBy(ref.id).length;
                    return <tr key={ref.id} className={selectedIds.has(ref.id) ? "reference-row--selected" : undefined} aria-label={`${ref.name} ${referenceKindLabel(ref)}`} {...itemProps(ref)}>
                      <td><span className="reference-row__name"><span className="reference-row__icon" aria-hidden="true">{referenceImages(ref).length || ref.kind === "video" ? <ImageAdd14 /> : <TextFile14 />}</span><span>{ref.name}</span></span></td>
                      <td>{referenceTypeLabel(referenceType(ref))}</td>
                      <td>{referenceKindLabel(ref)}</td>
                      <td>{users === 0 ? "—" : users === 1 ? "1 scene" : `${users} scenes`}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>}
      </section>
      <ProjectStatus label="References status">
        <span>{config.references.length === 1 ? "1 reference" : `${config.references.length} references`}</span>
        {selection.length > 1 && <span>{selection.length} selected</span>}
      </ProjectStatus>
      {menu.element}
    </main>

    <Splitter {...inspectorPane.splitterProps} reverse aria-label="Resize inspector" aria-controls="reference-inspector" />

    <aside id="reference-inspector" className="reference-inspector" aria-label={selected ? `Reference: ${selected.name}` : "Reference details"}>
      {/* The selected reference heads the pane: its art is the chip, its name
          is editable in place, and the meta line says what it is. */}
      {selected && <ItemHeader
        chip={art(selected)}
        name={<h2 className="reference-inspector__name"><input
            ref={nameInput}
            className="ui-item-header__input"
            value={selected.name}
            aria-label="Reference name"
            aria-keyshortcuts="F2"
            onChange={(event) => update(selected.id, { name: event.target.value || "Untitled reference" })}
          /></h2>}
        meta={[
          selectedType === "custom" ? "Uncategorized" : referenceTypeLabel(selectedType),
          referenceKindLabel(selected),
          jobs.length === 0 ? "Not used" : jobs.length === 1 ? "1 scene" : `${jobs.length} scenes`,
        ].join(" · ")}
        actions={<button className="icon-button" onClick={() => remove([selected.id])} aria-label="Delete reference" {...tooltipProps("Delete reference", "Delete")}><Delete16 aria-hidden="true" /></button>}
      />}
      <div className="reference-inspector__scroll">
        {selected ? <>
          {selected.kind === "video" && <PropSection title="Video clip" persistKey="references.video">
            <section className="reference-video" aria-label="Video reference">
              <ReferenceVideo key={`${selected.id}:${selected.sourcePath ?? selected.relativePath}`} folderPath={folderPath} reference={selected}
                onChange={(video) => update(selected.id, { video })} />
              <button className="secondary-button" onClick={() => update(selected.id, { kind: "text", sourcePath: null, relativePath: null, video: undefined, images: referenceImages(selected) })}><Delete16 aria-hidden="true" /> Remove video</button>
            </section>
          </PropSection>}
          {selected.kind === "audio" && <PropSection title="Sound clip" persistKey="references.audio">
            <section className="reference-video" aria-label="Sound reference">
              <ReferenceAudio key={`${selected.id}:${selected.sourcePath ?? selected.relativePath}`} folderPath={folderPath} reference={selected}
                onChange={(audio) => update(selected.id, { audio })} />
              <p>Needs a Ref2VA generator and an image or video reference in the same scene. Cite it in a shot to place it.</p>
              <button className="secondary-button" onClick={() => update(selected.id, { kind: "text", sourcePath: null, relativePath: null, audio: undefined })}><Delete16 aria-hidden="true" /> Remove sound</button>
            </section>
          </PropSection>}
          {/* The picture at a readable size, where the chip is only a glance:
              paging through the images, removing one. The header regenerates the icon. */}
          {((selected.kind !== "video" && selected.kind !== "audio") || showImages || hasRefmods) && <PropSection
            title="Preview"
            persistKey="references.preview"
            summary={showImages ? `${currentImagePage + 1} of ${selectedImages.length}` : undefined}
            actions={showImages ? <button
              type="button"
              className="icon-button prop-row__button"
              aria-label="Add images"
              {...tooltipProps("Add images")}
              disabled={importingFiles}
              onClick={() => void addFiles(selected.id, true)}
            ><Add16 aria-hidden="true" /></button> : onRegenerateIcon && <button
              type="button"
              className="icon-button prop-row__button"
              aria-label="Regenerate reference icon"
              data-tooltip={pendingIconIds.has(selected.id) ? "Icon generation queued or running" : canGenerateIcon ? "Regenerate reference icon" : hasRefmods ? "Enable a refmod to generate an icon" : "Add a prompt to generate an icon"}
              disabled={!canGenerateIcon || pendingIconIds.has(selected.id)}
              onClick={() => {
                setIconError(null);
                try { onRegenerateIcon(selected.id); }
                catch (reason) { setIconError(reason instanceof Error ? reason.message : String(reason)); }
              }}
            ><Refresh16 aria-hidden="true" /></button>}
          >
            <div className={`reference-detail-art${showImages || selected.iconRelativePath || (!hasRefmods && selectedPresetIcon) ? " reference-detail-art--photo" : " reference-detail-art--text"}${showImages ? " reference-detail-art--images" : (!hasRefmods && selectedPresetIcon) || selected.iconRelativePath ? " reference-detail-art--preset" : ""}`}>
              {showImages
                ? <div className="reference-detail-images"><ReferenceImage key={selectedImage.id} folderPath={folderPath} relativePath={selectedImage.relativePath} sourcePath={selectedImage.sourcePath} alt={selectedImage.name} /></div>
                : selected.iconRelativePath
                  ? <ReferenceImage className="reference-detail-preset-icon" folderPath={folderPath} relativePath={selected.iconRelativePath} alt={`${selected.name} reference icon`} />
                : !hasRefmods && selectedPresetIcon
                  ? <PresetIcon className="reference-detail-preset-icon" preset={selectedPresetIcon} alt={`${selected.name} reference icon`} />
                : <span><TextFile16 aria-hidden="true" /></span>}
              {/* A caption only where there is no picture to look at. */}
              {!showImages && !selected.iconRelativePath && (hasRefmods || !selectedPresetIcon) && <em>{referenceKindLabel(selected)}</em>}
              {showImages && <button type="button" className="reference-image-remove" aria-label="Remove reference image" {...tooltipProps(`Remove ${selectedImage.name}`)} onClick={removeImage}><Delete14 aria-hidden="true" /></button>}
            </div>
            {showImages && <div className="reference-image-controls" role="group" aria-label="Reference images">
              <button type="button" className="icon-button" aria-label="Previous reference image" data-tooltip="Previous image" disabled={currentImagePage === 0} onClick={() => setImagePage(currentImagePage - 1)}><ChevronLeft16 aria-hidden="true" /></button>
              <span aria-live="polite">Image {currentImagePage + 1} of {selectedImages.length}</span>
              <button type="button" className="icon-button" aria-label="Next reference image" data-tooltip="Next image" disabled={currentImagePage === selectedImages.length - 1} onClick={() => setImagePage(currentImagePage + 1)}><ChevronRight16 aria-hidden="true" /></button>
            </div>}
          </PropSection>}
          <PropSection title="Prompt" persistKey="references.prompt" summary={hasRefmods ? "Locked by refmods" : isReferenceDescribed(selected) ? undefined : "Not described"}>
            <div className="reference-fields">
              {/* The section header names the field on screen. */}
              <label><span className="sr-only">Prompt</span><textarea className="text-field" disabled={hasRefmods} value={selected.description} placeholder="Describe what should stay consistent — the traits, materials, colours, or wardrobe Slopus should preserve across shots." onChange={(event) => update(selected.id, { description: event.target.value, content: event.target.value || null, subcategory: selectedSubcategory })} /></label>
              {hasRefmods ? <p>Remove the refmods to edit the prompt or add files.</p>
                : !isReferenceDescribed(selected) && <p>{isVideoReference(selected)
                  ? "The clip is sent as a reference. Add a prompt to describe what to keep."
                  : selected.kind === "audio"
                    ? "The sound is sent as a reference. Describe its role, such as the voice timbre for a character."
                  : selectedImages.length > 0
                    ? "Not described yet — the picture is sent, but nothing tells the engine what to keep."
                    : "Not described yet — it won’t be used until you add a definition."}</p>}
            </div>
          </PropSection>
          {hasRefmods && <PropSection
            title="Refmods"
            persistKey="references.refmods"
            summary={selected.refmods!.length}
            actions={<button type="button" className="icon-button prop-row__button" aria-label="Remove refmods" data-tooltip="Remove all refmods" onClick={() => update(selected.id, { iconRelativePath: undefined, refmods: [] })}><Delete16 aria-hidden="true" /></button>}
          >
            <section className="reference-refmods" aria-label="Refmod attachments">
              <p>Needs a Ref2VA generator. Strength 0 turns a refmod off; more copies use more GPU memory.</p>
              {selected.refmods!.map((refmod) => <div key={refmod.id}>
                <b data-tooltip={refmod.name}>{refmod.name}</b>
                <PropRow label="Strength" htmlFor={`${refmod.id}-strength`}><input id={`${refmod.id}-strength`} className="text-field" aria-label={`${refmod.name} strength`} type="number" min={0} max={1} step={0.05} value={refmod.strength} onChange={(event) => {
                  const strength = Number(event.target.value);
                  if (event.target.value && Number.isFinite(strength) && strength >= 0 && strength <= 1) update(selected.id, { iconRelativePath: undefined, refmods: selected.refmods!.map((entry) => entry.id === refmod.id ? { ...entry, strength } : entry) });
                }} /></PropRow>
                <PropRow label="Copies" htmlFor={`${refmod.id}-copies`}><input id={`${refmod.id}-copies`} className="text-field" aria-label={`${refmod.name} copies`} type="number" min={1} max={10} step={1} value={refmod.copies} onChange={(event) => {
                  const copies = Number(event.target.value);
                  if (Number.isInteger(copies) && copies >= 1 && copies <= 10) update(selected.id, { iconRelativePath: undefined, refmods: selected.refmods!.map((entry) => entry.id === refmod.id ? { ...entry, copies } : entry) });
                }} /></PropRow>
              </div>)}
            </section>
          </PropSection>}
          {selectedLocation && <PropSection title="Location" persistKey="references.location">
            <section className="reference-location-settings" aria-label="Location settings">
              {LOCATION_SETTING_GROUPS.map((group) => <PropRow key={group.id} label={group.label}>
                <ComboBox
                  aria-label={group.label}
                  disabled={hasRefmods}
                  value={selectedLocation.settings[group.id] ?? ""}
                  options={[{ value: "", label: "None" }, ...group.options.map((option) => ({ value: option.id, label: option.label }))]}
                  onChange={(value) => {
                    const prompt = composeLocationPrompt(selectedLocation.preset, { ...selectedLocation.settings, [group.id]: value || undefined });
                    update(selected.id, { description: prompt, content: prompt });
                  }}
                />
              </PropRow>)}
            </section>
          </PropSection>}
          {selectedClothing && <PropSection title="Clothes" persistKey="references.clothing">
            <section className="reference-location-settings" aria-label="Clothing settings">
              {CLOTHING_SETTING_GROUPS.map((group) => <PropRow key={group.id} label={group.label}>
                <ComboBox
                  aria-label={group.label}
                  disabled={hasRefmods}
                  value={selectedClothing.settings[group.id] ?? ""}
                  options={[{ value: "", label: "None" }, ...group.options.map((option) => ({ value: option.id, label: option.label }))]}
                  onChange={(value) => {
                    const prompt = composeClothingPrompt(selectedClothing.preset, { ...selectedClothing.settings, [group.id]: value || undefined });
                    update(selected.id, { description: prompt, content: prompt });
                  }}
                />
              </PropRow>)}
            </section>
          </PropSection>}
          <PropSection title="Classification" persistKey="references.classification">
            <section className="reference-type" aria-label="Reference classification">
              <PropRow label="Category">
                <ComboBox
                  aria-label="Category"
                  value={selectedType}
                  options={[
                    ...(selectedType === "custom" ? [{ value: "custom", label: "Uncategorized", disabled: true }] : []),
                    ...REFERENCE_TYPES.map((type) => ({ value: type.id, label: type.label })),
                  ]}
                  onChange={(value) => update(selected.id, { intendedUse: [value as PresetReferenceType], subcategory: "" })}
                />
              </PropRow>
              {selectedType !== "custom" && <PropRow label="Subcategory">
                <ComboBox
                  aria-label="Subcategory"
                  value={selectedSubcategory}
                  options={[{ value: "", label: "None" }, ...referenceSubcategories(selectedType).map((subcategory) => ({ value: subcategory, label: subcategory }))]}
                  onChange={(value) => update(selected.id, { subcategory: value })}
                />
              </PropRow>}
            </section>
          </PropSection>
          <PropSection title="Used by" persistKey="references.used-by" summary={jobs.length}>
            <div className="reference-used-by">
              {jobs.length ? jobs.map((job) => <button type="button" key={job.id} onClick={() => onOpenGenerator?.(job.id)} data-tooltip={`Open ${job.title}`}><b>{job.title}</b><ChevronRight16 aria-hidden="true" /></button>) : <p>No scenes yet.</p>}
            </div>
          </PropSection>
        </> : <EmptyState
          icon={<CursorClick32 />}
          title="Nothing selected"
          description="Select a reference to see its details."
        />}
      </div>
      {debugEnabled && selected && <div className="debug-prompt">
        <button type="button" className="secondary-button debug-prompt__toggle" aria-haspopup="dialog" aria-expanded={showDebugIconPrompt} onClick={() => setShowDebugIconPrompt(true)}>Debug icon prompt</button>
      </div>}
    </aside>
    {debugEnabled && showDebugIconPrompt && selected && <DebugPromptDialog
      title="Debug icon prompt"
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
    {presetDialog && builtinConfirmationCount === 0 && <ContentDialog
      title="Add reference"
      className="reference-preset-dialog"
      width={920}
      primaryText="New"
      onPrimary={createEmptyReference}
      closeText="Cancel"
      onClose={closePicker}
    >
      <p className="reference-preset-dialog__lead">Choose a preset, or start a new reference and add a prompt, images or video.</p>
      <div className="reference-preset-dialog__body">
        <nav aria-label="Reference types">
          {REFERENCE_TYPES.map((type) => <button key={type.id} type="button" className={pickerType === type.id ? "active" : ""} aria-pressed={pickerType === type.id} onClick={() => { setPickerType(type.id); setPickerSubcategory("all"); setPresetSearch(""); }}>{type.label}</button>)}
        </nav>
        <section>
            <label className="reference-preset-search"><Search16 aria-hidden="true" /><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder={`Search ${referenceTypeLabel(pickerType).toLocaleLowerCase()}`} aria-label="Search reference options" /></label>
            <SelectorBar
              className="reference-subcategories"
              aria-label={`${referenceTypeLabel(pickerType)} subcategories`}
              value={pickerSubcategory}
              onChange={setPickerSubcategory}
              items={[{ value: "all", label: "All" }, ...subcategories.map((subcategory) => ({ value: subcategory, label: subcategory }))]}
            />
            <div className="reference-preset-grid">
              {visiblePresets.map((preset) => <div className="reference-preset-card" key={preset.id}>
                <button type="button" className={`reference-preset-select${hasPresetIcon(preset) || onRegenerateBuiltinIcon ? " reference-preset-card--with-icon" : ""}`} onClick={() => choosePreset(preset)}>
                  {(hasPresetIcon(preset) || onRegenerateBuiltinIcon) && <PresetIcon className="reference-preset-icon" preset={preset} />}
                  <small>{preset.subcategory}</small><b>{preset.name}</b><span>{preset.prompt}</span>
                </button>
                {onRegenerateBuiltinIcon && <button type="button" className="reference-preset-generate" aria-label={`${hasPresetIcon(preset) ? "Regenerate" : "Generate"} icon for ${preset.name}`} data-tooltip={pendingBuiltinIconIds.has(preset.id) ? "Icon generation queued or running" : `${hasPresetIcon(preset) ? "Regenerate" : "Generate"} icon`} disabled={pendingBuiltinIconIds.has(preset.id)} onClick={() => {
                  setIconError(null);
                  try { onRegenerateBuiltinIcon(preset.id); }
                  catch (reason) { setIconError(reason instanceof Error ? reason.message : String(reason)); }
                }}><Refresh20 aria-hidden="true" /></button>}
              </div>)}
              {visiblePresets.length === 0 && <p>No results for “{presetSearch.trim()}”.</p>}
            </div>
        </section>
      </div>
    </ContentDialog>}
  </div>;
}
