import { z } from "zod";

export const PROJECT_FILE_NAME = "polstudio.project.json";
export const CURRENT_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().min(1);
const isoDateSchema = z.string().datetime();

export const aspectRatioSchema = z.enum(["16:9", "9:16", "1:1", "4:5"]);
export const resolutionSchema = z.enum(["720p", "1080p", "4k"]);

export const projectAssetSchema = z.object({
  id: idSchema,
  kind: z.enum(["video", "audio", "image", "caption", "generated"]),
  name: z.string().min(1),
  relativePath: z.string().min(1),
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

export const projectConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: idSchema,
  name: z.string().min(1).max(120),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  thumbnail: z.string().nullable(),
  settings: z.object({
    aspectRatio: aspectRatioSchema,
    resolution: resolutionSchema,
    frameRate: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  brief: generationBriefSchema,
  assets: z.array(projectAssetSchema),
  timeline: z.object({ tracks: z.array(timelineTrackSchema) }),
});

export type AspectRatio = z.infer<typeof aspectRatioSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type ProjectAsset = z.infer<typeof projectAssetSchema>;
export type TimelineClip = z.infer<typeof timelineClipSchema>;
export type TimelineTrack = z.infer<typeof timelineTrackSchema>;
export type GenerationBrief = z.infer<typeof generationBriefSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ProjectRecord {
  folderPath: string;
  config: ProjectConfig;
}

export interface CreateProjectInput {
  name: string;
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: Resolution;
  targetDurationSeconds: number;
  parentDirectory?: string;
}

export function createProjectConfig(input: CreateProjectInput): ProjectConfig {
  const now = new Date().toISOString();
  return projectConfigSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name: input.name.trim(),
    createdAt: now,
    updatedAt: now,
    thumbnail: null,
    settings: {
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      frameRate: 30,
      backgroundColor: "#10131a",
    },
    brief: {
      prompt: input.prompt.trim(),
      status: "draft",
      targetDurationSeconds: input.targetDurationSeconds,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
    },
    assets: [],
    timeline: { tracks: [] },
  });
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  return projectConfigSchema.parse(value);
}

export function projectNameFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/^(create|make|generate|build|produce)\s+(me\s+)?(a|an|the)?\s*/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned) return "Untitled video";
  const short = cleaned.split(/\s+/).slice(0, 7).join(" ");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

