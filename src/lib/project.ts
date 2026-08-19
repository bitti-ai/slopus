import { z } from "zod";

export const PROJECT_FILE_NAME = "polstudio.json";
/** What the settings file used to be called, newest first. Both are still
 *  opened (`project_file_in` in src-tauri/src/lib.rs); only the current name is
 *  ever written. */
export const LEGACY_PROJECT_FILE_NAMES = ["pols.json", "polstudio.project.json"] as const;
export const CURRENT_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().min(1);
const isoDateSchema = z.string().datetime();

export function normalizeProjectPath(value: string): string {
  if (!value || value.includes("\0")) throw new Error("Project paths cannot be empty or contain null bytes.");
  if (/^[\\/]/.test(value) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    throw new Error("Project paths must be relative to the project root.");
  }
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) throw new Error("Project paths cannot traverse outside the project root.");
  const normalized = parts.filter((part) => part && part !== ".").join("/");
  if (!normalized) throw new Error("Project paths must point to an item below the project root.");
  return normalized;
}

export const projectRelativePathSchema = z.string().transform((value, context) => {
  try {
    return normalizeProjectPath(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid project path.",
    });
    return z.NEVER;
  }
});

/** The other kind of stored location: a file the project points at but does not
 *  contain. Video and audio are never copied into a project — a folder of
 *  rushes is tens of gigabytes — so the project records where the user already
 *  keeps them.
 *
 *  It must be ABSOLUTE, because nothing resolves it: no project root, no
 *  working directory. `..` is refused so the recorded string is the same string
 *  every comparison sees. Separators are left exactly as the OS wrote them, and
 *  all three absolute forms are accepted on every platform, because a project
 *  file written on Windows is still parsed by tests (and by a reader) on Linux.
 *
 *  Mirrors `normalize_external_path` in src-tauri/src/lib.rs. The two must
 *  agree in BOTH directions — Rust writes this file before zod ever sees it. */
export function normalizeExternalPath(value: string): string {
  if (!value || value.includes("\0")) throw new Error("External media paths cannot be empty or contain null bytes.");
  const absolute = /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
  if (!absolute) throw new Error("External media must be recorded as an absolute path.");
  if (value.split(/[\\/]/).includes("..")) throw new Error("External media paths cannot contain '..'.");
  return value;
}

export const externalPathSchema = z.string().transform((value, context) => {
  try {
    return normalizeExternalPath(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Invalid external path.",
    });
    return z.NEVER;
  }
});

/** Anything with a file behind it: inside the project, or outside it. */
export interface StoredLocation {
  relativePath?: string | null;
  sourcePath?: string | null;
}

/** Every location is one of the two and never both, so nothing downstream has
 *  to decide which wins. Shared by assets and references. */
function checkOneLocation(value: StoredLocation, context: z.RefinementCtx, label: string): void {
  if (value.relativePath && value.sourcePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["sourcePath"],
      message: `${label} cannot have both a project-relative path and an external source path.`,
    });
  }
}

export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:5"]);
export const resolutionSchema = z.enum(["720p", "1080p", "4k"]);

export const projectAssetSchema = z.object({
  id: idSchema,
  kind: z.enum(["video", "audio", "image", "caption", "generated"]),
  name: z.string().min(1),
  // Exactly one of the two. `relativePath` is a file COPIED into the project
  // folder — images, and everything generated here; `sourcePath` is a file left
  // where the user keeps it — video and audio, which are far too big to
  // duplicate. Both are `.nullish()`: Rust omits the absent one, and a project
  // written before this field existed has only `relativePath`, so both must
  // survive an absent key.
  relativePath: projectRelativePathSchema.nullish(),
  sourcePath: externalPathSchema.nullish(),
  mimeType: z.string().min(1),
  // `.nullish()`, not `.optional()`. Rust serialises a `None` as an explicit
  // JSON `null` unless the field carries skip_serializing_if, and a bare
  // `.optional()` REJECTS null — which made every desktop create/open fail.
  // Both layers are fixed; this side stays tolerant so a hand-edited file or a
  // future struct without the attribute cannot resurrect that failure.
  durationMs: z.number().int().nonnegative().nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  createdAt: isoDateSchema,
}).superRefine((asset, context) => {
  checkOneLocation(asset, context, `Asset '${asset.id}'`);
  if (!asset.relativePath && !asset.sourcePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["relativePath"],
      message: `Asset '${asset.id}' must have either a project-relative path or an external source path.`,
    });
  }
});

export const timelineClipSchema = z.object({
  id: idSchema,
  assetId: idSchema,
  trackId: idSchema,
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  sourceStartMs: z.number().int().nonnegative().default(0),
  label: z.string().min(1),
  // See the note on projectAssetSchema.durationMs — nullish, never bare optional.
  color: z.string().nullish(),
  status: z.enum(["draft", "generated", "approved"]).default("approved"),
});

export const timelineTrackSchema = z.object({
  id: idSchema,
  kind: z.enum(["video", "audio", "caption"]),
  name: z.string().min(1),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  clips: z.array(timelineClipSchema),
});

export const generationBriefSchema = z.object({
  prompt: z.string().min(1),
  status: z.enum(["draft", "queued", "generating", "ready", "failed"]),
  targetDurationSeconds: z.number().int().min(5).max(600),
  aspectRatio: aspectRatioSchema,
  resolution: resolutionSchema,
});

export const projectReferenceSchema = z.object({
  id: idSchema,
  // `video` and `audio` are file-backed like an image, but are never copied
  // into the project: only their absolute path is recorded. Nothing in the UI
  // creates one yet — both reference pickers are image-only — so this is what
  // the file format can hold, not a promise about a button.
  kind: z.enum(["text", "image", "video", "audio"]),
  name: z.string().min(1),
  // May be empty: a reference can exist before the user has described it, and
  // pre-filling it with instruction text would feed that text to the model.
  description: z.string(),
  content: z.string().min(1).nullable().optional(),
  relativePath: projectRelativePathSchema.nullable().optional(),
  // An image reference is copied into `references/`; a video or audio one is
  // pointed at where it lives. See the note on projectAssetSchema.sourcePath.
  sourcePath: externalPathSchema.nullish(),
  intendedUse: z.array(z.enum(["character", "product", "location", "style", "audio"])).default([]),
  createdAt: isoDateSchema,
}).superRefine((reference, context) => {
  checkOneLocation(reference, context, `Reference '${reference.id}'`);
  if (reference.kind !== "text" && !reference.relativePath && !reference.sourcePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["relativePath"],
      message: `A reference of kind '${reference.kind}' needs the file it refers to.`,
    });
  }
});

export const generationJobSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  prompt: z.string().min(1),
  status: z.enum(["draft", "queued", "generating", "ready", "completed", "failed", "cancelled"]),
  stage: z.enum(["queued", "preparing", "generating", "encoding", "completed", "failed"]),
  progress: z.number().min(0).max(1),
  providerId: idSchema.nullable(),
  creativeBrief: z.string().min(1),
  // Snapshot of the compiled prompt taken when the draft was created. NOT what
  // gets sent: GeneratorView.requestFor recompiles from live state at send
  // time, so this copy goes stale as soon as the brief or the bound references
  // change. Never treat it as the authoritative prompt.
  compiledPrompt: z.string().min(1),
  referenceIds: z.array(idSchema).default([]),
  // The one that broke the desktop app outright: createDraftGenerationJob never
  // sets clipId, so EVERY project has a job without it. See the note on
  // projectAssetSchema.durationMs.
  clipId: idSchema.nullish(),
  outputRelativePath: projectRelativePathSchema.nullable().optional(),
  error: z.string().min(1).nullable().optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});

export const agentMessageSchema = z.object({
  id: idSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  createdAt: isoDateSchema,
});

export const agentConversationSchema = z.object({ messages: z.array(agentMessageSchema).default([]) });
const providerOptionSchema = z.union([z.string(), z.number(), z.boolean()]);
export const providerSettingSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1).nullable(),
  options: z.record(providerOptionSchema).default({}),
});
export const providerSettingsSchema = z.record(idSchema, providerSettingSchema);

export const projectConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: idSchema,
  name: z.string().min(1).max(120),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  thumbnail: projectRelativePathSchema.nullable(),
  settings: z.object({
    aspectRatio: aspectRatioSchema,
    resolution: resolutionSchema,
    frameRate: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  brief: generationBriefSchema,
  assets: z.array(projectAssetSchema),
  timeline: z.object({ tracks: z.array(timelineTrackSchema) }),
  references: z.array(projectReferenceSchema).default([]),
  generationJobs: z.array(generationJobSchema).default([]),
  agentConversation: agentConversationSchema.default({ messages: [] }),
  providerSettings: providerSettingsSchema.default({}),
});

export type AspectRatio = z.infer<typeof aspectRatioSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type ProjectAsset = z.infer<typeof projectAssetSchema>;
export type TimelineClip = z.infer<typeof timelineClipSchema>;
export type TimelineTrack = z.infer<typeof timelineTrackSchema>;
export type GenerationBrief = z.infer<typeof generationBriefSchema>;
export type ProjectReference = z.infer<typeof projectReferenceSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentConversation = z.infer<typeof agentConversationSchema>;
export type ProviderSetting = z.infer<typeof providerSettingSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ProjectRecord { folderPath: string; config: ProjectConfig }
export interface PendingReferenceImage { sourcePath: string; name: string }
export interface CreateProjectInput {
  name: string;
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  targetDurationSeconds: number;
  parentDirectory?: string;
  referenceImages?: PendingReferenceImage[];
}

/** Absolute on-disk path for a project-relative file.
 *  The generation backend uses `reference_paths` verbatim (vidfab.rs:339 calls
 *  Path::new on each string) and enqueue_vidfab_generation is never told the
 *  project folder, so a relative path would resolve against the process working
 *  directory. Callers must resolve to absolute before sending. */
export function projectFilePath(folderPath: string, relativePath: string): string {
  const windowsStyle = folderPath.includes("\\") && !folderPath.includes("/");
  const separator = windowsStyle ? "\\" : "/";
  const root = folderPath.replace(/[\\/]+$/, "");
  return `${root}${separator}${relativePath.split(/[\\/]/).join(separator)}`;
}

/** Where an asset or reference actually is on disk, whichever kind of location
 *  it carries. The ONE place that decides: a file copied into the project
 *  resolves against the project folder, a file left outside it is already
 *  absolute and is returned untouched. Null only for a record with no file at
 *  all — a text reference.
 *
 *  Every consumer must go through this. Reading `relativePath` alone silently
 *  resolves an external clip against the project folder, which produces a path
 *  to a file that was never there. */
export function projectItemPath(folderPath: string, item: StoredLocation): string | null {
  if (item.sourcePath) return item.sourcePath;
  return item.relativePath ? projectFilePath(folderPath, item.relativePath) : null;
}

/** Whether this record's file lives outside the project folder. */
export const isExternalItem = (item: StoredLocation): boolean => Boolean(item.sourcePath);

/** The words the USER wrote about a reference, or "" — never a library label
 *  and never anything this app authored. Both import paths used to seed
 *  `description` with filing boilerplate ("Visual reference copied into this
 *  portable project."), which the compiler then handed to the model as the
 *  user's own account of the picture. Both now write an empty string, and this
 *  is the single place that decides what counts as the user's description. */
export function referenceDefinition(reference: ProjectReference): string {
  return (reference.description.trim() || reference.content?.trim() || "").trim();
}

/** Whether the user has said anything about this reference yet. An IMAGE is
 *  still usable without it — the picture itself is real payload — but it is not
 *  complete, and the UI has to say so rather than letting an empty definition
 *  look finished. */
export function isReferenceDescribed(reference: ProjectReference): boolean {
  return referenceDefinition(reference) !== "";
}

/** A reference the user has actually filled in. Blank ones are a legitimate
 *  in-progress state, but they must not take a binding slot from a real one.
 *  An image qualifies on its file alone: it can be sent to the engine and cited
 *  as <Picture N> with nothing written about it. */
export function isReferenceUsable(reference: ProjectReference): boolean {
  return reference.kind === "image"
    ? Boolean(reference.relativePath ?? reference.sourcePath)
    : isReferenceDescribed(reference);
}

/** Reference guide §2.1: `<Subject N>` is VISIBLE content. A reference tagged
 *  only "audio" is a note about sound, so compiling it into subject_definitions
 *  announced a soundtrack as something on screen ("<Subject 1> is Score idea.
 *  Sparse piano." … "The shot features <Subject 1>").
 *
 *  It is left out of the prompt rather than rerouted: base guide §4.6 wants
 *  ambience in `overall_soundscape` and §4.7 wants instrumentation, tempo and
 *  dynamics — and nothing on the reference says which the user meant, so a
 *  route would be a guess. The tag is no longer offered in the UI; this only
 *  meets references saved before that. A reference carrying any other tag, or
 *  no tag at all, is visible content as before. */
export function isVisualReference(reference: ProjectReference): boolean {
  return reference.intendedUse.length === 0 || reference.intendedUse.some((use) => use !== "audio");
}

/* ---------------------------------------------------------------------------
   MiniMax H3 prompt compilation.

   Two shapes, both defined by the official guides. Do not "simplify" them into
   one — the field names and their order are part of the contract:

   - No references  -> T2VA, three fields, `integrated_multimodal_description`
     first and no timestamp on [Shot 1].            (base guide §2.2, §4.2)
   - Any reference  -> full-reference mode, SIX sections in a fixed order, and
     `detailed_description` REPLACES the T2VA main field. (ref guide §1, §5.2)
   --------------------------------------------------------------------------- */

/** Base guide §4.1: [Shot 1] opens with the overall style. For T2VA the style is
 *  selected from the user's own text, so match on what they actually wrote and
 *  fall back to the guide's own default rather than inventing a look. */
const STYLE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bclaymation\b|\bstop[-\s]?motion\b/i, "Claymation"],
  [/\bwater[-\s]?colou?r\b/i, "Watercolor"],
  [/\b(2d|hand[-\s]?drawn|anime|cartoon)\b/i, "2D-animated"],
  [/\b(3d|cgi?|computer[-\s]?animated)\b/i, "3D CG"],
  [/\b(vintage|super\s?8|8\s?mm|16\s?mm|grainy film)\b/i, "Vintage film"],
  [/\bdocumentary\b/i, "Live-action, documentary"],
];
const DEFAULT_STYLE = "Live-action, cinematic";

export function deriveH3Style(creativeBrief: string): string {
  return STYLE_PATTERNS.find(([pattern]) => pattern.test(creativeBrief))?.[1] ?? DEFAULT_STYLE;
}

/** Base guide §4.1 spells the canonical style names with deliberate casing —
 *  `3D CG` and `2D-animated` among them — so lowercasing a style to drop it
 *  into a sentence produced "3d cg" and "2d-animated". Each style this module
 *  can produce gets an explicit mid-sentence form instead; anything not listed
 *  is returned UNCHANGED so a future style name can never be mangled. */
const MID_SENTENCE_STYLES: ReadonlyMap<string, string> = new Map([
  ["Claymation", "claymation"],
  ["Watercolor", "watercolor"],
  ["2D-animated", "2D-animated"],
  ["3D CG", "3D CG"],
  ["Vintage film", "vintage film"],
  ["Live-action, documentary", "live-action, documentary"],
  ["Live-action, cinematic", "live-action, cinematic"],
]);

function midSentenceStyle(style: string): string {
  return MID_SENTENCE_STYLES.get(style) ?? style;
}

/** The brief is the user's own text and often arrives without a final stop.
 *  Where it is interpolated ahead of another sentence, the missing stop fuses
 *  the two ("...kitchen floor <Subject 1> and <Subject 2> provide generation
 *  guidance..."). Add a period only when there is none; never touch wording. */
function endSentence(text: string): string {
  return !text || /[.!?…]$/.test(text) ? text : `${text}.`;
}

/* Base guide §4.6: `overall_soundscape` may only be N/A when the user asks for
   complete silence, so a line is always emitted instead. That line is
   deliberately CONTENT-NEUTRAL: it names no ambience, location or weather and
   only points back at what the description already established, because the
   user never told us where the scene is — the previous "Ambient room tone"
   wording put a room around a rocket launch. §4.7: music must be
   instrumentation/tempo/dynamics and never abstract mood or emotional
   function — we emit N/A because the user never asked for a score, and
   inventing one is a fabrication of its own. */
const DEFAULT_SOUNDSCAPE = "The ambient sound and physical action sounds are those the scene and actions described above naturally produce. Nothing beyond what that description already establishes is added.";
const DEFAULT_MUSIC = "N/A";

const referenceLabel = (reference: ProjectReference, index: number) => `<Subject ${index + 1}>`;

/** Image references are the only ones that can be sent to the engine as assets,
 *  so they carry the <Picture N> numbering. That numbering MUST match the order
 *  of `reference_paths` in the generation request: vidfab.rs iterates the array
 *  and calls add_reference sequentially, so index 0 is <Picture 1>.
 *
 *  The filter pair below is therefore load-bearing and must stay identical to
 *  the one `compileMiniMaxH3Prompt` applies to `usable`. GeneratorView builds
 *  `referencePaths` from this function while the prompt numbers pictures from
 *  the compiler's list; if one of them drops a reference the other keeps, every
 *  <Picture N> citation silently points at the wrong image. */
export function usableImageReferences(references: ProjectReference[]): ProjectReference[] {
  return references.filter((reference) => reference.kind === "image")
    .filter(isReferenceUsable)
    .filter(isVisualReference);
}

export function compileMiniMaxH3Prompt(creativeBrief: string, references: ProjectReference[] = []): string {
  const brief = creativeBrief.trim();
  const style = deriveH3Style(brief);
  // Same filter pair as `usableImageReferences`, in the same order — see the
  // <Picture N> / reference_paths lockstep note on that function. An
  // audio-only-tagged reference is dropped here (ref guide §2.1), so a project
  // whose only reference is audio-tagged correctly falls back to T2VA.
  const usable = references.filter(isReferenceUsable).filter(isVisualReference);

  if (usable.length === 0) {
    // T2VA — base guide §2.2 field list and order.
    return [
      `integrated_multimodal_description: [Shot 1] ${style}, ${brief}`,
      `overall_soundscape: ${DEFAULT_SOUNDSCAPE}`,
      `non_diegetic_music: ${DEFAULT_MUSIC}`,
    ].join("\n\n");
  }

  const images = usableImageReferences(references);
  const pictureNumber = new Map(images.map((reference, index) => [reference.id, index + 1]));

  // §2.2: an image that only defines a character, scene, costume or style is
  // cited INSIDE its <Subject N> definition — it never becomes a standalone
  // <Picture N> entry. This app cannot express a first/last/key frame, so no
  // standalone picture entry is ever correct here.
  // No <Audio N> is emitted either: §2.4 defines it as an actual audio asset,
  // and every reference in this app is text or image. An "audio" intendedUse
  // is a note about desired sound, not a signal to copy.
  // The identity slot carries ONLY what the user wrote. `name` is a library
  // label, not a description: for an imported image it is the source file's
  // stem, so using it here shipped "<Subject 1> is IMG_4821, shown in
  // <Picture 1>." and a retention line promising to retain "the defined
  // characteristics of IMG_4821". Neither names anything visible, and both
  // present an app-generated string to the model as the user's own words.
  // An image with no definition still belongs in the prompt — the picture is
  // real payload — so it is cited without any claim about what it contains.
  const definitions = usable.map((reference, index) => {
    const detail = endSentence(referenceDefinition(reference).replace(/\s+/g, " "));
    const picture = pictureNumber.get(reference.id);
    const label = referenceLabel(reference, index);
    if (!picture) return `${label}: ${detail}`;
    return `${label} is the content shown in <Picture ${picture}>.${detail ? ` ${detail}` : ""}`;
  });

  const labels = usable.map((reference, index) => referenceLabel(reference, index));
  const labelList = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

  // §3: task-type prefix. Every reference here provides generation guidance
  // without acting as a concrete frame or an edited source video, which is
  // exactly `reference generation`. The summary reuses existing labels only.
  const summary = `[reference generation] ${endSentence(brief)} ${labelList} ${labels.length === 1 ? "provides" : "provide"} generation guidance for the single shot described below.`;

  // §4.1: one line per label using the fixed marker vocabulary. Their defined
  // role is carried through unchanged, so fully_preserved is the honest marker.
  // §5.4: never write (Sx) in retention_analysis.
  // No `name` here either: "the defined characteristics of IMG_4821 are
  // retained" names nothing to retain. The label already points at the
  // definition above, which is where the characteristics actually live.
  const retention = usable.map((reference, index) =>
    `${referenceLabel(reference, index)} (appears in [Shot 1]): fully_preserved - the referenced characteristics are retained.`);

  // §5.2: in full-reference mode the style opening comes BEFORE [Shot 1], not
  // after it. §5.3: cite each <Subject N> where it appears in the shot.
  const detailed = [
    `The target video is in a ${midSentenceStyle(style)} style.`,
    `[Shot 1] ${endSentence(brief)} The shot features ${labelList}, matching the definitions above.`,
  ].join("\n");

  return [
    `subject_definitions:\n${definitions.join("\n")}`,
    `summary:\n${summary}`,
    `retention_analysis:\n${retention.join("\n")}`,
    `detailed_description:\n${detailed}`,
    `overall_soundscape:\n${DEFAULT_SOUNDSCAPE}`,
    `non_diegetic_music:\n${DEFAULT_MUSIC}`,
  ].join("\n\n");
}

export function createDraftGenerationJob(
  creativeBrief: string,
  options: { id?: string; title?: string; referenceIds?: string[]; references?: ProjectReference[]; now?: string } = {},
): GenerationJob {
  const brief = creativeBrief.trim();
  const now = options.now ?? new Date().toISOString();
  return generationJobSchema.parse({
    id: options.id ?? crypto.randomUUID(),
    title: options.title ?? brief.split(/\s+/).slice(0, 6).join(" "),
    prompt: brief,
    status: "draft",
    stage: "queued",
    progress: 0,
    providerId: "minimax-h3",
    creativeBrief: brief,
    // Draft-time snapshot only — it is NOT the prompt that gets sent.
    // GeneratorView.requestFor recompiles from live state at send time, so this
    // value is stale the moment the brief or the bound references change (a
    // project created with reference images keeps a T2VA snapshot here while
    // the job later holds bound image references). Do not read it as current.
    compiledPrompt: compileMiniMaxH3Prompt(brief, options.references ?? []),
    referenceIds: options.referenceIds ?? [],
    createdAt: now,
    updatedAt: now,
  });
}

/* The track a generated shot lands on: the first video track. Tracks are
   renameable, so the generator can no longer find this one by its name — an id
   survives a rename, and a project whose owner called it "Act one" must not
   grow a second track beside it the next time a shot is inserted. The id keeps
   its historical spelling so projects saved before the tracks were renamed
   still resolve to the same track. */
export const STORY_TRACK_ID = "track-story";

export function createProjectConfig(input: CreateProjectInput): ProjectConfig {
  const now = new Date().toISOString();
  const brief = input.prompt.trim();
  return projectConfigSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name: input.name.trim(),
    createdAt: now,
    updatedAt: now,
    thumbnail: null,
    settings: { aspectRatio: input.aspectRatio, resolution: input.resolution, frameRate: 30, backgroundColor: "#10131a" },
    brief: {
      prompt: brief, status: "draft", targetDurationSeconds: input.targetDurationSeconds,
      aspectRatio: input.aspectRatio, resolution: input.resolution,
    },
    assets: [],
    /* Two video layers and two audio, named the way an editor numbers them.
       The old set named the layers after a job — Overlays, Story, B-roll — which
       decided for the user what each one was for; a numbered pair says only
       where it sits, and every track stays renameable. Two of each is what a
       cut needs to work at all: something to lay over, and something to lay
       under. */
    timeline: { tracks: [
      { id: STORY_TRACK_ID, kind: "video", name: "Track 1, Video", locked: false, muted: false, clips: [] },
      { id: "track-v2", kind: "video", name: "Track 2, Video", locked: false, muted: false, clips: [] },
      { id: "track-a1", kind: "audio", name: "Track 1, Audio", locked: false, muted: false, clips: [] },
      { id: "track-a2", kind: "audio", name: "Track 2, Audio", locked: false, muted: false, clips: [] },
    ] },
    references: [],
    generationJobs: [createDraftGenerationJob(brief, { id: "job-initial-brief", title: "First scene", now })],
    agentConversation: { messages: [] }, providerSettings: {},
  });
}

const h3Prompt = (description: string, sound = "Quiet room tone.") =>
  `integrated_multimodal_description: [Shot 1] ${description}\n\noverall_soundscape: ${sound}\n\nnon_diegetic_music: N/A`;

export function seedProjectWorkspace(config: ProjectConfig, seed = 0): ProjectConfig {
  if (config.assets.length > 0 || config.timeline.tracks.some((track) => track.clips.length > 0)) return config;
  const createdAt = config.createdAt;
  const hues = seed % 2 === 0 ? ["#516fba", "#8b5d74", "#90734e"] : ["#4f7a72", "#8a654a", "#665b91"];
  const assets: ProjectAsset[] = [
    { id: "asset-establishing", kind: "generated", name: "City at blue hour", relativePath: "media/generated/scene-01.mp4", mimeType: "video/mp4", durationMs: 7200, width: 3840, height: 2160, createdAt },
    { id: "asset-studio", kind: "generated", name: "Studio details", relativePath: "media/generated/scene-02.mp4", mimeType: "video/mp4", durationMs: 8600, width: 3840, height: 2160, createdAt },
    { id: "asset-portrait", kind: "generated", name: "Architect portrait", relativePath: "media/generated/scene-03.mp4", mimeType: "video/mp4", durationMs: 7600, width: 3840, height: 2160, createdAt },
    { id: "asset-rooftop", kind: "generated", name: "Rooftop resolve", relativePath: "media/generated/scene-04.mp4", mimeType: "video/mp4", durationMs: 8400, width: 3840, height: 2160, createdAt },
    { id: "asset-score", kind: "audio", name: "Glass & concrete score", relativePath: "media/imported/score.wav", mimeType: "audio/wav", durationMs: 36000, createdAt },
    { id: "asset-voice", kind: "audio", name: "Mara voice-over", relativePath: "media/generated/voice-over.wav", mimeType: "audio/wav", durationMs: 32000, createdAt },
  ];
  const videoClips: TimelineClip[] = [
    { id: "clip-01", assetId: "asset-establishing", trackId: STORY_TRACK_ID, startMs: 0, durationMs: 7200, sourceStartMs: 0, label: "01 · A city still becoming", color: hues[0], status: "approved" },
    { id: "clip-02", assetId: "asset-studio", trackId: STORY_TRACK_ID, startMs: 7200, durationMs: 8600, sourceStartMs: 0, label: "02 · From line to light", color: hues[1], status: "approved" },
    { id: "clip-03", assetId: "asset-portrait", trackId: STORY_TRACK_ID, startMs: 15800, durationMs: 7600, sourceStartMs: 0, label: "03 · Designed for people", color: hues[2], status: "generated" },
    { id: "clip-04", assetId: "asset-rooftop", trackId: STORY_TRACK_ID, startMs: 23400, durationMs: 8400, sourceStartMs: 0, label: "04 · Northern light", color: hues[0], status: "approved" },
  ];
  const references: ProjectReference[] = [
    { id: "ref-mara", kind: "text", name: "Mara · lead architect", description: "Calm, observant woman in her late 30s. Charcoal wool, precise gestures, quiet confidence. Keep facial features and wardrobe consistent.", content: "Calm, observant woman in her late 30s. Charcoal wool, precise gestures, quiet confidence.", intendedUse: ["character"], createdAt },
    { id: "ref-building", kind: "image", name: "Harbor facade", description: "Primary material and geometry reference. Retain pale stone fins, deep window reveals, and cool northern daylight.", relativePath: "references/harbor-facade.jpg", intendedUse: ["location", "style"], createdAt },
    { id: "ref-grade", kind: "text", name: "Blue-hour grade", description: "Slate shadows, warm practicals, restrained saturation, subtle 35 mm texture. Skin tones remain natural and luminous.", content: "Slate shadows, warm practicals, restrained saturation, subtle 35 mm texture.", intendedUse: ["style"], createdAt },
  ];
  const job = (value: Omit<GenerationJob, "providerId" | "creativeBrief" | "compiledPrompt" | "updatedAt">): GenerationJob => ({
    ...value, providerId: "minimax-h3", creativeBrief: value.prompt,
    compiledPrompt: h3Prompt(value.prompt), updatedAt: value.createdAt,
  });
  const generationJobs: GenerationJob[] = [
    job({ id: "job-active", title: "Macro model details", prompt: "Slow controlled push across the scale model as morning light catches its edges.", status: "generating", stage: "generating", progress: 0.68, clipId: "clip-03", referenceIds: ["ref-building", "ref-grade"], createdAt }),
    job({ id: "job-queued", title: "Hands sketching elevation", prompt: "Overhead close shot of Mara drafting a final elevation in graphite.", status: "queued", stage: "queued", progress: 0, referenceIds: ["ref-mara", "ref-grade"], createdAt }),
    job({ id: "job-complete-1", title: "Harbor establishing shot", prompt: "Wide harbor architecture at blue hour, slow aerial drift.", status: "completed", stage: "completed", progress: 1, clipId: "clip-01", outputRelativePath: "media/generated/scene-01.mp4", referenceIds: ["ref-building", "ref-grade"], createdAt }),
    job({ id: "job-complete-2", title: "Architect at studio window", prompt: "Mara studies the skyline beside a studio window, subtle handheld movement.", status: "completed", stage: "completed", progress: 1, clipId: "clip-02", outputRelativePath: "media/generated/scene-02.mp4", referenceIds: ["ref-mara", "ref-grade"], createdAt }),
  ];
  return projectConfigSchema.parse({
    ...config,
    brief: { ...config.brief, status: "generating" },
    assets,
    timeline: { tracks: [
      { id: STORY_TRACK_ID, kind: "video", name: "Track 1, Video", locked: false, muted: false, clips: videoClips },
      { id: "track-v2", kind: "video", name: "Track 2, Video", locked: false, muted: false, clips: [] },
      { id: "track-a1", kind: "audio", name: "Track 1, Audio", locked: false, muted: false, clips: [{ id: "clip-voice", assetId: "asset-voice", trackId: "track-a1", startMs: 1800, durationMs: 28000, sourceStartMs: 0, label: "Mara · narration", color: "#3d817c", status: "approved" }] },
      { id: "track-a2", kind: "audio", name: "Track 2, Audio", locked: false, muted: false, clips: [{ id: "clip-score", assetId: "asset-score", trackId: "track-a2", startMs: 0, durationMs: 34000, sourceStartMs: 0, label: "Glass & concrete", color: "#6b5790", status: "approved" }] },
    ] },
    references,
    generationJobs,
  });
}

export function parseProjectConfig(value: unknown): ProjectConfig { return projectConfigSchema.parse(value); }

export function projectNameFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/^(create|make|generate|build|produce)\s+(me\s+)?(a|an|the)?\s*/i, "").replace(/[.!?]+$/g, "").trim();
  if (!cleaned) return "Untitled video";
  const short = cleaned.split(/\s+/).slice(0, 7).join(" ");
  return short.charAt(0).toUpperCase() + short.slice(1);
}
