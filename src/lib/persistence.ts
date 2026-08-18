import { invoke } from "@tauri-apps/api/core";
import {
  createProjectConfig,
  parseProjectConfig,
  seedProjectWorkspace,
  type CreateProjectInput,
  type PendingReferenceImage,
  type ProjectConfig,
  type ProjectRecord,
} from "./project";

const RECENTS_KEY = "polstudio.recent-projects.v1";
const WEB_PROJECTS_KEY = "polstudio.web-projects.v1";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

/** A project the library knows about but could not read back. */
export interface UnreadableProject {
  folderPath: string;
  /** The underlying message, kept verbatim so it stays diagnosable. */
  detail: string;
}

/** Everything the library loaded, plus everything it failed to load. One bad
 *  project must never hide the good ones, and it must never vanish silently:
 *  the Rust validator is looser than the zod schema here, so a config the
 *  backend happily wrote can still fail to parse on the next launch. */
export interface RecentProjects {
  projects: ProjectRecord[];
  unreadable: UnreadableProject[];
}

const describeReason = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function rememberPath(path: string): void {
  const paths = readJson<string[]>(RECENTS_KEY, []).filter((item) => item !== path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify([path, ...paths].slice(0, 12)));
}

function webSeedProjects(): ProjectRecord[] {
  const now = new Date();
  const seeds = [
    {
      path: "~/PolStudio/Northern Light",
      prompt: "A cinematic brand film following an architect from sketch to skyline",
      name: "Northern Light — Brand Film",
      ratio: "16:9" as const,
      resolution: "4k" as const,
      offset: 12,
    },
    {
      path: "~/PolStudio/Field Notes",
      prompt: "A warm vertical travel journal through Helsinki's hidden cafés",
      name: "Helsinki Field Notes",
      ratio: "9:16" as const,
      resolution: "1080p" as const,
      offset: 46,
    },
    {
      path: "~/PolStudio/Aether Launch",
      prompt: "A crisp product launch teaser with macro details and kinetic typography",
      name: "Aether Product Reveal",
      ratio: "16:9" as const,
      resolution: "4k" as const,
      offset: 130,
    },
  ];
  return seeds.map((seed, index) => {
    const config = createProjectConfig({
      name: seed.name,
      prompt: seed.prompt,
      aspectRatio: seed.ratio,
      resolution: seed.resolution,
      targetDurationSeconds: index === 1 ? 30 : 60,
    });
    config.id = `sample-${index + 1}`;
    config.createdAt = new Date(now.getTime() - seed.offset * 86_400_000).toISOString();
    config.updatedAt = new Date(now.getTime() - (index * 22 + 3) * 3_600_000).toISOString();
    return { folderPath: seed.path, config: seedProjectWorkspace(config, index) };
  });
}

function getWebProjects(): RecentProjects {
  const stored = readJson<ProjectRecord[] | null>(WEB_PROJECTS_KEY, null);
  if (stored) {
    const projects: ProjectRecord[] = [];
    const unreadable: UnreadableProject[] = [];
    for (const record of stored) {
      try {
        const parsed = parseProjectConfig(record.config);
        const sampleIndex = /^sample-(\d+)$/.exec(parsed.id);
        projects.push({ ...record, config: sampleIndex ? seedProjectWorkspace(parsed, Number(sampleIndex[1]) - 1) : parsed });
      } catch (reason) {
        unreadable.push({ folderPath: record.folderPath || "(unknown folder)", detail: describeReason(reason) });
      }
    }
    return { projects, unreadable };
  }
  const seeded = webSeedProjects();
  localStorage.setItem(WEB_PROJECTS_KEY, JSON.stringify(seeded));
  return { projects: seeded, unreadable: [] };
}

export async function listRecentProjects(): Promise<RecentProjects> {
  if (!isTauri()) return getWebProjects();
  const paths = readJson<string[]>(RECENTS_KEY, []);
  const rows = await Promise.all(
    paths.map(async (folderPath) => {
      try {
        const value = await invoke<ProjectRecord>("open_project", { folderPath });
        return { ok: true as const, record: { ...value, config: parseProjectConfig(value.config) } };
      } catch (reason) {
        // Swallowing this made the project disappear from the library with no
        // message at all — the worst failure mode in the app. Report it and
        // keep every row that did load.
        return { ok: false as const, failure: { folderPath, detail: describeReason(reason) } };
      }
    }),
  );
  return {
    projects: rows.flatMap((row) => (row.ok ? [row.record] : [])),
    unreadable: rows.flatMap((row) => (row.ok ? [] : [row.failure])),
  };
}

export async function chooseAndOpenProject(): Promise<ProjectRecord | null> {
  if (!isTauri()) return getWebProjects().projects[0] ?? null;
  const value = await invoke<ProjectRecord | null>("choose_project_folder");
  if (!value) return null;
  const record = { ...value, config: parseProjectConfig(value.config) };
  rememberPath(record.folderPath);
  return record;
}

export async function chooseInitialReferenceImages(): Promise<PendingReferenceImage[]> {
  if (!isTauri()) return [];
  return invoke<PendingReferenceImage[]>("choose_initial_reference_images");
}

/** A file the user picked, already copied into the project's `media/` folder.
 *  No duration or dimensions: PolStudio has no decoder yet, and a guessed
 *  number would be indistinguishable from a measured one downstream. */
export interface ImportedMediaFile {
  kind: "video" | "audio" | "image";
  name: string;
  relativePath: string;
  mimeType: string;
}

/** Opens the picker and copies what was chosen into the project. Returns an
 *  empty list when the user cancels — and in the browser, where there is no
 *  project folder to copy into. */
export async function importMediaFiles(folderPath: string): Promise<ImportedMediaFile[]> {
  if (!isTauri()) return [];
  return invoke<ImportedMediaFile[]>("import_media_files", { folderPath });
}

/** The bytes of one file inside a project folder, as a blob URL the webview
 *  can point an <img> at. Null in the browser, where there is no folder to
 *  read from. CALLERS MUST revokeObjectURL when done — a leaked blob URL pins
 *  the whole image in memory for the life of the document. */
export async function readProjectFileUrl(folderPath: string, relativePath: string, mimeType: string): Promise<string | null> {
  if (!isTauri()) return null;
  const bytes = await invoke<ArrayBuffer>("read_project_file", { folderPath, relativePath });
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export async function createProject(input: CreateProjectInput): Promise<ProjectRecord | null> {
  const config = createProjectConfig(input);
  if (isTauri()) {
    const value = await invoke<ProjectRecord | null>("create_project", {
      parentDirectory: input.parentDirectory ?? null,
      config,
      initialReferencePaths: input.referenceImages?.map((image) => image.sourcePath) ?? [],
    });
    if (!value) return null;
    const record = { ...value, config: parseProjectConfig(value.config) };
    rememberPath(record.folderPath);
    return record;
  }
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const record = { folderPath: `~/PolStudio/${slug || config.id}`, config };
  const projects = [record, ...getWebProjects().projects];
  localStorage.setItem(WEB_PROJECTS_KEY, JSON.stringify(projects));
  return record;
}

export async function saveProject(record: ProjectRecord): Promise<ProjectRecord> {
  const next: ProjectRecord = {
    ...record,
    config: parseProjectConfig({ ...record.config, updatedAt: new Date().toISOString() }),
  };
  if (isTauri()) {
    await invoke("save_project", { folderPath: next.folderPath, config: next.config });
  } else {
    const projects = getWebProjects().projects.filter((project) => project.config.id !== next.config.id);
    localStorage.setItem(WEB_PROJECTS_KEY, JSON.stringify([next, ...projects]));
  }
  rememberPath(next.folderPath);
  return next;
}

