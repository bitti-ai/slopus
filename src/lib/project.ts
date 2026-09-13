import { z } from "zod";
import { normalizeShotTagSelection, shotTagClauses, SHOT_TAG_ID_PATTERN, type ShotTagClauses, type ShotTagSelection } from "./shot-tags";

export const PROJECT_FILE_NAME = "slopus.json";
/** What the settings file used to be called, newest first. All are still
 *  opened (`project_file_in` in src-tauri/src/lib.rs); only the current name is
 *  ever written. */
export const LEGACY_PROJECT_FILE_NAMES = ["polstudio.json", "pols.json", "polstudio.project.json"] as const;
export const CURRENT_SCHEMA_VERSION = 1 as const;
/** Project purpose, independent of the kinds of media it contains.
 * Non-video values reserve format support for future generation workflows. */
export const generationTypeSchema = z.enum(["video", "image", "3d", "music", "speech"]);
export type GenerationType = z.infer<typeof generationTypeSchema>;
export const DEFAULT_GENERATION_STEPS = 20;
/** Slopfab's native generation clock. Project frame rate is an editing/export
 * target; higher rates are produced later by interpolation and retiming. */
export const GENERATION_FRAME_RATE = 24;
export const MAX_GENERATION_STEPS = 2_147_483_647;
export const RANDOM_GENERATION_SEED = -1;

/** Languages MiniMax H3 documents as stable for dialogue generation. These are
 * suggestions, not a validator whitelist: an LLM or user may name another
 * language. Keep every label verbatim because it is written into the model's
 * required `[Language]` marker rather than translated into the UI locale. */
export const SPEECH_LANGUAGES = [
  "Arabic",
  "Chinese",
  "English",
  "French",
  "German",
  "Italian",
  "Japanese",
  "Korean",
  "Portuguese",
  "Russian",
  "Spanish",
] as const;
export const speechLanguageSchema = z.string();
export type SpeechLanguage = z.infer<typeof speechLanguageSchema>;
export const DEFAULT_SPEECH_LANGUAGE: SpeechLanguage = "English";

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

/** The frame sizes a NEW project can be created at, smallest first. Every one
 *  of them is a multiple of 32 on both edges in every aspect ratio, because
 *  that is what MiniMax H3 generates at — a frame the engine cannot produce is
 *  a frame the project would have to rescale to fill.
 *
 *  The id names the SHORT edge, the way "1080p" always has: 768p is 1376×768
 *  wide and 768×1376 tall. `outputDimensions` in export.ts holds the pixels
 *  themselves; a test pins the two lists together so neither can grow a member
 *  the other has never heard of. */
export const PROJECT_RESOLUTIONS = ["416p", "544p", "640p", "768p", "1088p", "1344p"] as const;

/** Names still on disk, from before the ladder was rebuilt on multiples of 32.
 *  They keep their exact old pixels (1080p is still 1920×1080) and they are not
 *  offered for a new project — a project is not resized behind its owner's
 *  back, and 1080 is not a multiple of 32. */
export const LEGACY_RESOLUTIONS = ["720p", "1080p", "4k"] as const;

export const resolutionSchema = z.enum([...PROJECT_RESOLUTIONS, ...LEGACY_RESOLUTIONS]);

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
  /** Whether the container has an audio stream. */
  hasAudio: z.boolean().nullish(),
  createdAt: isoDateSchema,
}).superRefine((asset, context) => {
  checkOneLocation(asset, context, `Asset '${asset.id}'`);
  /* A scene may be arranged on the timeline before it has been rendered. Its
   * generated asset is the stable thing the clip points at while the file is
   * still absent; WorkQueue fills the path in when rendering ends. */
  if (asset.kind !== "generated" && !asset.relativePath && !asset.sourcePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["relativePath"],
      message: `Asset '${asset.id}' must have either a project-relative path or an external source path.`,
    });
  }
});

export const clipTransformSchema = z.object({
  /** Percentage of the fitted source size. */
  scale: z.number().min(10).max(400),
  /** Clockwise degrees around the centre of the picture. */
  rotation: z.number().min(-180).max(180),
  /** Percentage of the output frame in either direction. */
  positionX: z.number().min(-100).max(100),
  positionY: z.number().min(-100).max(100),
});

export const clipChromaKeySchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  tolerance: z.number().min(0).max(100),
});

export const clipLookSchema = z.object({
  opacity: z.number().min(0).max(100),
  /** Cool at -100, neutral at 0, warm at +100. */
  temperature: z.number().min(-100).max(100),
});

export const clipTransitionSchema = z.object({
  type: z.enum(["cut", "fade", "wipe-left", "wipe-right"]),
  durationMs: z.number().int().min(100).max(3000),
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
  /** Optional so projects written before clip styling keep their exact shape. */
  transform: clipTransformSchema.nullish(),
  look: clipLookSchema.nullish(),
  chromaKey: clipChromaKeySchema.nullish(),
  /** Applied at this clip's head when the cut changes to it. */
  transition: clipTransitionSchema.nullish(),
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
  /* Blank is a real empty project: no brief and no seeded scene. */
  prompt: z.string(),
  status: z.enum(["draft", "queued", "generating", "ready", "failed"]),
  targetDurationSeconds: z.number().int().min(5).max(600),
  aspectRatio: aspectRatioSchema,
  resolution: resolutionSchema,
});

export const projectReferenceImageSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  relativePath: projectRelativePathSchema.nullable().optional(),
  sourcePath: externalPathSchema.nullish(),
}).superRefine((image, context) => {
  checkOneLocation(image, context, `Reference image '${image.id}'`);
  if (!image.relativePath && !image.sourcePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["relativePath"],
      message: `Reference image '${image.id}' needs the file it refers to.`,
    });
  }
});

export const projectReferenceRefmodSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  relativePath: projectRelativePathSchema.nullish(),
  sourcePath: externalPathSchema.nullish(),
  strength: z.number().finite().min(0).max(1).default(1),
  copies: z.number().int().min(1).max(10).default(1),
}).superRefine((refmod, context) => {
  checkOneLocation(refmod, context, `Refmod '${refmod.id}'`);
  if (!refmod.relativePath && !refmod.sourcePath) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourcePath"], message: "A refmod needs a file." });
});

export const projectReferenceSchema = z.object({
  id: idSchema,
  // `image` remains readable for legacy projects. New pictures live in
  // `images`, alongside a text definition rather than replacing it.
  kind: z.enum(["text", "image", "video", "audio"]),
  name: z.string().min(1),
  // May be empty: a reference can exist before the user has described it, and
  // pre-filling it with instruction text would feed that text to the model.
  description: z.string(),
  content: z.string().min(1).nullable().optional(),
  relativePath: projectRelativePathSchema.nullable().optional(),
  // Legacy file location. New image attachments carry their own locations.
  sourcePath: externalPathSchema.nullish(),
  // Pictures are attachments, not a mutually exclusive reference kind. A
  // written definition can carry any number of images, and an image-only
  // reference is simply a definition whose description is still blank.
  images: z.array(projectReferenceImageSchema).optional(),
  refmods: z.array(projectReferenceRefmodSchema).optional(),
  video: z.object({
    startSeconds: z.number().finite().min(0),
    durationSeconds: z.number().finite().min(2).max(15),
    includeAudio: z.boolean(),
  }).optional(),
  intendedUse: z.array(z.enum(["character", "animal", "product", "location", "style", "audio"])).default([]),
  subcategory: z.string().optional(),
  // Generated library artwork is not an image conditioning attachment.
  iconRelativePath: projectRelativePathSchema.optional(),
  createdAt: isoDateSchema,
}).superRefine((reference, context) => {
  checkOneLocation(reference, context, `Reference '${reference.id}'`);
  if (reference.video && reference.kind !== "video") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["video"], message: "Clip settings require a video reference." });
  }
  const imageIds = new Set<string>();
  const refmodIds = new Set<string>();
  for (const refmod of reference.refmods ?? []) {
    if (refmodIds.has(refmod.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["refmods"], message: `Duplicate refmod id '${refmod.id}'.` });
    refmodIds.add(refmod.id);
  }
  for (const image of reference.images ?? []) {
    if (imageIds.has(image.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["images"], message: `Reference '${reference.id}' has two images with the id '${image.id}'.` });
    }
    imageIds.add(image.id);
  }
  if (reference.kind !== "text" && !reference.relativePath && !reference.sourcePath) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["relativePath"],
      message: `A reference of kind '${reference.kind}' needs the file it refers to.`,
    });
  }
});

/* The tags a shot was built from. Ids only — the words they compile into live
   in src/lib/shot-tags.ts, so a term can be reworded without rewriting anyone's
   project file, and a file written by a newer build keeps ids this build has no
   term for instead of losing the user's choices on the next save.

   Both layers validate SHAPE, not vocabulary, and they validate the same shape:
   `is_shot_tag_id` in src-tauri/src/lib.rs is this regex. Were only one side to
   know the taxonomy, the other would happily persist a tag it then refused to
   read back. */
export const shotTagIdSchema = z.string().regex(SHOT_TAG_ID_PATTERN, "Shot tag ids start with a lowercase letter and carry only letters, digits, and hyphens.");
export const shotTagSelectionSchema = z.record(shotTagIdSchema, z.array(shotTagIdSchema));

/* ---------------------------------------------------------------------------
   Scenes and the shots inside them.

   A generation job IS a scene: a length between 0 and 15 seconds holding an
   ordered list of shots. Each shot owns the moment it starts, the line the user
   wrote for it, and the settings they chose for it. `[Shot N]` markers in the
   compiled prompt come out of this list in order (base guide §4.1; the cut
   timestamps on later shots are the "increasing cut timestamps" of
   docs/architecture.md).

   Every field added here is `.nullish()` and is backed by a Rust `Option` that
   carries `skip_serializing_if`, so a project written before scenes existed —
   which has none of these keys — round-trips through both validators unchanged
   and is read as a single-shot scene by `sceneShots` below.
   --------------------------------------------------------------------------- */

/** The whole range a scene may occupy. The lower bound is 0, not 1: a scene the
 *  user has emptied out is a legitimate in-progress state, and refusing to store
 *  it would mean refusing to store what they are looking at. */
export const SCENE_MAX_SECONDS = 15;
export const SCENE_MIN_SECONDS = 0;
/** What a new scene is made as, and what a project written before scenes had a
 *  length is read as — the length every shot has always been generated at. */
export const DEFAULT_SCENE_SECONDS = 6;

export const sceneShotSchema = z.object({
  id: idSchema,
  /** Optional so every project written before shots could be named keeps
   * round-tripping unchanged. The UI falls back to its numbered Shot N label. */
  name: z.string().min(1).nullish(),
  /** Seconds from the head of the scene. The first shot always starts at 0;
   *  `normalizeSceneShots` enforces that rather than trusting the file. */
  startSeconds: z.number().min(SCENE_MIN_SECONDS).max(SCENE_MAX_SECONDS),
  /** The user's own line, character for character, with reference citations
   *  held as `@[ref:<id>]` tokens (see `splitActionText`). May be empty: a shot
   *  that has just been added has nothing written in it yet, and Slopus
   *  never writes that line for anyone. */
  action: z.string(),
  /** Dialogue is separate from the visual action so the compiler can guarantee
   * that every spoken character lands inside MiniMax H3's `<d>...</d>` syntax.
   * Both fields are optional to preserve projects written before speech UI. */
  speech: z.string().nullish(),
  speechLanguage: speechLanguageSchema.nullish(),
  /** The H3 vocabulary settings on this shot: group id -> option ids. Same
   *  shape, same ids and same normalisation as the older per-job `shotTags`. */
  settings: shotTagSelectionSchema.nullish(),
});

export type SceneShot = z.infer<typeof sceneShotSchema>;

/** How a reference is cited inside a shot's action text. The id is stored, not
 *  a number or a name: a number goes stale the moment references are reordered
 *  and a name goes stale the moment one is renamed, and either would silently
 *  re-point a sentence at a different picture. What the user SEES is
 *  "Reference N" — that numbering is derived at render time from the same
 *  ordered list that numbers `<Subject N>`, so the two cannot disagree. */
export const referenceToken = (referenceId: string): string => `@[ref:${referenceId}]`;
const REFERENCE_TOKEN = /@\[ref:([^\]]+)\]/g;
/** Whether an id can survive a round trip through the token syntax. An id
 *  holding `]` could not be read back, so the editor refuses to tokenise it. */
export const canTokenizeReference = (referenceId: string): boolean => referenceId.length > 0 && !referenceId.includes("]");

export interface ActionPart {
  kind: "text" | "reference";
  /** The literal characters for `text`; the reference id for `reference`. */
  value: string;
}

/** Splits an action line into the user's characters and the references they
 *  dropped into it. Used by the compiler and by the editor's read-back strip,
 *  so what is clicked on screen and what becomes `<Subject N>` are one parse. */
export function splitActionText(action: string): ActionPart[] {
  const parts: ActionPart[] = [];
  let cursor = 0;
  for (const match of action.matchAll(REFERENCE_TOKEN)) {
    const at = match.index ?? 0;
    if (at > cursor) parts.push({ kind: "text", value: action.slice(cursor, at) });
    parts.push({ kind: "reference", value: match[1] });
    cursor = at + match[0].length;
  }
  if (cursor < action.length) parts.push({ kind: "text", value: action.slice(cursor) });
  return parts;
}

/** Every reference id cited by a line, in the order it is first cited. */
export function actionReferenceIds(action: string): string[] {
  const seen: string[] = [];
  for (const part of splitActionText(action)) {
    if (part.kind === "reference" && !seen.includes(part.value)) seen.push(part.value);
  }
  return seen;
}

export const generationJobSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  // Not `.min(1)` any more, and neither is `creativeBrief`: a scene the user has
  // emptied out has no text to mirror here, and inventing one would put words in
  // their mouth. The superRefine below still refuses a job that is empty AND has
  // no shots — the shape every project written before scenes existed has.
  prompt: z.string(),
  status: z.enum(["draft", "queued", "generating", "ready", "completed", "failed", "cancelled"]),
  stage: z.enum(["queued", "preparing", "generating", "encoding", "completed", "failed"]),
  progress: z.number().min(0).max(1),
  providerId: idSchema.nullable(),
  // For a scene this is a MIRROR of the shots' action lines joined by blank
  // lines — tokens and all — kept only so a build that predates scenes still
  // finds the user's words where it expects them. Nothing reads it once `shots`
  // is present: `compileGenerationJobSegments` compiles the shots.
  creativeBrief: z.string(),
  /** Exact render inputs from the most recently started generation. Absent on
   * drafts that have never run and on projects saved before change tracking. */
  generationSnapshot: z.string().min(1).nullish(),
  referenceIds: z.array(idSchema).default([]),
  /** An image reference used as the scene's opening frame. It is separate from
   *  subject citations because a frame is composition, not a named subject. */
  startFrameReferenceId: idSchema.nullish(),
  endFrameReferenceId: idSchema.nullish(),
  usePreviousSceneLastFrame: z.boolean().nullish(),
  // `.nullish()` because Rust holds it as an Option — see the note on
  // projectAssetSchema.durationMs. Every project written before shot tags
  // existed has no key here at all, and must keep opening.
  //
  // This is the LEGACY per-job tag set. A scene keeps its settings on each shot
  // instead; `sceneShots` hands these to the single shot a legacy job is read
  // as, and the first edit moves them there for good.
  shotTags: shotTagSelectionSchema.nullish(),
  /** The shots inside this scene, in the order they play. Absent on every
   *  project written before scenes existed — read `sceneShots(job)`, never this
   *  field, or a legacy scene comes back with no shots at all. */
  shots: z.array(sceneShotSchema).nullish(),
  /** How long the whole scene runs. Absent means the length every shot was
   *  generated at before this was settable; read `sceneDurationSeconds(job)`. */
  durationSeconds: z.number().min(SCENE_MIN_SECONDS).max(SCENE_MAX_SECONDS).nullish(),
  /** Renderer controls. Missing values belong to projects written before these
   * were exposed; the readers below give those scenes the current defaults
   * without rewriting the file just because it was opened. */
  steps: z.number().int().min(2).max(MAX_GENERATION_STEPS).nullish(),
  seed: z.number().int().min(RANDOM_GENERATION_SEED).max(Number.MAX_SAFE_INTEGER).nullish(),
  /** Base guide §4.6 and §4.7. Per-PROMPT fields, not per-shot, so they live on
   *  the scene. Blank or absent means the compiler emits its own content-neutral
   *  line; anything here is the user's own words and is marked as theirs. */
  soundscape: z.string().nullish(),
  music: z.string().nullish(),
  // The one that broke the desktop app outright: createDraftGenerationJob never
  // sets clipId, so EVERY project has a job without it. See the note on
  // projectAssetSchema.durationMs.
  clipId: idSchema.nullish(),
  outputRelativePath: projectRelativePathSchema.nullable().optional(),
  error: z.string().min(1).nullable().optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
}).superRefine((job, context) => {
  /* A job carries the user's words in ONE of two places. A scene keeps them on
     its shots; everything written before scenes existed keeps them in `prompt`
     and `creativeBrief`, which is why those two may not both be blank when
     there are no shots to hold them. `validate_and_normalize_config` in
     src-tauri/src/lib.rs applies exactly this rule — the two layers have to
     refuse the same files or Rust writes one the UI then cannot open. */
  if (job.shots && job.shots.length > 0) {
    const ids = new Set<string>();
    for (const shot of job.shots) {
      if (ids.has(shot.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["shots"], message: `Scene '${job.id}' has two shots with the id '${shot.id}'.` });
      }
      ids.add(shot.id);
    }
    return;
  }
  if (!job.prompt.trim() || !job.creativeBrief.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom, path: ["creativeBrief"],
      message: `Generation job '${job.id}' has no shots, so its prompt and creative brief cannot be empty.`,
    });
  }
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
  generationType: generationTypeSchema.default("video"),
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
  providerSettings: providerSettingsSchema.default({}),
});

export type AspectRatio = z.infer<typeof aspectRatioSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type ProjectAsset = z.infer<typeof projectAssetSchema>;
export type TimelineClip = z.infer<typeof timelineClipSchema>;
export type TimelineTrack = z.infer<typeof timelineTrackSchema>;
export type ClipTransform = z.infer<typeof clipTransformSchema>;
export type ClipLook = z.infer<typeof clipLookSchema>;
export type ClipChromaKey = z.infer<typeof clipChromaKeySchema>;
export type ClipTransition = z.infer<typeof clipTransitionSchema>;

export const DEFAULT_CLIP_TRANSFORM: ClipTransform = { scale: 100, rotation: 0, positionX: 0, positionY: 0 };
export const DEFAULT_CLIP_LOOK: ClipLook = { opacity: 100, temperature: 0 };
export const DEFAULT_CLIP_CHROMA_KEY: ClipChromaKey = { color: "#00ff00", tolerance: 20 };
export const DEFAULT_CLIP_TRANSITION: ClipTransition = { type: "cut", durationMs: 500 };

const roundTransformValue = (value: number): number => {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? 0 : rounded;
};
export const roundClipTransform = (transform: ClipTransform): ClipTransform => ({
  scale: roundTransformValue(transform.scale),
  rotation: roundTransformValue(transform.rotation),
  positionX: roundTransformValue(transform.positionX),
  positionY: roundTransformValue(transform.positionY),
});
export const clipTransform = (clip: TimelineClip): ClipTransform => roundClipTransform(clip.transform ?? DEFAULT_CLIP_TRANSFORM);
export const clipLook = (clip: TimelineClip): ClipLook => clip.look ?? DEFAULT_CLIP_LOOK;
export const clipTransition = (clip: TimelineClip): ClipTransition => clip.transition ?? DEFAULT_CLIP_TRANSITION;
export type GenerationBrief = z.infer<typeof generationBriefSchema>;
export type ProjectReferenceImage = z.infer<typeof projectReferenceImageSchema>;
export type ProjectReferenceRefmod = z.infer<typeof projectReferenceRefmodSchema>;
export type ProjectReference = z.infer<typeof projectReferenceSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;

/** Stable backing asset for a Generator scene placed on the timeline. */
export const generationAssetId = (jobId: string): string => `asset-${jobId}`;
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
  projectDirectory?: string;
  referenceImages?: PendingReferenceImage[];
}

/** Absolute on-disk path for a project-relative file.
 *  The generation backend uses `reference_paths` verbatim (slopfab.rs:339 calls
 *  Path::new on each string) and enqueue_slopfab_generation is never told the
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

/** Every picture carried by one reference. The synthesized entry keeps image
 * references written by older builds usable without rewriting their record. */
export function referenceImages(reference: ProjectReference): ProjectReferenceImage[] {
  const legacy = reference.kind === "image" && (reference.relativePath || reference.sourcePath)
    ? [{
      id: `${reference.id}-image`,
      name: reference.name,
      relativePath: reference.relativePath ?? null,
      sourcePath: reference.sourcePath ?? null,
    }]
    : [];
  return [...legacy, ...(reference.images ?? [])];
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
  return referenceImages(reference).length > 0 || (reference.kind === "video" && Boolean(reference.sourcePath || reference.relativePath)) || activeReferenceRefmods(reference).length > 0 || isReferenceDescribed(reference);
}

export const activeReferenceRefmods = (reference: ProjectReference): ProjectReferenceRefmod[] =>
  (reference.refmods ?? []).filter((refmod) => refmod.strength > 0);

/** Refmods follow ordinary references, in attachment order. They never consume
 * Picture/Video labels or run a reference encoder. */
export const referenceRefmodInputs = (folderPath: string, references: ProjectReference[]) =>
  references.flatMap(activeReferenceRefmods).map((refmod) => ({
    path: projectItemPath(folderPath, refmod)!, strength: refmod.strength, copies: refmod.copies,
  }));

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
  return reference.kind === "video" || reference.intendedUse.length === 0 || reference.intendedUse.some((use) => use !== "audio");
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

/** Image references carry the <Picture N> numbering, independently of videos.
 *  That numbering MUST match the order
 *  of `reference_paths` in the generation request: slopfab.rs iterates the array
 *  and calls add_reference sequentially, so index 0 is <Picture 1>.
 *
 *  The filter pair below is therefore load-bearing and must stay identical to
 *  the one `compileMiniMaxH3Prompt` applies to `usable`. GeneratorView builds
 *  `referencePaths` from this function while the prompt numbers pictures from
 *  the compiler's list; if one of them drops a reference the other keeps, every
 *  <Picture N> citation silently points at the wrong image. */
export function usableImageReferences(references: ProjectReference[]): ProjectReference[] {
  return references.filter((reference) => referenceImages(reference).length > 0)
    .filter(isReferenceUsable)
    .filter(isVisualReference);
}

/** Image payloads in exactly the order SlopFab receives them. Multiple images
 * on one reference stay adjacent and share that reference's subject. */
export function usableReferenceImages(references: ProjectReference[]): ProjectReferenceImage[] {
  return usableImageReferences(references).flatMap(referenceImages);
}

/** Video numbering is independent of pictures and follows native insertion order. */
export function usableVideoReferences(references: ProjectReference[]): ProjectReference[] {
  return references.filter((reference) => reference.kind === "video" && Boolean(reference.sourcePath || reference.relativePath)).filter(isVisualReference);
}

/** Opening and closing pictures come first, then bound references in project
 * order. Frame anchors use their first image, even on a multi-image reference;
 * the same anchor selected for both ends is sent only once. */
export function sceneGenerationReferences(job: GenerationJob, references: ProjectReference[]): ProjectReference[] {
  const start = references.find((reference) => reference.id === job.startFrameReferenceId && referenceImages(reference).length > 0 && isReferenceUsable(reference));
  const end = references.find((reference) => reference.id === job.endFrameReferenceId && referenceImages(reference).length > 0 && isReferenceUsable(reference));
  const anchors = [start, end].filter((reference, index, all): reference is ProjectReference => Boolean(reference) && all.indexOf(reference) === index)
    .map((reference) => ({ ...reference, kind: "text" as const, relativePath: null, sourcePath: null, intendedUse: [], images: referenceImages(reference).slice(0, 1) }));
  return [...anchors, ...references.filter((reference) => job.referenceIds.includes(reference.id) && !anchors.some((anchor) => anchor.id === reference.id))];
}

/** Resolve the adjacent scene when preparing a request; queued work captures
 * its id so subsequent board edits cannot change the source of that run. */
export function sceneFrameInputs(job: GenerationJob, config: ProjectConfig) {
  if (!job.usePreviousSceneLastFrame) return { job, references: sceneGenerationReferences(job, config.references) };
  const previous = config.generationJobs[config.generationJobs.findIndex((candidate) => candidate.id === job.id) - 1];
  const id = `previous-frame-${job.id}`;
  const resolved = { ...job, startFrameReferenceId: id };
  const reference: ProjectReference = {
    id, kind: "image", name: "Previous scene's last frame", description: "", intendedUse: [], createdAt: job.createdAt,
    relativePath: previous?.outputRelativePath ? sceneLastFramePath(previous.outputRelativePath) : `cache/scene-last/pending-${job.id}.png`,
  };
  return { job: resolved, references: sceneGenerationReferences(resolved, [reference, ...config.references]), previousSceneId: previous?.id };
}

export function sceneLastFramePath(outputRelativePath: string): string {
  const stem = outputRelativePath.replaceAll("\\", "/").split("/").pop()!.replace(/\.[^.]+$/, "");
  return `cache/scene-last/${stem}.png`;
}

/* Who wrote each piece of the compiled prompt.

   - "brief" is the user's own prose, character for character.
   - "tag"   is a term they picked from the H3 vocabulary in shot-tags.ts.
   - "frame" is everything Slopus adds: field names, the [Shot N] marker,
     punctuation it inserted, and the two default sound lines.

   The preview in the generator renders these, and `compileMiniMaxH3Prompt` is
   nothing but their values concatenated — so what the user is shown cannot
   drift from what is sent, and their words stay visibly theirs. */
export type PromptSegmentKind = "frame" | "brief" | "tag";
export interface PromptSegment { kind: PromptSegmentKind; value: string }

const frame = (value: string): PromptSegment => ({ kind: "frame", value });
const own = (value: string): PromptSegment => ({ kind: "brief", value });
const tagged = (value: string): PromptSegment => ({ kind: "tag", value });

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

/** The stop `endSentence` would add, as its own segment — it is punctuation
 *  Slopus inserted, not something the user typed. */
const addedStop = (text: string): PromptSegment[] => (endSentence(text) === text ? [] : [frame(".")]);

/** One scene, as the compiler needs it. Deliberately not a `GenerationJob`:
 *  the shot being written in the editor is not a job yet, and the preview has
 *  to show the same bytes for both. */
export interface ScenePrompt {
  shots: readonly SceneShot[];
  startFrameReferenceId?: string | null;
  endFrameReferenceId?: string | null;
  /** Base guide §4.6 / §4.7. Blank or absent falls back to the two default
   *  lines below, which are marked as Slopus's own writing. */
  soundscape?: string | null;
  music?: string | null;
}

/** The shots of a scene, in playing order, with the first one pinned to 0.
 *  Order comes from the START TIMES, not from the array, so the `[Shot N]`
 *  markers and their cut timestamps can never disagree — the guide requires
 *  later shots to carry increasing timestamps (docs/architecture.md). */
export function normalizeSceneShots(shots: readonly SceneShot[]): SceneShot[] {
  const ordered = [...shots].sort((left, right) => left.startSeconds - right.startSeconds);
  return ordered.map((shot, index) => (index === 0 && shot.startSeconds !== 0 ? { ...shot, startSeconds: 0 } : shot));
}

/** A cut timestamp, in the shortest form that is still exact. */
export function formatSceneSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** The shots of a job, whatever era the file is from. A job written before
 *  scenes existed becomes ONE shot holding the words and tags it already had —
 *  no words are added and none are dropped. */
export function sceneShots(job: GenerationJob): SceneShot[] {
  if (job.shots && job.shots.length > 0) return normalizeSceneShots(job.shots);
  return [{ id: `${job.id}-shot-1`, startSeconds: 0, action: job.creativeBrief.trim(), settings: job.shotTags ?? null }];
}

/** How long this scene runs. A job written before the length was settable is
 *  read as the length its shot was always generated at. */
export function sceneDurationSeconds(job: GenerationJob): number {
  const stored = job.durationSeconds;
  if (stored === null || stored === undefined) return DEFAULT_SCENE_SECONDS;
  return Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, stored));
}

export function sceneGenerationSteps(job: GenerationJob, fallback = DEFAULT_GENERATION_STEPS): number {
  return job.steps ?? fallback;
}

export function sceneGenerationSeed(job: GenerationJob): number {
  return job.seed ?? RANDOM_GENERATION_SEED;
}

export interface SceneGenerationInput {
  prompt: string;
  frames: number;
  steps: number;
  seed: number;
  canvasWidth: number;
  canvasHeight: number;
  referencePaths: readonly string[];
  referenceVideos?: readonly { name: string; relativePath?: string | null; sourcePath?: string | null; startSeconds: number; durationSeconds?: number; includeAudio: boolean }[];
  refmods?: readonly { path: string; strength: number; copies: number }[];
  previousSceneId?: string;
}

/** A stable record of everything sent to the renderer. Shot ids are retained
 * separately because swapping otherwise identical shots is still an edit. */
export function sceneGenerationSnapshot(job: GenerationJob, input: SceneGenerationInput): string {
  const shots = sceneShots(job).map((shot) => ({
    id: shot.id,
    settings: Object.entries(shot.settings ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, values]) => [group, [...values].sort()]),
  }));
  return JSON.stringify({
    prompt: input.prompt,
    frames: input.frames,
    steps: input.steps,
    seed: input.seed,
    canvasWidth: input.canvasWidth,
    canvasHeight: input.canvasHeight,
    referencePaths: input.referencePaths,
    ...(input.referenceVideos?.length ? { referenceVideos: input.referenceVideos } : {}),
    ...(input.refmods?.length ? { refmods: input.refmods } : {}),
    ...(input.previousSceneId ? { previousSceneId: input.previousSceneId } : {}),
    shots,
  });
}

/** The mirror written back into `prompt` and `creativeBrief`. Nothing but the
 *  user's own lines, joined — no connective words, no summary. */
export function sceneBriefText(shots: readonly SceneShot[]): string {
  return normalizeSceneShots(shots).map((shot) => shot.action.trim()).filter((line) => line.length > 0).join("\n\n");
}

export function compileMiniMaxH3Prompt(
  creativeBrief: string,
  references: ProjectReference[] = [],
  shotTags: ShotTagSelection | null = null,
): string {
  return compileMiniMaxH3PromptSegments(creativeBrief, references, shotTags).map((segment) => segment.value).join("");
}

/** One line of prose as a single shot. Every caller that has words rather than
 *  a scene — the demo agent, a draft being typed, every project made before
 *  scenes existed — comes through here, so a one-shot scene compiles to exactly
 *  the bytes this function has always produced. */
export function compileMiniMaxH3PromptSegments(
  creativeBrief: string,
  references: ProjectReference[] = [],
  shotTags: ShotTagSelection | null = null,
): PromptSegment[] {
  return compileScenePromptSegments(
    { shots: [{ id: "shot-1", startSeconds: 0, action: creativeBrief, settings: shotTags }] },
    references,
  );
}

export function compileGenerationJobSegments(job: GenerationJob, references: ProjectReference[] = []): PromptSegment[] {
  return compileScenePromptSegments({ shots: sceneShots(job), startFrameReferenceId: job.startFrameReferenceId, endFrameReferenceId: job.endFrameReferenceId, soundscape: job.soundscape, music: job.music }, references);
}

export function compileGenerationJobPrompt(job: GenerationJob, references: ProjectReference[] = []): string {
  return compileGenerationJobSegments(job, references).map((segment) => segment.value).join("");
}

/** What one shot contributes, already split by who wrote it. */
interface CompiledShot {
  index: number;
  startSeconds: number;
  /** The action line: the user's characters, with each reference token turned
   *  into the `<Subject N>` citation Slopus inserts. */
  body: PromptSegment[];
  /** The same thing as a plain string, for deciding whether a stop is needed. */
  text: string;
  /** Reference ids this shot cites, first citation first. */
  citedIds: string[];
  tags: ShotTagClauses;
  speech: string | null;
  speechLanguage: SpeechLanguage;
}

export function compileScenePromptSegments(scene: ScenePrompt, references: ProjectReference[] = []): PromptSegment[] {
  const shots = normalizeSceneShots(scene.shots.length > 0 ? scene.shots : [{ id: "shot-1", startSeconds: 0, action: "", settings: null }]);
  // Same filter pair as `usableImageReferences`, in the same order — see the
  // <Picture N> / reference_paths lockstep note on that function. An
  // audio-only-tagged reference is dropped here (ref guide §2.1), so a scene
  // whose only reference is audio-tagged correctly falls back to T2VA.
  const startFrame = references.find((reference) => reference.id === scene.startFrameReferenceId && referenceImages(reference).length > 0 && isReferenceUsable(reference)) ?? null;
  const endFrame = references.find((reference) => reference.id === scene.endFrameReferenceId && referenceImages(reference).length > 0 && isReferenceUsable(reference)) ?? null;
  const usable = references.filter(isReferenceUsable).filter(isVisualReference).filter((reference) => reference.id !== startFrame?.id && reference.id !== endFrame?.id);
  const subjectNumber = new Map(usable.map((reference, index) => [reference.id, index + 1]));

  const compiled: CompiledShot[] = shots.map((shot, index) => {
    const body: PromptSegment[] = [];
    const citedIds: string[] = [];
    let text = "";
    for (const part of splitActionText(shot.action.trim())) {
      if (part.kind === "text") {
        body.push(own(part.value));
        text += part.value;
        continue;
      }
      // A token whose reference is gone, undescribed or tagged as sound only
      // has no <Subject N> to become. It is left out rather than guessed at,
      // and the editor says so in words above the field — see `danglingTokens`.
      const number = subjectNumber.get(part.value);
      if (!number) continue;
      if (!citedIds.includes(part.value)) citedIds.push(part.value);
      body.push(frame(`<Subject ${number}>`));
      text += `<Subject ${number}>`;
    }
    return {
      index,
      startSeconds: shot.startSeconds,
      body,
      text,
      citedIds,
      tags: shotTagClauses(shot.settings ?? null),
      speech: shot.speech?.trim().length ? shot.speech : null,
      speechLanguage: shot.speechLanguage ?? DEFAULT_SPEECH_LANGUAGE,
    };
  });

  // §4.1: the description opens with ONE overall style, so the first shot that
  // carries one sets it for the scene — the picker marks that setting scene-wide
  // for the same reason. Without one, the guess from the user's own words
  // stands and is marked as Slopus's doing.
  const styleFromTag = compiled.map((shot) => shot.tags.style).find((style) => Boolean(style)) ?? null;
  const style = styleFromTag ?? deriveH3Style(compiled.map((shot) => shot.text).join(" "));
  const styleSegment = styleFromTag ? tagged(style) : frame(style);

  /** The `[Shot N]` marker. Shot 1 never carries a timestamp (base guide §4.2);
   *  every later shot carries the cut it starts on (docs/architecture.md). */
  const marker = (shot: CompiledShot): string =>
    shot.index === 0 ? "[Shot 1] " : `[Shot ${shot.index + 1}] (cut at ${formatSceneSeconds(shot.startSeconds)}s) `;

  // Sentences the settings contribute after the description. The field name is
  // Slopus's, the terms inside it are the user's — hence three segments per
  // clause rather than one pre-joined sentence nobody could attribute.
  const tail = (shot: CompiledShot): PromptSegment[] => shot.tags.clauses.flatMap((clause) => [
    frame(` ${clause.label}: `),
    tagged(clause.terms.join(", ")),
    frame("."),
  ]);
  /** Base guide dialogue syntax: identifying phrase and stable speaker id stay
   * outside `<d>`, while only the language marker and the user's exact text are
   * inside. One scene-level speech track means the same (S1) voice is retained
   * across its shots. The pieces stay split so prompt provenance remains honest. */
  const dialogue = (shot: CompiledShot, separate: boolean): PromptSegment[] => shot.speech === null ? [] : [
    frame(`${separate ? " " : ""}The scene's speaker (S1) says, <d>[`),
    tagged(shot.speechLanguage),
    frame("] "),
    own(shot.speech),
    frame("</d>"),
  ];
  /* A stop is added when something follows the line — another clause, or
     another shot. A lone untagged shot keeps whatever terminal punctuation the
     user gave it, so every prompt this app has ever produced is unchanged. */
  const stop = (shot: CompiledShot): PromptSegment[] =>
    shot.tags.clauses.length > 0 || shot.speech !== null || shot.index < compiled.length - 1 ? addedStop(shot.text) : [];

  const sound = (scene.soundscape ?? "").trim();
  const music = (scene.music ?? "").trim();
  const soundSegment = sound ? own(sound) : frame(DEFAULT_SOUNDSCAPE);
  const musicSegment = music ? own(music) : frame(DEFAULT_MUSIC);

  if (usable.length === 0 && !startFrame && !endFrame) {
    // T2VA — base guide §2.2 field list and order.
    return [
      frame("integrated_multimodal_description: "),
      ...compiled.flatMap((shot) => [
        frame(shot.index === 0 ? marker(shot) : ` ${marker(shot)}`),
        ...(shot.index === 0 ? [styleSegment, frame(", ")] : []),
        // §4.1 order inside the shot: size, angle and lens sit in front of the
        // subject and its action.
        ...(shot.tags.framing.length > 0 ? [tagged(shot.tags.framing.join(", ")), frame(", ")] : []),
        ...shot.body,
        ...stop(shot),
        ...tail(shot),
        ...dialogue(shot, shot.text.length > 0 || shot.tags.clauses.length > 0),
      ]),
      frame("\n\noverall_soundscape: "),
      soundSegment,
      frame("\n\nnon_diegetic_music: "),
      musicSegment,
    ].filter((segment) => segment.value.length > 0);
  }

  const imageReferenceIds = usableImageReferences(references).flatMap((reference) =>
    referenceImages(reference).map(() => reference.id));
  const pictureNumbers = new Map<string, number[]>();
  const videoNumbers = new Map(usableVideoReferences(references).map((reference, index) => [reference.id, index + 1]));
  imageReferenceIds.forEach((referenceId, index) => pictureNumbers.set(referenceId, [...(pictureNumbers.get(referenceId) ?? []), index + 1]));
  const listOf = (values: string[]): string => values.length === 1
    ? values[0]
    : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;

  // §2.2: an image that only defines a character, scene, costume or style is
  // cited INSIDE its <Subject N> definition. A scene's explicit first frame is
  // the exception: it describes composition, so it is emitted as a standalone
  // <Picture N> entry instead of pretending to be a subject.
  // Video citations follow their own native insertion order. An "audio"
  // intendedUse remains a legacy text tag, not a standalone audio attachment.
  // The identity slot carries ONLY what the user wrote. `name` is a library
  // label, not a description: for an imported image it is the source file's
  // stem, so using it here shipped "<Subject 1> is IMG_4821, shown in
  // <Picture 1>." and a retention line promising to retain "the defined
  // characteristics of IMG_4821". Neither names anything visible, and both
  // present an app-generated string to the model as the user's own words.
  // An image with no definition still belongs in the prompt — the picture is
  // real payload — so it is cited without any claim about what it contains.
  const definitions = usable.flatMap((reference, index): PromptSegment[] => {
    const detail = referenceDefinition(reference).replace(/\s+/g, " ");
    const pictures = pictureNumbers.get(reference.id) ?? [];
    const video = videoNumbers.get(reference.id);
    const label = referenceLabel(reference, index);
    const lead = index === 0 ? "" : "\n";
    if (!detail && pictures.length === 0 && !video && activeReferenceRefmods(reference).length) {
      return [frame(`${lead}${label} uses the attached pre-encoded reference.`)];
    }
    if (pictures.length === 0 && !video) return [frame(`${lead}${label}: `), own(detail), ...addedStop(detail)];
    const pictureList = listOf([...pictures.map((picture) => `<Picture ${picture}>`), ...(video ? [`<Video ${video}>`] : [])]);
    return [
      frame(`${lead}${label} is the content shown in ${pictureList}.`),
      ...(detail ? [frame(" "), own(detail), ...addedStop(detail)] : []),
    ];
  });
  const startPicture = startFrame ? pictureNumbers.get(startFrame.id)?.[0] ?? null : null;
  const endPicture = endFrame ? pictureNumbers.get(endFrame.id)?.[0] ?? null : null;
  const startDefinition = startPicture
    ? [frame(`<Picture ${startPicture}> is the first frame of the video.${definitions.length > 0 || endPicture ? "\n" : ""}`)]
    : [];
  const endDefinition = endPicture
    ? [frame(`<Picture ${endPicture}> is the last frame of the video.${definitions.length > 0 ? "\n" : ""}`)] : [];

  const labels = usable.map((reference, index) => referenceLabel(reference, index));
  const labelList = listOf(labels);

  /* Which subjects each shot is said to feature.

     Once ANY line names a reference, every line means what it says: a shot that
     names nobody features nobody, and no claim is made about it. Only a scene
     where NO line names anything falls back to "all of them" — which is what a
     scene written before references could be dropped into the text means, and
     what keeps a single untokened shot compiling to the bytes it always did. */
  const anyCited = compiled.some((shot) => shot.citedIds.length > 0);
  const featured = compiled.map((shot) => anyCited ? shot.citedIds : usable.map((reference) => reference.id));

  // §3: task-type prefix. Subject references provide generation guidance; an
  // optional opening picture additionally anchors the first frame. The summary
  // reuses existing labels only and carries the user's lines through in order.
  const summary: PromptSegment[] = [
    frame("[reference generation] "),
    ...compiled.flatMap((shot) => [
      ...(shot.index === 0 ? [] : [frame(" ")]),
      ...shot.body,
      ...addedStop(shot.text),
    ]),
    ...(startPicture ? [frame(` The video begins with <Picture ${startPicture}>.`)] : []),
    ...(endPicture ? [frame(` The video ends with <Picture ${endPicture}>.`)] : []),
    ...(labels.length > 0 ? [frame(` ${labelList} ${labels.length === 1 ? "provides" : "provide"} generation guidance for the ${compiled.length === 1 ? "single shot" : `${compiled.length} shots`} described below.`)] : []),
  ];

  // §4.1: one line per label using the fixed marker vocabulary. Their defined
  // role is carried through unchanged, so fully_preserved is the honest marker.
  // §5.4: never write (Sx) in retention_analysis.
  // No `name` here either: "the defined characteristics of IMG_4821 are
  // retained" names nothing to retain. The label already points at the
  // definition above, which is where the characteristics actually live.
  //
  // Where a subject appears is READ OFF the shots, never assumed: a reference
  // bound to the scene but written into none of its lines gets no "appears in"
  // claim at all, because there is no shot it can honestly be placed in.
  const retention = usable.map((reference, index) => {
    const appearances = compiled.filter((shot) => featured[shot.index].includes(reference.id))
      .map((shot) => `[Shot ${shot.index + 1}]`);
    const where = appearances.length > 0 ? ` (appears in ${appearances.join(", ")})` : "";
    return `${referenceLabel(reference, index)}${where}: fully_preserved - the referenced characteristics are retained.`;
  });
  if (startPicture) retention.unshift(`<Picture ${startPicture}>: first_frame - used as the opening frame.`);
  if (endPicture) retention.push(`<Picture ${endPicture}>: last_frame - used as the closing frame.`);

  // §5.2: in full-reference mode the style opening comes BEFORE [Shot 1], not
  // after it. §5.3: cite each <Subject N> where it appears in the shot.
  const detailed: PromptSegment[] = [
    frame("The target video is in a "),
    styleFromTag ? tagged(midSentenceStyle(style)) : frame(midSentenceStyle(style)),
    frame(" style.\n"),
    ...compiled.flatMap((shot) => [
      frame(shot.index === 0 ? marker(shot) : `\n${marker(shot)}`),
      // Framing leads the sentence here, so it takes the capital.
      ...(shot.tags.framing.length > 0 ? [tagged(capitalize(shot.tags.framing.join(", "))), frame(", ")] : []),
      ...shot.body,
      ...addedStop(shot.text),
      // A shot that names nobody gets no sentence about who is in it.
      ...(featured[shot.index].length > 0
        ? [frame(` The shot features ${listOf(featured[shot.index].map((id) => `<Subject ${subjectNumber.get(id)}>`))}, matching the definitions above.`)]
        : []),
      ...tail(shot),
      ...dialogue(shot, shot.text.length > 0 || featured[shot.index].length > 0 || shot.tags.clauses.length > 0),
      ...(shot.index === 0 && startPicture ? [frame(` The opening frame matches <Picture ${startPicture}>.`)] : []),
      ...(shot.index === compiled.length - 1 && endPicture ? [frame(` The closing frame matches <Picture ${endPicture}>.`)] : []),
    ]),
  ];

  return [
    frame("subject_definitions:\n"),
    ...startDefinition,
    ...endDefinition,
    ...definitions,
    frame("\n\nsummary:\n"),
    ...summary,
    frame(`\n\nretention_analysis:\n${retention.join("\n")}`),
    frame("\n\ndetailed_description:\n"),
    ...detailed,
    frame("\n\noverall_soundscape:\n"),
    soundSegment,
    frame("\n\nnon_diegetic_music:\n"),
    musicSegment,
  ].filter((segment) => segment.value.length > 0);
}

/** Tokens in a scene that no longer name a reference the prompt can cite —
 *  deleted, cleared of its description, or tagged as a sound note. They are
 *  left OUT of the compiled prompt, so the editor has to say which ones and
 *  why, and sending is blocked until they are re-pointed or removed. */
export function danglingReferenceTokens(shots: readonly SceneShot[], references: ProjectReference[]): string[] {
  const usable = new Set(references.filter(isReferenceUsable).filter(isVisualReference).map((reference) => reference.id));
  const missing: string[] = [];
  for (const shot of shots) {
    for (const id of actionReferenceIds(shot.action)) {
      if (!usable.has(id) && !missing.includes(id)) missing.push(id);
    }
  }
  return missing;
}

/** The name a new scene carries until the user renames it: their own first
 *  words, never a phrase this app made up. A scene started empty has no words
 *  to take one from, so it says exactly that instead of pretending. */
export const UNTITLED_SCENE = "Untitled scene";

export function createDraftGenerationJob(
  creativeBrief: string,
  options: {
    id?: string;
    title?: string;
    referenceIds?: string[];
    startFrameReferenceId?: string | null;
    endFrameReferenceId?: string | null;
    usePreviousSceneLastFrame?: boolean;
    references?: ProjectReference[];
    shotTags?: ShotTagSelection | null;
    /** The shots to open the scene with. Omitted means one shot holding
     *  `creativeBrief`, which is what every caller wanted before scenes. */
    shots?: SceneShot[];
    durationSeconds?: number;
    steps?: number;
    seed?: number;
    now?: string;
  } = {},
): GenerationJob {
  const brief = creativeBrief.trim();
  const now = options.now ?? new Date().toISOString();
  // Omitted rather than written as null when nothing is tagged, so a shot built
  // from prose alone still writes exactly the file it always did.
  const shotTags = normalizeShotTagSelection(options.shotTags);
  const id = options.id ?? crypto.randomUUID();
  // Derived from the scene's own id, not a fresh uuid: the same shot id a
  // legacy job is read as by `sceneShots`, and the same bytes on every run, so
  // a created project is reproducible enough to be a fixture.
  const shots = normalizeSceneShots(options.shots ?? [{ id: `${id}-shot-1`, startSeconds: 0, action: brief, ...(shotTags ? { settings: shotTags } : {}) }]);
  const durationSeconds = Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, options.durationSeconds ?? DEFAULT_SCENE_SECONDS));
  const text = sceneBriefText(shots);
  return generationJobSchema.parse({
    id,
    // Their own words, cut short — and only ever their words. See UNTITLED_SCENE.
    title: options.title ?? (text.split(/\s+/).filter(Boolean).slice(0, 6).join(" ") || UNTITLED_SCENE),
    prompt: text,
    status: "draft",
    stage: "queued",
    progress: 0,
    providerId: "minimax-h3",
    creativeBrief: text,
    referenceIds: options.referenceIds ?? [],
    startFrameReferenceId: options.startFrameReferenceId ?? undefined,
    endFrameReferenceId: options.endFrameReferenceId ?? undefined,
    usePreviousSceneLastFrame: options.usePreviousSceneLastFrame ?? undefined,
    shots,
    durationSeconds,
    steps: options.steps ?? DEFAULT_GENERATION_STEPS,
    seed: options.seed ?? RANDOM_GENERATION_SEED,
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

/** The editor is three audiovisual layers. Clips from older separate lanes
 * are moved into them; their mute/lock state comes with them while the new
 * lanes keep the canonical Track 1–3 names. */
export function normalizeTimelineTracks(tracks: TimelineTrack[]): TimelineTrack[] {
  const videoTracks = tracks.filter((track) => track.kind === "video");
  const kept = videoTracks.slice(0, 3).map((track) => ({ ...track, clips: [...track.clips] }));
  const retainedIds = new Set(kept.map((track) => track.id));
  const retired = tracks.filter((track) => !retainedIds.has(track.id));
  const originalLayerCount = kept.length;
  const used = new Set(tracks.map((track) => track.id));
  const preferred = [STORY_TRACK_ID, "track-v2", "track-v3"];
  while (kept.length < 3) {
    const at = kept.length;
    let id = preferred[at];
    let suffix = 2;
    while (used.has(id)) id = `${preferred[at]}-${suffix++}`;
    used.add(id);
    kept.push({ id, kind: "video", name: `Track ${at + 1}`, locked: false, muted: false, clips: [] });
  }
  retired.forEach((track, index) => {
    const targetIndex = Math.min(2, originalLayerCount + index);
    const target = kept[targetIndex];
    if (targetIndex >= originalLayerCount && target.clips.length === 0) {
      target.locked = track.locked;
      target.muted = track.muted;
    } else if (targetIndex >= originalLayerCount) {
      target.name = `Track ${targetIndex + 1}`;
      target.locked = target.locked && track.locked;
      target.muted = target.muted && track.muted;
    }
    target.clips.push(...track.clips.map((clip) => ({ ...clip, trackId: target.id })));
  });
  return kept;
}

export function createProjectConfig(input: CreateProjectInput): ProjectConfig {
  const now = new Date().toISOString();
  const brief = input.prompt.trim();
  return projectConfigSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generationType: "video",
    id: crypto.randomUUID(),
    name: input.name.trim(),
    createdAt: now,
    updatedAt: now,
    thumbnail: null,
    settings: { aspectRatio: input.aspectRatio, resolution: input.resolution, frameRate: 24, backgroundColor: "#10131a" },
    brief: {
      prompt: brief, status: "draft", targetDurationSeconds: input.targetDurationSeconds,
      aspectRatio: input.aspectRatio, resolution: input.resolution,
    },
    assets: [],
    /* Three audiovisual layers. A video's sound follows it on its own track,
       and the track mute controls that embedded audio. */
    timeline: { tracks: [
      { id: STORY_TRACK_ID, kind: "video", name: "Track 1", locked: false, muted: false, clips: [] },
      { id: "track-v2", kind: "video", name: "Track 2", locked: false, muted: false, clips: [] },
      { id: "track-v3", kind: "video", name: "Track 3", locked: false, muted: false, clips: [] },
    ] },
    references: [],
    generationJobs: brief ? [createDraftGenerationJob(brief, { id: "job-initial-brief", title: "First scene", now })] : [],
    providerSettings: {},
  });
}

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
  const job = (value: Omit<GenerationJob, "providerId" | "creativeBrief" | "updatedAt">): GenerationJob => ({
    ...value, providerId: "minimax-h3", creativeBrief: value.prompt,
    updatedAt: value.createdAt,
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
      { id: STORY_TRACK_ID, kind: "video", name: "Track 1", locked: false, muted: false, clips: videoClips },
      { id: "track-v2", kind: "video", name: "Track 2", locked: false, muted: false, clips: [{ id: "clip-voice", assetId: "asset-voice", trackId: "track-v2", startMs: 1800, durationMs: 28000, sourceStartMs: 0, label: "Mara · narration", color: "#3d817c", status: "approved" }] },
      { id: "track-v3", kind: "video", name: "Track 3", locked: false, muted: false, clips: [{ id: "clip-score", assetId: "asset-score", trackId: "track-v3", startMs: 0, durationMs: 34000, sourceStartMs: 0, label: "Glass & concrete", color: "#6b5790", status: "approved" }] },
    ] },
    references,
    generationJobs,
  });
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  const config = projectConfigSchema.parse(value);
  return { ...config, timeline: { tracks: normalizeTimelineTracks(config.timeline.tracks) } };
}

export function projectNameFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/^(create|make|generate|build|produce)\s+(me\s+)?(a|an|the)?\s*/i, "").replace(/[.!?]+$/g, "").trim();
  if (!cleaned) return "Untitled video";
  const short = cleaned.split(/\s+/).slice(0, 7).join(" ");
  return short.charAt(0).toUpperCase() + short.slice(1);
}
