import { invoke } from "@tauri-apps/api/core";
import {
  createProjectConfig,
  parseProjectConfig,
  type CreateProjectInput,
  type ProjectConfig,
  type ProjectRecord,
} from "./project";

const RECENTS_KEY = "polstudio.recent-projects.v1";
const WEB_PROJECTS_KEY = "polstudio.web-projects.v1";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

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
      path: "~/Pol Studio/Northern Light",
      prompt: "A cinematic brand film following an architect from sketch to skyline",
      name: "Northern Light — Brand Film",
      ratio: "16:9" as const,
      resolution: "4k" as const,
      offset: 12,
    },
    {
      path: "~/Pol Studio/Field Notes",
      prompt: "A warm vertical travel journal through Helsinki's hidden cafés",
      name: "Helsinki Field Notes",
      ratio: "9:16" as const,
      resolution: "1080p" as const,
      offset: 46,
    },
    {
      path: "~/Pol Studio/Aether Launch",
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
    return { folderPath: seed.path, config };
  });
}

function getWebProjects(): ProjectRecord[] {
  const stored = readJson<ProjectRecord[] | null>(WEB_PROJECTS_KEY, null);
  if (stored) {
    return stored.flatMap((record) => {
      try {
        return [{ ...record, config: parseProjectConfig(record.config) }];
      } catch {
        return [];
      }
    });
  }
  const seeded = webSeedProjects();
  localStorage.setItem(WEB_PROJECTS_KEY, JSON.stringify(seeded));
  return seeded;
}

export async function listRecentProjects(): Promise<ProjectRecord[]> {
  if (!isTauri()) return getWebProjects();
  const paths = readJson<string[]>(RECENTS_KEY, []);
  const records = await Promise.all(
    paths.map(async (folderPath) => {
      try {
        const value = await invoke<ProjectRecord>("open_project", { folderPath });
        return { ...value, config: parseProjectConfig(value.config) };
      } catch {
        return null;
      }
    }),
  );
  return records.filter((record): record is ProjectRecord => record !== null);
}

export async function chooseAndOpenProject(): Promise<ProjectRecord | null> {
  if (!isTauri()) return getWebProjects()[0] ?? null;
  const value = await invoke<ProjectRecord | null>("choose_project_folder");
  if (!value) return null;
  const record = { ...value, config: parseProjectConfig(value.config) };
  rememberPath(record.folderPath);
  return record;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectRecord | null> {
  const config = createProjectConfig(input);
  if (isTauri()) {
    const value = await invoke<ProjectRecord | null>("create_project", {
      parentDirectory: input.parentDirectory ?? null,
      config,
    });
    if (!value) return null;
    const record = { ...value, config: parseProjectConfig(value.config) };
    rememberPath(record.folderPath);
    return record;
  }
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const record = { folderPath: `~/Pol Studio/${slug || config.id}`, config };
  const projects = [record, ...getWebProjects()];
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
    const projects = getWebProjects().filter((project) => project.config.id !== next.config.id);
    localStorage.setItem(WEB_PROJECTS_KEY, JSON.stringify([next, ...projects]));
  }
  rememberPath(next.folderPath);
  return next;
}

