import { describeDiagnosticError } from "./diagnostics";
import { releaseRendered } from "./generatedVideo";
import { isTauri } from "./persistence";
import type { ProjectSession } from "./projectSession";
import { referenceImages, type ProjectReference } from "./project";
import { needsReferenceIcon, referenceIconPrompt, REFERENCE_ICON_RENDER_SIZE, REFERENCE_ICON_STEPS } from "./referenceIcons";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, saveReferenceIcon } from "./runtime";
import { withEngineSettings } from "./settings";
import { loadReferenceIconAutomation, saveReferenceIconAutomation, subscribeReferenceIconAutomation } from "./referenceIconSettings";
import type { WorkItem } from "./workQueue";
import { hasPresetIcon, REFERENCE_PRESETS, type ReferencePreset } from "./reference-presets";
import { saveBuiltinIcon } from "./builtinReferenceIcons";

type TaskStatus = "queued" | "generating" | "saving" | "completed" | "failed" | "cancelled" | "skipped";
interface IconTask {
  key: string;
  session: ProjectSession;
  preset?: ReferencePreset;
  yielded?: boolean;
  referenceId: string;
  name: string;
  prompt: string;
  status: TaskStatus;
  nativeId?: string;
  submitted: boolean;
  cancelled: boolean;
  force?: boolean;
  approved?: boolean;
  error?: string;
  needsSave?: boolean;
  finish?: () => void;
}

/** One visible batch across projects. The owner runs only one icon at a time,
 * returning to its video-priority scheduler after each native result is freed. */
export class ReferenceIconWork {
  private tasks = new Map<string, IconTask>();
  private timers = new Map<ProjectSession, ReturnType<typeof setTimeout>>();
  private active?: IconTask;
  private progress = 0;
  private item?: WorkItem;
  private watches = new Map<ProjectSession, () => void>();
  private stopSettings?: () => void;

  constructor(private changed: (item: WorkItem) => void, private wake: () => void) {}

  watch(session: ProjectSession) {
    if (!isTauri() || this.watches.has(session)) return;
    this.stopSettings ??= subscribeReferenceIconAutomation(() => {
      this.watches.forEach((_stop, watched) => this.scan(watched));
      this.wake();
    });
    let references = session.getSnapshot().config.references;
    const schedule = () => {
      clearTimeout(this.timers.get(session));
      this.timers.set(session, setTimeout(() => {
        this.timers.delete(session);
        this.scan(session);
      }, 1000));
    };
    this.watches.set(session, session.subscribe(() => {
      const next = session.getSnapshot().config.references;
      if (next === references) return;
      references = next;
      schedule();
    }));
    schedule();
  }

  forget(session: ProjectSession) {
    clearTimeout(this.timers.get(session));
    this.timers.delete(session);
    this.watches.get(session)?.();
    this.watches.delete(session);
    for (const [key, task] of this.tasks) if (task.session === session && !task.preset) this.tasks.delete(key);
    this.publish();
  }

  stop() {
    this.stopSettings?.();
    this.stopSettings = undefined;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.watches.forEach((stop) => stop());
    this.watches.clear();
  }

  scan(session: ProjectSession) {
    const references = session.getSnapshot().config.references;
    for (const task of this.tasks.values()) {
      if (task.preset || task.session !== session || task.status !== "queued") continue;
      const reference = references.find((reference) => reference.id === task.referenceId);
      if (!reference || !this.shouldGenerate(reference, task) || (!task.force && loadReferenceIconAutomation() === "disabled")) task.status = "skipped";
    }
    let added = false;
    for (const reference of references) {
      const key = `${session.record.folderPath}::${session.record.config.id}::${reference.id}`;
      const prompt = referenceIconPrompt(reference);
      const previous = this.tasks.get(key);
      const force = previous?.force && previous.status === "skipped";
      if (!force && loadReferenceIconAutomation() === "disabled") continue;
      if (!this.shouldGenerate(reference, { force })) continue;
      if (previous && (previous === this.active || (previous.prompt === prompt && previous.status !== "skipped"))) continue;
      this.tasks.set(key, { key, session, referenceId: reference.id, name: reference.name, prompt, status: "queued", submitted: false, cancelled: false, force });
      added = true;
    }
    this.publish();
    if (added) this.wake();
  }

  enqueueBuiltins(session: ProjectSession, presets: readonly ReferencePreset[] = REFERENCE_PRESETS) {
    for (const preset of presets) {
      const key = `builtin::${preset.id}`;
      const previous = this.tasks.get(key);
      if (hasPresetIcon(preset) || (previous && ["queued", "generating", "saving"].includes(previous.status))) continue;
      this.tasks.set(key, { key, session, preset, referenceId: preset.id, name: preset.name, prompt: "", status: "queued", submitted: false, cancelled: false, force: true });
    }
    this.publish();
    this.wake();
  }

  private referenceFor(task: IconTask): ProjectReference | undefined {
    if (!task.preset) return task.session.getSnapshot().config.references.find((reference) => reference.id === task.referenceId);
    const preset = task.preset;
    return { id: preset.id, kind: "text", name: preset.name, description: preset.prompt,
      intendedUse: [preset.type], subcategory: preset.subcategory, createdAt: task.session.record.config.createdAt };
  }

  /** Interrupt a built-in icon so normal video work gets the GPU immediately
   * after native cancellation. The interrupted icon remains queued to retry. */
  yieldToVideo() {
    const task = this.active;
    if (!task?.preset || task.status !== "generating" || task.cancelled || task.yielded) return;
    task.yielded = true;
    if (task.submitted) void this.cancelForVideo(task);
    this.publish();
  }

  private async cancelForVideo(task: IconTask) {
    try { await cancelSlopfabGeneration(task.nativeId!); }
    catch (reason) { task.yielded = false; task.error = describeDiagnosticError(reason); this.publish(); }
  }

  private shouldGenerate(reference: ProjectReference, task: { force?: boolean }) {
    return task.force ? Boolean(reference.description.trim()) && referenceImages(reference).length === 0 : needsReferenceIcon(reference);
  }

  isPending(session: ProjectSession, referenceId: string) {
    return [...this.tasks.values()].some((task) => task.session === session && task.referenceId === referenceId && ["queued", "generating", "saving"].includes(task.status));
  }

  regenerate(session: ProjectSession, referenceId: string) {
    const reference = session.getSnapshot().config.references.find((reference) => reference.id === referenceId);
    if (!reference || !this.shouldGenerate(reference, { force: true }) || this.isPending(session, referenceId)) return;
    const key = `${session.record.folderPath}::${session.record.config.id}::${reference.id}`;
    this.tasks.set(key, { key, session, referenceId, name: reference.name, prompt: referenceIconPrompt(reference), status: "queued", submitted: false, cancelled: false, force: true });
    this.publish();
    this.wake();
  }

  hasQueued() { return [...this.tasks.values()].some((task) => task.status === "queued"); }
  private canRun(task: IconTask) {
    const automation = loadReferenceIconAutomation();
    return task.status === "queued" && (task.force || automation === "enabled" || (automation === "ask" && task.approved));
  }
  hasRunnable() { return [...this.tasks.values()].some((task) => this.canRun(task)); }
  private awaitingConfirmation() {
    return loadReferenceIconAutomation() === "ask"
      ? [...this.tasks.values()].filter((task) => task.status === "queued" && !task.force && !task.approved)
      : [];
  }
  confirmationCount() { return this.awaitingConfirmation().length; }
  answerConfirmation(confirmed: boolean, remember: boolean) {
    for (const task of this.awaitingConfirmation()) {
      if (confirmed) task.approved = true;
      else { task.status = "cancelled"; task.cancelled = true; }
    }
    if (remember) saveReferenceIconAutomation(confirmed ? "enabled" : "disabled");
    this.publish();
    this.wake();
  }
  hasActiveProject(session: ProjectSession) {
    return [...this.tasks.values()].some((task) => !task.preset && task.session === session && ["queued", "generating", "saving"].includes(task.status));
  }
  owns(id: string) { return this.item?.id === id; }
  clearFinished(id: string) { if (this.owns(id)) this.item = undefined; }

  private publish() {
    if (this.hasQueued() && !this.item) {
      this.item = {
        id: `icons-${crypto.randomUUID()}`, kind: "reference-icons", projectKey: "", folderPath: "", projectName: "", sceneId: "",
        title: "Reference icons", submittedAt: new Date().toISOString(), status: "queued", progress: 0,
        detail: "Waiting to generate icons", error: null, completionAt: null, cancelling: false, needsSave: false,
        settings: { frames: 1, steps: REFERENCE_ICON_STEPS, seed: -1, canvasWidth: REFERENCE_ICON_RENDER_SIZE, canvasHeight: REFERENCE_ICON_RENDER_SIZE },
      };
    }
    if (!this.item) return;
    const tasks = [...this.tasks.values()].filter((task) => task.status !== "skipped");
    const completed = tasks.filter((task) => task.status === "completed").length;
    const settled = tasks.filter((task) => ["completed", "failed", "cancelled"].includes(task.status)).length;
    const queued = this.hasQueued();
    const failed = tasks.filter((task) => task.status === "failed");
    const projects = new Set(tasks.map((task) => task.session));
    this.item = {
      ...this.item,
      projectName: tasks.every((task) => task.preset) ? "Built-in references" : projects.size === 1 ? [...projects][0].getSnapshot().config.name : `${projects.size} projects`,
      status: this.active ? (this.active.status === "saving" ? "encoding" : "generating") : queued ? "queued" : failed.length ? "failed" : tasks.some((task) => task.status === "cancelled") ? "cancelled" : "completed",
      progress: tasks.length ? Math.min(1, (settled + (this.active ? this.progress : 0)) / tasks.length) : 1,
      detail: this.active ? `${this.active.yielded ? "Pausing for video" : this.active.cancelled ? "Cancelling" : this.active.status === "saving" ? "Saving" : "Generating"} ${this.active.name} · ${completed}/${tasks.length} icons saved`
        : this.confirmationCount() > 0 ? `${this.confirmationCount()} icons awaiting confirmation`
        : queued ? `${completed}/${tasks.length} icons saved · waiting behind videos` : `${completed}/${tasks.length} icons saved`,
      error: failed.length ? failed.map((task) => `${task.name}: ${task.error}`).join("\n") : null,
      cancelling: this.active?.cancelled ?? false,
      needsSave: tasks.some((task) => task.needsSave),
    };
    this.changed(this.item);
  }

  async runNext(ready: Promise<void>, videoWaiting: () => boolean) {
    const task = [...this.tasks.values()].find((task) => this.canRun(task));
    if (!task) return;
    this.active = task;
    task.submitted = false;
    task.yielded = false;
    task.status = "generating";
    this.progress = 0;
    this.publish();
    try {
      await ready;
      if (task.cancelled) return;
      if (!task.preset) await task.session.save();
      if (task.cancelled) return;
      if (videoWaiting()) { task.status = "queued"; return; }
      if (!task.force && loadReferenceIconAutomation() === "disabled") { task.status = "skipped"; return; }
      if (!task.force && !task.approved && loadReferenceIconAutomation() === "ask") { task.status = "queued"; return; }
      if (task.preset && hasPresetIcon(task.preset)) { task.status = "skipped"; return; }
      const reference = this.referenceFor(task);
      if (!reference || !this.shouldGenerate(reference, task)) { task.status = "skipped"; return; }
      task.prompt = referenceIconPrompt(reference);
      task.name = reference.name;
      task.nativeId = `icon-${crypto.randomUUID()}`;
      const done = new Promise<void>((resolve) => { task.finish = resolve; });
      await enqueueSlopfabGeneration({
        jobId: task.nativeId, prompt: task.prompt, stillImage: true, frames: 1,
        steps: REFERENCE_ICON_STEPS, seed: -1, canvasWidth: REFERENCE_ICON_RENDER_SIZE, canvasHeight: REFERENCE_ICON_RENDER_SIZE, referencePaths: [],
      }, withEngineSettings(task.session.getSnapshot().config));
      task.submitted = true;
      if (task.cancelled) await this.cancelNative(task);
      else if (task.yielded) await this.cancelForVideo(task);
      await done;
    } catch (reason) {
      task.status = task.cancelled ? "cancelled" : "failed";
      task.error = describeDiagnosticError(reason);
    } finally {
      if (task.cancelled) task.status = "cancelled";
      else if (task.yielded && task.status === "cancelled") { task.status = "queued"; task.error = undefined; }
      task.yielded = false;
      // Stop a built-in batch on an engine/storage failure instead of sending
      // the same failing setup through the entire catalog.
      if (task.preset && task.status === "failed") {
        for (const waiting of this.tasks.values()) if (waiting.preset && waiting.status === "queued") waiting.status = "cancelled";
      }
      this.active = undefined;
      this.publish();
      if (!task.preset) this.scan(task.session);
    }
  }

  progressEvent(event: { jobId: string; step: number; totalSteps: number }): boolean {
    if (!this.active || this.active.nativeId !== event.jobId) return false;
    this.progress = Math.max(this.progress, event.totalSteps > 0 ? Math.min(0.9, 0.1 + event.step / event.totalSteps * 0.8) : 0.05);
    this.publish();
    return true;
  }

  event(event: { jobId: string; state: string; detail: string }): boolean {
    const task = this.active;
    if (!task || task.nativeId !== event.jobId) return false;
    if (task.status === "saving") return true;
    if (event.state === "framesReady") {
      task.status = "saving";
      this.publish();
      void this.save(task);
    } else if (event.state === "failed" || event.state === "cancelled") {
      task.status = task.cancelled || event.state === "cancelled" ? "cancelled" : "failed";
      task.error = event.detail;
      task.finish?.();
    }
    return true;
  }

  private async save(task: IconTask) {
    try {
      const reference = this.referenceFor(task);
      if (task.cancelled) { task.status = "cancelled"; return; }
      if (!reference || !this.shouldGenerate(reference, task) || referenceIconPrompt(reference) !== task.prompt) { task.status = "skipped"; return; }
      if (task.preset) {
        await saveBuiltinIcon(task.preset.id, task.nativeId!);
        task.status = "completed";
        return;
      }
      const iconRelativePath = await saveReferenceIcon(task.session.record.folderPath, task.nativeId!);
      let attached = false;
      task.session.update((current) => ({ ...current, references: current.references.map((reference) => {
        if (reference.id !== task.referenceId || !this.shouldGenerate(reference, task) || referenceIconPrompt(reference) !== task.prompt) return reference;
        attached = true;
        return { ...reference, iconRelativePath };
      }) }));
      if (!attached) { task.status = "skipped"; return; }
      task.needsSave = true;
      await task.session.save();
      task.needsSave = false;
      task.status = "completed";
    } catch (reason) {
      task.status = "failed";
      task.error = describeDiagnosticError(reason);
    } finally {
      try { await releaseRendered(task.nativeId!); }
      catch (reason) { task.status = "failed"; task.error = describeDiagnosticError(reason); }
      finally { task.finish?.(); }
    }
  }

  async cancel() {
    for (const task of this.tasks.values()) {
      if (task.status === "queued") { task.cancelled = true; task.status = "cancelled"; }
    }
    if (this.active && this.active.status !== "saving") {
      this.active.cancelled = true;
      if (this.active.submitted) await this.cancelNative(this.active);
    }
    this.publish();
  }
  private async cancelNative(task: IconTask) {
    try { await cancelSlopfabGeneration(task.nativeId!); }
    catch (reason) { task.cancelled = false; task.error = describeDiagnosticError(reason); }
  }
  async retrySave() {
    for (const task of this.tasks.values()) {
      if (!task.needsSave) continue;
      try { await task.session.save(); task.needsSave = false; task.status = "completed"; task.error = undefined; }
      catch (reason) { task.error = describeDiagnosticError(reason); }
    }
    this.publish();
  }
}
