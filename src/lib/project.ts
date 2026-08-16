import { z } from "zod";

export const PROJECT_FILE_NAME = "polstudio.project.json";
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

export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:5"]);
export const resolutionSchema = z.enum(["720p", "1080p", "4k"]);

export const projectAssetSchema = z.object({
  id: idSchema,
  kind: z.enum(["video", "audio", "image", "caption", "generated"]),
  name: z.string().min(1),
  relativePath: projectRelativePathSchema,
  mimeType: z.string().min(1),
  durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  createdAt: isoDateSchema,
});

export const timelineClipSchema = z.object({
  id: idSchema,
  assetId: idSchema,
  trackId: idSchema,
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  sourceStartMs: z.number().int().nonnegative().default(0),
  label: z.string().min(1),
  color: z.string().optional(),
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
  kind: z.enum(["text", "image"]),
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1).nullable().optional(),
  relativePath: projectRelativePathSchema.nullable().optional(),
  intendedUse: z.array(z.enum(["character", "product", "location", "style", "audio"])).default([]),
  createdAt: isoDateSchema,
}).superRefine((reference, context) => {
  if (reference.kind === "image" && !reference.relativePath) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["relativePath"], message: "Image references require a relative path." });
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
  compiledPrompt: z.string().min(1),
  referenceIds: z.array(idSchema).default([]),
  clipId: idSchema.optional(),
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

export function compileMiniMaxH3Prompt(creativeBrief: string): string {
  const brief = creativeBrief.trim();
  return [
    `integrated_multimodal_description: [Shot 1] ${brief}`,
    "overall_soundscape: Natural location ambience shaped to the action in the scene.",
    "non_diegetic_music: A restrained cinematic score that supports the story without overpowering it.",
  ].join("\n\n");
}

export function createDraftGenerationJob(
  creativeBrief: string,
  options: { id?: string; title?: string; referenceIds?: string[]; now?: string } = {},
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
    compiledPrompt: compileMiniMaxH3Prompt(brief),
    referenceIds: options.referenceIds ?? [],
    createdAt: now,
    updatedAt: now,
  });
}

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
    timeline: { tracks: [
      { id: "track-story", kind: "video", name: "Story", locked: false, muted: false, clips: [] },
      { id: "track-voice-over", kind: "audio", name: "Voice-over", locked: false, muted: false, clips: [] },
      { id: "track-music", kind: "audio", name: "Music", locked: false, muted: false, clips: [] },
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
    { id: "clip-01", assetId: "asset-establishing", trackId: "track-v1", startMs: 0, durationMs: 7200, sourceStartMs: 0, label: "01 · A city still becoming", color: hues[0], status: "approved" },
    { id: "clip-02", assetId: "asset-studio", trackId: "track-v1", startMs: 7200, durationMs: 8600, sourceStartMs: 0, label: "02 · From line to light", color: hues[1], status: "approved" },
    { id: "clip-03", assetId: "asset-portrait", trackId: "track-v1", startMs: 15800, durationMs: 7600, sourceStartMs: 0, label: "03 · Designed for people", color: hues[2], status: "generated" },
    { id: "clip-04", assetId: "asset-rooftop", trackId: "track-v1", startMs: 23400, durationMs: 8400, sourceStartMs: 0, label: "04 · Northern light", color: hues[0], status: "approved" },
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
      { id: "track-v2", kind: "video", name: "Overlays", locked: false, muted: false, clips: [] },
      { id: "track-v1", kind: "video", name: "Story", locked: false, muted: false, clips: videoClips },
      { id: "track-a1", kind: "audio", name: "Voice-over", locked: false, muted: false, clips: [{ id: "clip-voice", assetId: "asset-voice", trackId: "track-a1", startMs: 1800, durationMs: 28000, sourceStartMs: 0, label: "Mara · narration", color: "#3d817c", status: "approved" }] },
      { id: "track-a2", kind: "audio", name: "Music", locked: false, muted: false, clips: [{ id: "clip-score", assetId: "asset-score", trackId: "track-a2", startMs: 0, durationMs: 34000, sourceStartMs: 0, label: "Glass & concrete", color: "#6b5790", status: "approved" }] },
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
