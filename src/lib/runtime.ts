import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./persistence";
import {
  actionReferenceIds, createDraftGenerationJob, GENERATION_FRAME_RATE, parseProjectConfig,
  sceneBriefText, type AgentMessage, type GenerationJob, type ProjectAsset, type ProjectConfig,
  type ProjectRecord, type SceneShot, type TimelineClip,
} from "./project";
import {
  agentEndpointProviderSettings, endpointProviderSetting, engineProviderSetting,
  loadDefaultGenerationSteps, loadEngineSettings, withAgentEndpointSettings,
  type AttentionMode, type EndpointProviderId, type EndpointProviderSettings, type EnginePathField,
} from "./settings";

export type ProviderId = "claude" | "codex" | EndpointProviderId;
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  /* "checking" is FRONTEND-ONLY and never comes back from Rust: it is what the
     dock shows while the probe is in flight. It used to borrow "unavailable"
     for that, so a slow or failed probe left every provider reading
     "Unavailable" — including a Claude Code that was installed and working. */
  state: "checking" | "ready" | "disabled" | "notInstalled" | "authRequired" | "unavailable";
  executable: string | null;
  version: string | null;
  detail: string;
}
export interface ModelStatus { id: string; configured: boolean; available: boolean; path: string | null }
export interface SlopfabStatus {
  state: "ready" | "modelsMissing" | "runtimeMissing" | "incompatible" | "demo";
  dllPath: string;
  version: string | null;
  platform: string | null;
  cudaAvailable?: boolean;
  detail: string;
  models: ModelStatus[];
}
export interface RuntimeStatus { providers: ProviderStatus[]; slopfab: SlopfabStatus }

export type ProjectCommand =
  | { op: "project.set"; name?: string; prompt?: string; targetSeconds?: number; aspectRatio?: string; resolution?: string; frameRate?: number; backgroundColor?: string }
  | { op: "ref.add"; id: string; name: string; text: string; use: string[] }
  | { op: "ref.set"; id: string; name?: string; text?: string; use?: string[] }
  | { op: "ref.remove"; id: string }
  | { op: "scene.add"; id: string; title: string; seconds: number; steps?: number; seed?: number; sound?: string; music?: string; startFrame?: string }
  | { op: "scene.set"; id: string; title?: string; seconds?: number; steps?: number; seed?: number; sound?: string | null; music?: string | null; startFrame?: string | null }
  | { op: "scene.remove"; id: string }
  | { op: "scene.move"; id: string; before?: string | null }
  | { op: "shot.add"; scene: string; id: string; at: number; action: string; name?: string; speech?: string; language?: string; settings?: Record<string, string[]> }
  | { op: "shot.set"; scene: string; id: string; at?: number; action?: string; name?: string | null; speech?: string | null; language?: string | null; settings?: Record<string, string[]> | null }
  | { op: "shot.remove"; scene: string; id: string }
  | { op: "clip.add"; id: string; scene?: string; asset?: string; track?: string; at?: number; seconds?: number; sourceAt?: number; label?: string }
  | { op: "clip.set"; id: string; track?: string; at?: number; seconds?: number; sourceAt?: number; label?: string }
  | { op: "clip.remove"; id: string };

export type AgentTurnResult =
  | { kind: "answer"; content: string }
  | { kind: "question"; content: string }
  | { kind: "commands"; summary: string; commands: ProjectCommand[] };

export type AgentTurnEvent =
  | { type: "started"; provider: ProviderId }
  | { type: "message" | "diagnostic"; text: string }
  | { type: "validation"; round: number; maxRounds: number; text: string }
  | { type: "completed" };

export interface AgentTurnEventPayload {
  requestId: string;
  event: AgentTurnEvent;
}

export const AGENT_TURN_EVENT = "agent-turn-event";

export interface AgentTurnResponse {
  result: AgentTurnResult;
  events: AgentTurnEvent[];
  messages: AgentMessage[];
}

export interface SlopfabGenerationRequest {
  jobId: string;
  prompt: string;
  frames: number;
  stillImage?: boolean;
  steps: number;
  seed: number;
  canvasWidth: number;
  canvasHeight: number;
  referencePaths: string[];
}

export interface ResolvedPlan {
  canvasWidth: number;
  canvasHeight: number;
  alignedFrames: number;
  durationSeconds: number;
  modelEvaluations: number;
  sequenceRowsWithoutText: number;
  latentFrames: number;
  latentWidth: number;
  latentHeight: number;
  description: string;
  boundary: string;
}

const DEMO_STATUS: RuntimeStatus = {
  providers: [
    { id: "claude", label: "Claude Code", state: "ready", executable: null, version: "Browser demo", detail: "Deterministic local demo provider." },
    { id: "codex", label: "Codex", state: "ready", executable: null, version: "Browser demo", detail: "Deterministic local demo provider." },
  ],
  slopfab: { state: "demo", dllPath: "Browser demo", version: null, platform: null, detail: "Deterministic plans only. No model runs or media files are created in the browser.", models: [] },
};

/* Every slopfab command is handed the project config with THIS machine's engine
   paths merged in (see lib/settings.ts). The merged copy is passed straight to
   the command and dropped; it is never the config that gets saved. */

/** What is installed on this computer. Takes no project: the agent CLIs and
 *  the video engine belong to the machine, so the app probes this ONCE at
 *  startup and every project shares the answer. */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  if (!isTauri()) return DEMO_STATUS;
  return invoke<RuntimeStatus>("runtime_status", {
    settings: { slopfab: engineProviderSetting(loadEngineSettings()), ...agentEndpointProviderSettings() },
  });
}

/** The placeholder every caller shows until the startup probe lands. */
export const CHECKING_PROVIDERS: ProviderStatus[] = [
  { id: "claude", label: "Claude Code", state: "checking", executable: null, version: null, detail: "Looking for Claude Code on this computer…" },
  { id: "codex", label: "Codex", state: "checking", executable: null, version: null, detail: "Looking for Codex on this computer…" },
];

/** Probes the engine paths on their own, with no project in hand — what the
 *  settings screen shows. */
export async function getEngineStatus(settings = loadEngineSettings(), attention?: AttentionMode): Promise<SlopfabStatus> {
  if (!isTauri()) return DEMO_STATUS.slopfab;
  return invoke<SlopfabStatus>("slopfab_status", { settings: { slopfab: engineProviderSetting(settings, undefined, attention) } });
}

/** Opens the OS picker for one engine path. Returns null when the user cancels. */
export async function chooseEnginePath(field: EnginePathField): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("choose_engine_path", {
    title: `Select ${field.label}`,
    directory: field.directory,
    extensions: field.extensions,
  });
}

export async function getAgentModels(provider: EndpointProviderId, settings: EndpointProviderSettings): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("list_agent_models", { provider, setting: endpointProviderSetting(settings) });
}

export async function runAgentTurn(record: ProjectRecord, provider: ProviderId, prompt: string, requestId: string, conversation: AgentMessage[] = []): Promise<AgentTurnResponse> {
  const createdAt = new Date().toISOString();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  if (isTauri()) {
    const response = await invoke<Omit<AgentTurnResponse, "messages">>("run_agent_turn", { request: {
      requestId, folderPath: record.folderPath, provider, prompt, config: withAgentEndpointSettings(record.config),
      conversation,
    } });
    const assistantContent = response.result.kind === "commands" ? response.result.summary : response.result.content;
    return {
      ...response,
      messages: [
        ...conversation,
        { id: userMessageId, role: "user", content: prompt.trim(), createdAt },
        { id: assistantMessageId, role: "assistant", content: assistantContent, createdAt },
      ],
    };
  }
  const result = demoTurn(record.config, prompt);
  const assistantContent = result.kind === "commands" ? result.summary : result.content;
  return {
    result,
    events: [{ type: "started", provider }, { type: "completed" }],
    messages: [
      ...conversation,
      { id: userMessageId, role: "user", content: prompt.trim(), createdAt },
      { id: assistantMessageId, role: "assistant", content: assistantContent, createdAt },
    ],
  };
}

/** The provider plans against its request snapshot, then this applies the
 * accepted commands to the editor's latest state. Rust is authoritative in the
 * desktop app; this mirror keeps the deterministic browser preview useful. */
export async function executeAgentCommands(config: ProjectConfig, commands: ProjectCommand[]): Promise<ProjectConfig> {
  if (isTauri()) {
    const next = await invoke<ProjectConfig>("execute_agent_commands", { config, commands, executedAt: new Date().toISOString() });
    return parseProjectConfig(next);
  }
  return executeDemoCommands(config, commands);
}

export async function cancelAgentTurn(requestId: string): Promise<boolean> {
  return isTauri() ? invoke<boolean>("cancel_agent_turn", { requestId }) : true;
}

export async function resolveSlopfabPlan(request: SlopfabGenerationRequest, config: ProjectConfig): Promise<ResolvedPlan> {
  if (isTauri()) return invoke<ResolvedPlan>("resolve_slopfab_plan", { request, config });
  const alignedFrames = Math.ceil(Math.max(5, request.frames - 5) / 17) * 17 + 5;
  return {
    canvasWidth: request.canvasWidth,
    canvasHeight: request.canvasHeight,
    alignedFrames,
    durationSeconds: alignedFrames / GENERATION_FRAME_RATE,
    modelEvaluations: request.steps - 1,
    sequenceRowsWithoutText: 0,
    latentFrames: Math.ceil(alignedFrames / 17), latentWidth: 0, latentHeight: 0,
    description: `Browser demo plan: ${alignedFrames} aligned frames at ${GENERATION_FRAME_RATE} fps.`,
    boundary: "Deterministic plan only. No weights were opened and no media file was created.",
  };
}

export async function enqueueSlopfabGeneration(request: SlopfabGenerationRequest, config: ProjectConfig): Promise<void> {
  if (isTauri()) await invoke("enqueue_slopfab_generation", { request, config });
}

export async function cancelSlopfabGeneration(jobId: string): Promise<boolean> {
  return isTauri() ? invoke<boolean>("cancel_slopfab_generation", { jobId }) : true;
}

export async function saveReferenceIcon(folderPath: string, jobId: string): Promise<string> {
  return invoke<string>("save_reference_icon", { folderPath, jobId });
}

function demoTurn(_config: ProjectConfig, prompt: string): AgentTurnResult {
  const clean = prompt.trim();
  if (/\b(which|what)\b.*\?/i.test(clean)) {
    return { kind: "question", content: "Should I apply that direction to the selected shot or to the full sequence?" };
  }
  if (/\b(add|create|queue|generate)\b.*\b(shot|clip)\b/i.test(clean)) {
    const id = `job-demo-${Date.now()}`;
    return {
      kind: "commands",
      summary: "Added a schema-valid draft scene. No media was generated.",
      commands: [
        { op: "scene.add", id, title: clean.split(/\s+/).slice(0, 5).join(" "), seconds: 6 },
        { op: "shot.add", scene: id, id: `${id}-shot-1`, at: 0, action: clean },
        { op: "clip.add", id: `clip-${id}`, scene: id },
      ],
    };
  }
  return { kind: "answer", content: `I reviewed the project context. A safe next step is to refine “${clean.slice(0, 72)}” into a shot brief before generation.` };
}

function executeDemoCommands(config: ProjectConfig, commands: ProjectCommand[]): ProjectConfig {
  const next = structuredClone(config);
  const now = new Date().toISOString();
  const scene = (id: string): GenerationJob => {
    const found = next.generationJobs.find((job) => job.id === id);
    if (!found) throw new Error(`Scene '${id}' was not found.`);
    return found;
  };
  const milliseconds = (seconds: number, field: string, allowZero: boolean) => {
    if (!Number.isFinite(seconds) || seconds < 0 || (!allowZero && seconds <= 0)) throw new Error(`${field} must be ${allowZero ? "non-negative" : "positive"} finite seconds.`);
    const value = Math.round(seconds * 1000);
    if (!Number.isSafeInteger(value) || (!allowZero && value < 1)) throw new Error(`${field} is outside the supported range.`);
    return value;
  };
  const clipLocation = (id: string) => next.timeline.tracks.flatMap((track, trackIndex) =>
    track.clips.map((clip, clipIndex) => ({ track, trackIndex, clip, clipIndex })))
    .find((item) => item.clip.id === id);
  const targetTrack = (id?: string) => {
    const track = id
      ? next.timeline.tracks.find((candidate) => candidate.id === id)
      : next.timeline.tracks.find((candidate) => candidate.kind === "video" && !candidate.locked);
    if (!track) throw new Error(id ? `Track '${id}' was not found.` : "No unlocked video track is available.");
    if (track.locked) throw new Error(`Track '${track.id}' is locked.`);
    return track;
  };
  const validateSource = (clip: TimelineClip) => {
    const asset = next.assets.find((candidate) => candidate.id === clip.assetId);
    if (!asset) throw new Error(`Asset '${clip.assetId}' was not found.`);
    if (asset.kind !== "image" && asset.durationMs && clip.sourceStartMs + clip.durationMs > asset.durationMs) {
      throw new Error(`Clip source range extends past asset '${asset.id}'.`);
    }
  };
  for (const command of commands) {
    switch (command.op) {
      case "project.set":
        if (command.name !== undefined) next.name = command.name;
        if (command.prompt !== undefined) next.brief.prompt = command.prompt;
        if (command.targetSeconds !== undefined) next.brief.targetDurationSeconds = command.targetSeconds;
        if (command.aspectRatio !== undefined) {
          next.settings.aspectRatio = command.aspectRatio as ProjectConfig["settings"]["aspectRatio"];
          next.brief.aspectRatio = command.aspectRatio as ProjectConfig["brief"]["aspectRatio"];
        }
        if (command.resolution !== undefined) {
          next.settings.resolution = command.resolution as ProjectConfig["settings"]["resolution"];
          next.brief.resolution = command.resolution as ProjectConfig["brief"]["resolution"];
        }
        if (command.frameRate !== undefined) next.settings.frameRate = command.frameRate as ProjectConfig["settings"]["frameRate"];
        if (command.backgroundColor !== undefined) next.settings.backgroundColor = command.backgroundColor;
        break;
      case "ref.add":
        if (next.references.some((reference) => reference.id === command.id)) throw new Error(`Reference '${command.id}' already exists.`);
        next.references.push({ id: command.id, kind: "text", name: command.name, description: command.text, intendedUse: command.use as ProjectConfig["references"][number]["intendedUse"], createdAt: now });
        break;
      case "ref.set": {
        const reference = next.references.find((candidate) => candidate.id === command.id);
        if (!reference) throw new Error(`Reference '${command.id}' was not found.`);
        if (command.name !== undefined) reference.name = command.name;
        if (command.text !== undefined) { reference.description = command.text; reference.content = null; }
        if (command.use !== undefined) reference.intendedUse = command.use as typeof reference.intendedUse;
        break;
      }
      case "ref.remove": {
        const token = `@[ref:${command.id}]`;
        if (next.generationJobs.some((job) => job.startFrameReferenceId === command.id || job.shots?.some((shot) => shot.action.includes(token)))) {
          throw new Error(`Reference '${command.id}' is still used by a scene.`);
        }
        const at = next.references.findIndex((reference) => reference.id === command.id);
        if (at < 0) throw new Error(`Reference '${command.id}' was not found.`);
        next.references.splice(at, 1);
        next.generationJobs.forEach((job) => { job.referenceIds = job.referenceIds.filter((id) => id !== command.id); });
        break;
      }
      case "scene.add": {
        if (next.generationJobs.some((job) => job.id === command.id)) throw new Error(`Scene '${command.id}' already exists.`);
        const job = createDraftGenerationJob("", { id: command.id, title: command.title, durationSeconds: command.seconds, steps: command.steps ?? loadDefaultGenerationSteps(), seed: command.seed, now });
        job.shots = [];
        job.prompt = "";
        job.creativeBrief = "";
        job.soundscape = command.sound;
        job.music = command.music;
        job.startFrameReferenceId = command.startFrame;
        next.generationJobs.push(job);
        break;
      }
      case "scene.set": {
        const job = scene(command.id);
        if (command.title !== undefined) job.title = command.title;
        if (command.seconds !== undefined) job.durationSeconds = command.seconds;
        if (command.steps !== undefined) job.steps = command.steps;
        if (command.seed !== undefined) job.seed = command.seed;
        if ("sound" in command) job.soundscape = command.sound;
        if ("music" in command) job.music = command.music;
        if ("startFrame" in command) job.startFrameReferenceId = command.startFrame;
        job.updatedAt = now;
        break;
      }
      case "scene.remove": {
        const at = next.generationJobs.findIndex((job) => job.id === command.id);
        if (at < 0) throw new Error(`Scene '${command.id}' was not found.`);
        next.generationJobs.splice(at, 1);
        break;
      }
      case "scene.move": {
        const at = next.generationJobs.findIndex((job) => job.id === command.id);
        if (at < 0) throw new Error(`Scene '${command.id}' was not found.`);
        const [moving] = next.generationJobs.splice(at, 1);
        const destination = command.before == null ? next.generationJobs.length : next.generationJobs.findIndex((job) => job.id === command.before);
        if (destination < 0) throw new Error(`Destination scene '${command.before}' was not found.`);
        next.generationJobs.splice(destination, 0, moving);
        break;
      }
      case "shot.add": {
        const job = scene(command.scene);
        const shots = job.shots ?? (job.shots = []);
        if (shots.some((shot) => shot.id === command.id)) throw new Error(`Shot '${command.id}' already exists.`);
        shots.push({ id: command.id, name: command.name, startSeconds: command.at, action: command.action, speech: command.speech, speechLanguage: command.language, settings: command.settings });
        job.updatedAt = now;
        break;
      }
      case "shot.set": {
        const job = scene(command.scene);
        const shot = job.shots?.find((candidate) => candidate.id === command.id);
        if (!shot) throw new Error(`Shot '${command.id}' was not found in scene '${command.scene}'.`);
        if (command.at !== undefined) shot.startSeconds = command.at;
        if (command.action !== undefined) shot.action = command.action;
        if ("name" in command) shot.name = command.name;
        if ("speech" in command) shot.speech = command.speech;
        if ("language" in command) shot.speechLanguage = command.language;
        if ("settings" in command) shot.settings = command.settings;
        job.updatedAt = now;
        break;
      }
      case "shot.remove": {
        const job = scene(command.scene);
        const at = job.shots?.findIndex((shot) => shot.id === command.id) ?? -1;
        if (at < 0) throw new Error(`Shot '${command.id}' was not found in scene '${command.scene}'.`);
        job.shots!.splice(at, 1);
        job.updatedAt = now;
        break;
      }
      case "clip.add": {
        if (clipLocation(command.id)) throw new Error(`Clip '${command.id}' already exists.`);
        if (Boolean(command.scene) === Boolean(command.asset)) throw new Error("Exactly one of scene or asset is required.");
        let asset: ProjectAsset;
        let defaultDurationMs: number;
        let status: TimelineClip["status"];
        if (command.scene) {
          const job = scene(command.scene);
          const plannedId = `asset-${job.id}`;
          const existing = next.assets.find((candidate) => candidate.id === plannedId)
            ?? next.assets.find((candidate) => Boolean(job.outputRelativePath) && candidate.kind === "generated" && candidate.relativePath === job.outputRelativePath);
          defaultDurationMs = Math.max(Math.round(1000 / next.settings.frameRate), Math.round((job.durationSeconds ?? 6) * 1000));
          asset = existing ?? {
            id: plannedId,
            kind: "generated",
            name: job.title,
            relativePath: job.outputRelativePath ?? null,
            sourcePath: null,
            mimeType: "video/mp4",
            durationMs: defaultDurationMs,
            width: null,
            height: null,
            createdAt: job.createdAt,
          };
          if (!existing) next.assets.push(asset);
          status = job.status === "completed" && Boolean(job.outputRelativePath) ? "generated" : "draft";
        } else {
          const existing = next.assets.find((candidate) => candidate.id === command.asset);
          if (!existing) throw new Error(`Asset '${command.asset}' was not found.`);
          asset = existing;
          if (asset.kind === "caption") throw new Error(`Asset '${asset.id}' cannot be placed on an audiovisual track.`);
          defaultDurationMs = Math.max(1, asset.durationMs ?? 5_000);
          status = "approved";
        }
        const track = targetTrack(command.track);
        if (command.scene && track.kind !== "video") throw new Error(`Scene clips require a video track, not '${track.id}'.`);
        const startMs = command.at === undefined
          ? track.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0)
          : milliseconds(command.at, "Clip start", true);
        const clip: TimelineClip = {
          id: command.id,
          assetId: asset.id,
          trackId: track.id,
          startMs,
          durationMs: command.seconds === undefined ? defaultDurationMs : milliseconds(command.seconds, "Clip duration", false),
          sourceStartMs: command.sourceAt === undefined ? 0 : milliseconds(command.sourceAt, "Clip source start", true),
          label: command.label ?? asset.name,
          color: null,
          status,
        };
        if (!clip.label.trim()) throw new Error("Clip label cannot be empty.");
        validateSource(clip);
        track.clips.push(clip);
        break;
      }
      case "clip.set": {
        if (command.track === undefined && command.at === undefined && command.seconds === undefined && command.sourceAt === undefined && command.label === undefined) throw new Error("Clip command has no fields to change.");
        const location = clipLocation(command.id);
        if (!location) throw new Error(`Clip '${command.id}' was not found.`);
        if (location.track.locked) throw new Error(`Track '${location.track.id}' is locked.`);
        const track = command.track === undefined ? location.track : targetTrack(command.track);
        const clip = { ...location.clip };
        if (command.at !== undefined) clip.startMs = milliseconds(command.at, "Clip start", true);
        if (command.seconds !== undefined) clip.durationMs = milliseconds(command.seconds, "Clip duration", false);
        if (command.sourceAt !== undefined) clip.sourceStartMs = milliseconds(command.sourceAt, "Clip source start", true);
        if (command.label !== undefined) clip.label = command.label;
        if (!clip.label.trim()) throw new Error("Clip label cannot be empty.");
        validateSource(clip);
        clip.trackId = track.id;
        location.track.clips.splice(location.clipIndex, 1);
        track.clips.push(clip);
        break;
      }
      case "clip.remove": {
        const location = clipLocation(command.id);
        if (!location) throw new Error(`Clip '${command.id}' was not found.`);
        if (location.track.locked) throw new Error(`Track '${location.track.id}' is locked.`);
        location.track.clips.splice(location.clipIndex, 1);
        next.generationJobs.forEach((job) => { if (job.clipId === command.id) job.clipId = null; });
        break;
      }
    }
  }
  const knownReferences = new Set(next.references.map((reference) => reference.id));
  const changedScenes = new Set(commands.flatMap((command) =>
    command.op === "shot.add" || command.op === "shot.set" || command.op === "shot.remove" ? [command.scene] : []));
  next.generationJobs.forEach((job) => {
    if (!changedScenes.has(job.id) || !job.shots) return;
    job.shots.sort((left, right) => left.startSeconds - right.startSeconds);
    const text = sceneBriefText(job.shots as SceneShot[]);
    job.prompt = text;
    job.creativeBrief = text;
    job.shotTags = null;
    job.shots.flatMap((shot) => actionReferenceIds(shot.action)).forEach((id) => {
      if (knownReferences.has(id) && !job.referenceIds.includes(id)) job.referenceIds.push(id);
    });
  });
  return parseProjectConfig(next);
}
