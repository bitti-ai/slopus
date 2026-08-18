import { invoke } from "@tauri-apps/api/core";
import { isTauri, saveProject } from "./persistence";
import { compileMiniMaxH3Prompt, parseProjectConfig, type GenerationJob, type ProjectConfig, type ProjectRecord } from "./project";
import { engineProviderSetting, loadEngineSettings, withEngineSettings, type EnginePathField } from "./settings";

export type ProviderId = "claude" | "codex";
export interface ProviderStatus {
  id: ProviderId;
  label: string;
  state: "ready" | "disabled" | "notInstalled" | "authRequired" | "unavailable";
  executable: string | null;
  version: string | null;
  detail: string;
}
export interface ModelStatus { id: string; configured: boolean; available: boolean; path: string | null }
export interface VidfabStatus {
  state: "ready" | "modelsMissing" | "runtimeMissing" | "incompatible" | "demo";
  dllPath: string;
  version: string | null;
  detail: string;
  models: ModelStatus[];
}
export interface RuntimeStatus { providers: ProviderStatus[]; vidfab: VidfabStatus }

export type AgentTurnResult =
  | { kind: "answer"; content: string }
  | { kind: "question"; content: string }
  | { kind: "mutation"; summary: string; project: ProjectConfig };

export interface AgentTurnResponse {
  result: AgentTurnResult;
  events: Array<{ type: string; text?: string }>;
  record: ProjectRecord;
}

export interface VidfabGenerationRequest {
  jobId: string;
  prompt: string;
  frames: number;
  steps: number;
  seed: number;
  aspectRatio: string;
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
  vidfab: { state: "demo", dllPath: "Browser demo", version: null, detail: "Deterministic plans only. No model runs or media files are created in the browser.", models: [] },
};

/* Every vidfab command is handed the project config with THIS machine's engine
   paths merged in (see lib/settings.ts). The merged copy is passed straight to
   the command and dropped; it is never the config that gets saved. */
export async function getRuntimeStatus(config: ProjectConfig): Promise<RuntimeStatus> {
  return isTauri() ? invoke<RuntimeStatus>("runtime_status", { config: withEngineSettings(config) }) : DEMO_STATUS;
}

/** Probes the engine paths on their own, with no project in hand — what the
 *  settings screen shows. */
export async function getEngineStatus(): Promise<VidfabStatus> {
  if (!isTauri()) return DEMO_STATUS.vidfab;
  return invoke<VidfabStatus>("vidfab_status", { settings: { vidfab: engineProviderSetting(loadEngineSettings()) } });
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

export async function runAgentTurn(record: ProjectRecord, provider: ProviderId, prompt: string, requestId: string): Promise<AgentTurnResponse> {
  const createdAt = new Date().toISOString();
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  if (isTauri()) {
    const response = await invoke<AgentTurnResponse>("run_agent_turn", { request: {
      requestId, folderPath: record.folderPath, provider, prompt, config: record.config,
      userMessageId, assistantMessageId, createdAt,
    } });
    return { ...response, record: { ...response.record, config: parseProjectConfig(response.record.config) } };
  }
  const result = demoTurn(record.config, prompt);
  const mutated = result.kind === "mutation" ? result.project : record.config;
  const config = parseProjectConfig({
    ...mutated,
    agentConversation: { messages: [
      ...mutated.agentConversation.messages,
      { id: userMessageId, role: "user", content: prompt.trim(), createdAt },
      { id: assistantMessageId, role: "assistant", content: result.kind === "mutation" ? result.summary : result.content, createdAt },
    ] },
  });
  const next = await saveProject({ ...record, config });
  return { result, record: next, events: [{ type: "started" }, { type: "completed" }] };
}

export async function cancelAgentTurn(requestId: string): Promise<boolean> {
  return isTauri() ? invoke<boolean>("cancel_agent_turn", { requestId }) : true;
}

export async function resolveVidfabPlan(request: VidfabGenerationRequest, config: ProjectConfig): Promise<ResolvedPlan> {
  if (isTauri()) return invoke<ResolvedPlan>("resolve_vidfab_plan", { request, config: withEngineSettings(config) });
  const [ratioWidth, ratioHeight] = request.aspectRatio.split(":").map(Number);
  const vertical = ratioHeight > ratioWidth;
  const alignedFrames = Math.ceil(Math.max(5, request.frames - 5) / 17) * 17 + 5;
  return {
    canvasWidth: vertical ? 768 : request.aspectRatio === "1:1" ? 768 : 1344,
    canvasHeight: vertical ? 1344 : 768,
    alignedFrames,
    durationSeconds: alignedFrames / config.settings.frameRate,
    modelEvaluations: request.steps - 1,
    sequenceRowsWithoutText: 0,
    latentFrames: Math.ceil(alignedFrames / 17), latentWidth: 0, latentHeight: 0,
    description: `Browser demo plan: ${alignedFrames} aligned frames at ${config.settings.frameRate} fps.`,
    boundary: "Deterministic plan only. No weights were opened and no media file was created.",
  };
}

export async function enqueueVidfabGeneration(request: VidfabGenerationRequest, config: ProjectConfig): Promise<void> {
  if (isTauri()) await invoke("enqueue_vidfab_generation", { request, config: withEngineSettings(config) });
}

export async function cancelVidfabGeneration(jobId: string): Promise<boolean> {
  return isTauri() ? invoke<boolean>("cancel_vidfab_generation", { jobId }) : true;
}

function demoTurn(config: ProjectConfig, prompt: string): AgentTurnResult {
  const clean = prompt.trim();
  if (/\b(which|what)\b.*\?/i.test(clean)) {
    return { kind: "question", content: "Should I apply that direction to the selected shot or to the full sequence?" };
  }
  if (/\b(add|create|queue|generate)\b.*\b(shot|clip)\b/i.test(clean)) {
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: `job-demo-${Date.now()}`, title: clean.split(/\s+/).slice(0, 5).join(" "), prompt: clean,
      status: "draft", stage: "queued", progress: 0, providerId: "minimax-h3", creativeBrief: clean,
      // Share the one compiler so the demo agent cannot drift from the guides.
      // Bound to no references, so it compiles to the T2VA three-field shape.
      compiledPrompt: compileMiniMaxH3Prompt(clean, []),
      referenceIds: [], createdAt: now, updatedAt: now,
    };
    const project = parseProjectConfig({ ...config, generationJobs: [job, ...config.generationJobs] });
    return { kind: "mutation", summary: "Added a schema-valid draft shot using the official MiniMax H3 prompt format. No media was generated.", project };
  }
  return { kind: "answer", content: `I reviewed the project context. A safe next step is to refine “${clean.slice(0, 72)}” into a shot brief before generation.` };
}
