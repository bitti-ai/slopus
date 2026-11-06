import { z } from "zod";
import type { ProjectAsset, ProjectConfig, ProjectReference } from "./project";

export const YUE2_DEFAULT_STEPS = 6;

export const musicSettingsSchema = z.object({
  lyrics: z.string().max(30000).default(""),
  duration: z.number().finite().min(2).max(300).default(30),
  planning: z.enum(["full", "melody", "off"]).default("full"),
  abc: z.string().max(30000).default(""),
  abc_max_tokens: z.number().int().min(32).max(4096).default(4096),
  temperature: z.number().finite().min(0).max(10).default(1),
  top_p: z.number().finite().gt(0).max(1).default(0.95),
  top_k: z.number().int().min(0).max(1024).default(0),
  repetition_penalty: z.number().finite().min(1).max(10).default(1.2),
  semantic_guidance: z.number().finite().min(0).max(10).default(0),
  flow_guidance: z.number().finite().min(0).max(10).default(0),
  flow_sampler: z.enum(["default", "midpoint", "dpmpp_2m"]).default("default"),
}).refine((value) => value.semantic_guidance === 0 || value.semantic_guidance >= 1, "Semantic guidance must be zero (automatic) or at least one.")
  .refine((value) => value.planning !== "off" || !value.abc, "ABC requires full or melody planning.");
export const musicSongSchema = z.object({
  id: z.string().min(1), title: z.string().min(1).max(200),
  folderId: z.string().min(1).nullish(),
  style: z.string().max(10000).default(""),
  generatorId: z.string().default("yue2"),
  settings: musicSettingsSchema.default({}),
  steps: z.number().int().min(2).max(100).default(YUE2_DEFAULT_STEPS),
  seed: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).default(-1),
  status: z.enum(["draft", "queued", "generating", "completed", "failed", "cancelled"]).default("draft"),
  assetId: z.string().nullish(), error: z.string().nullish(),
  coverRelativePath: z.string().min(1).nullish(),
  generation: z.object({ generatorId: z.string(), style: z.string(), settings: musicSettingsSchema,
    steps: z.number().int().min(2).max(100), seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).nullish(),
  createdAt: z.string(),
});
export type MusicSong = z.infer<typeof musicSongSchema>;
export type MusicSettings = z.infer<typeof musicSettingsSchema>;

export function albumCoverPrompt(song: MusicSong, modelType: string): string {
  const visual = [
    "Square album cover artwork for a song. A striking, cohesive visual composition inspired by the song's mood, genre and lyrical imagery. No lettering, captions, watermarks or borders.",
    `Song title: ${song.title}`,
    `Musical style and mood: ${song.generation?.style ?? song.style}`,
    (song.generation?.settings.lyrics ?? song.settings.lyrics).trim()
      ? `Lyrics for visual inspiration:\n${(song.generation?.settings.lyrics ?? song.settings.lyrics).trim().slice(0, 4000)}` : "Instrumental music.",
  ].join("\n");
  return modelType === "minimax-h3"
    ? `integrated_multimodal_description: [Shot 1] ${visual}\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A`
    : visual;
}
export const musicFolderSchema = z.object({ id: z.string().min(1), name: z.string().trim().min(1).max(200), parentId: z.string().min(1).nullish() });
export type MusicFolder = z.infer<typeof musicFolderSchema>;

export function newSong(generatorId = "yue2", steps = generatorId === "minimax_music3" ? 30 : YUE2_DEFAULT_STEPS, folderId?: string | null): MusicSong {
  return musicSongSchema.parse({ id: `song-${crypto.randomUUID()}`, title: "New song", generatorId, steps,
    settings: { flow_sampler: generatorId === "minimax_music3" ? "default" : "dpmpp_2m" },
    ...(folderId ? { folderId } : {}), createdAt: new Date().toISOString() });
}

export function duplicateSong(source: MusicSong): MusicSong {
  return { ...structuredClone(source), id: `song-${crypto.randomUUID()}`,
    status: "draft", assetId: null, error: null, generation: null, createdAt: new Date().toISOString() };
}

export function newSongVariation(source: MusicSong, songs: readonly MusicSong[]): MusicSong {
  const base = source.title.replace(/ \(\d+\)$/, "");
  let number = 2, title: string;
  do {
    const suffix = ` (${number++})`;
    title = base.slice(0, 200 - suffix.length) + suffix;
  } while (songs.some((song) => song.title === title));
  return { ...duplicateSong(source), title };
}

export function newMusicFolder(name: string, parentId: string | null): MusicFolder {
  return musicFolderSchema.parse({ id: `music-folder-${crypto.randomUUID()}`, name, parentId });
}

export function moveSong(config: ProjectConfig, songId: string, folderId: string | null): ProjectConfig {
  if (folderId && !config.musicFolders?.some((folder) => folder.id === folderId)) return config;
  return updateSong(config, songId, { folderId });
}

export function removeMusicFolder(config: ProjectConfig, id: string): ProjectConfig {
  const folder = config.musicFolders?.find((item) => item.id === id);
  if (!folder) return config;
  const parentId = folder.parentId ?? null;
  return { ...config,
    musicFolders: config.musicFolders!.filter((item) => item.id !== id).map((item) => item.parentId === id ? { ...item, parentId } : item),
    musicSongs: config.musicSongs?.map((song) => song.folderId === id ? { ...song, folderId: parentId } : song),
  };
}

export function musicFolderLabel(folders: readonly MusicFolder[], id: string): string {
  const names: string[] = [], visited = new Set<string>();
  let folder = folders.find((item) => item.id === id);
  while (folder && !visited.has(folder.id)) {
    visited.add(folder.id); names.unshift(folder.name);
    folder = folders.find((item) => item.id === folder!.parentId);
  }
  return names.join(" / ");
}

export function musicSettingsForModel(settings: MusicSettings, modelType: string): MusicSettings {
  const defaults = musicSettingsSchema.parse({});
  return modelType === "minimax_music3" ? { ...defaults, lyrics: settings.lyrics, duration: settings.duration,
    top_k: settings.top_k, semantic_guidance: settings.semantic_guidance, flow_guidance: settings.flow_guidance }
    : { ...settings, flow_guidance: 0, flow_sampler: settings.flow_sampler === "midpoint" ? "midpoint" : "dpmpp_2m" };
}

export function songReference(song: MusicSong, asset: ProjectAsset): ProjectReference {
  if (asset.kind !== "audio" || !asset.relativePath || !asset.durationMs || asset.durationMs < 2000) throw new Error("Generate a song at least two seconds long before creating a reference.");
  return { id: `ref-${crypto.randomUUID()}`, kind: "audio", name: song.title, description: song.style,
    relativePath: asset.relativePath, intendedUse: ["audio"], createdAt: new Date().toISOString(),
    audio: { startSeconds: 0, durationSeconds: Math.min(15, asset.durationMs / 1000) } };
}

export function updateSong(config: ProjectConfig, id: string, patch: Partial<MusicSong>): ProjectConfig {
  return { ...config, musicSongs: (config.musicSongs ?? []).map((song) => song.id === id ? { ...song, ...patch } : song) };
}
