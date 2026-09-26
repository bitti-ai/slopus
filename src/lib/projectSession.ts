import { describeDiagnosticError, writeDiagnostic } from "./diagnostics";
import type { ProjectConfig, ProjectRecord } from "./project";
import { saveImageDraft } from "./imageHistory";
import { createUndoStack, type UndoStack } from "./undo";

export type ProjectUpdate = ProjectConfig | ((current: ProjectConfig) => ProjectConfig);
export type ProjectWriter = (record: ProjectRecord) => Promise<ProjectRecord | void>;

export interface ProjectSessionState {
  config: ProjectConfig;
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** When the file on disk last matched a save: this session's last successful
   *  save, or the document's own `updatedAt` (stamped when it was written) for
   *  a project that has not been saved since it was opened. Null if unknown. */
  savedAt: number | null;
}

/* ── Undo ──────────────────────────────────────────────────────────────────
   Two kinds of change reach a project document:

   • EDITS — what the person does: a clip moved, a scene retitled, a
     reference added, the agent's commands applied. They go through `edit()`
     and each one is an undo step (rapid edits with the same key coalesce, so
     typing a title or dragging a clip is one step, not two hundred).
   • BACKGROUND updates — what the app does on its own: the work queue
     writing a generation's status and output, the icon worker attaching an
     icon, a view recording a measured duration. They go through `update()`
     and are never undone: pressing Ctrl+Z must not un-render a video.

   The history holds whole snapshots, so an undo on its own would also roll
   back every background update made since the snapshot was taken. To stop
   that, every background update is kept in a short log, and undo and redo
   replay the ones made after the restored snapshot on top of it. The
   background writers all pass updater functions that patch by id (and check
   the thing they patch still exists), which is what makes a replay onto an
   older document safe. A plain value from the background cannot be replayed
   and is simply not logged. */

interface HistoryEntry {
  config: ProjectConfig;
  /** The background log position when this snapshot was the present. */
  mark: number;
}

interface BackgroundChange {
  seq: number;
  apply: (current: ProjectConfig) => ProjectConfig;
}

/** Background updates kept for replay. A progress tick is one entry, so this
 *  is sized for a long render session, not for a handful of saves. */
const BACKGROUND_LOG_LIMIT = 20_000;

/** The editable document and its ordered writes outlive any workspace view. */
export class ProjectSession {
  private state: ProjectSessionState;
  private listeners = new Set<() => void>();
  private writes = Promise.resolve();
  private revision = 0;
  private pending = 0;
  private savedConfig: ProjectConfig;
  private history: UndoStack<HistoryEntry> = createUndoStack<HistoryEntry>({ limit: 100, mergeWindowMs: 500 });
  private background: BackgroundChange[] = [];
  private backgroundSeq = 0;
  constructor(readonly record: ProjectRecord, private writer: ProjectWriter) {
    this.savedConfig = record.config;
    const config = saveImageDraft(record.config);
    const stamped = Date.parse(record.config.updatedAt);
    this.state = { config, dirty: config !== record.config, saving: false, saveError: null, canUndo: false, canRedo: false, savedAt: Number.isFinite(stamped) ? stamped : null };
    this.history.subscribe(() => {
      if (this.history.canUndo !== this.state.canUndo || this.history.canRedo !== this.state.canRedo) {
        this.publish({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
      }
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ProjectSessionState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private apply(config: ProjectConfig, dirty: boolean) {
    if (dirty) this.revision += 1;
    this.publish({ config, dirty: this.state.dirty || dirty });
  }

  /** A change the app makes on its own. Never an undo step (see above). */
  update = (next: ProjectUpdate, dirty = true) => {
    const config = saveImageDraft(typeof next === "function" ? next(this.state.config) : next);
    if (config === this.state.config) return;
    if (typeof next === "function") {
      this.backgroundSeq += 1;
      this.background.push({ seq: this.backgroundSeq, apply: next });
      if (this.background.length > BACKGROUND_LOG_LIMIT) this.background.splice(0, this.background.length - BACKGROUND_LOG_LIMIT);
    }
    this.apply(config, dirty);
  };

  /** A change the person made: recorded for undo. Same `key` within 500ms = one step. */
  edit = (next: ProjectUpdate, key = "edit") => {
    const config = saveImageDraft(typeof next === "function" ? next(this.state.config) : next);
    if (config === this.state.config) return;
    this.history.record({ config: this.state.config, mark: this.backgroundSeq }, key);
    this.apply(config, true);
  };

  /** Ends a coalescing run, e.g. on pointer up, so the next edit is its own step. */
  sealHistory = () => this.history.seal();

  /** Replays the background updates made after `entry` was the present onto it. */
  private restore(entry: HistoryEntry): ProjectConfig {
    let config = entry.config;
    for (const change of this.background) {
      if (change.seq <= entry.mark) continue;
      try { config = change.apply(config); } catch { /* A patch whose target is gone is simply skipped. */ }
    }
    return saveImageDraft(config);
  }

  undo = (): boolean => {
    const previous = this.history.undo({ config: this.state.config, mark: this.backgroundSeq });
    if (!previous) return false;
    this.apply(this.restore(previous), true);
    return true;
  };

  redo = (): boolean => {
    const next = this.history.redo({ config: this.state.config, mark: this.backgroundSeq });
    if (!next) return false;
    this.apply(this.restore(next), true);
    return true;
  };

  dismissError = () => this.publish({ saveError: null });
  discard = async (): Promise<void> => {
    await this.writes;
    this.revision += 1;
    this.history.clear();
    this.background = [];
    this.publish({ config: this.savedConfig, dirty: false, saveError: null });
  };
  save = (): Promise<void> => {
    const revision = this.revision;
    const record = { ...this.record, config: this.state.config };
    this.pending += 1;
    this.publish({ saving: true, saveError: null });
    const write = this.writes.catch(() => undefined).then(() => this.writer(record));
    this.writes = write.then(() => undefined, () => undefined);
    return write.then(() => {
      this.savedConfig = record.config;
      this.publish(this.revision === revision ? { dirty: false, savedAt: Date.now() } : { savedAt: Date.now() });
    }).catch((reason) => {
      const detail = describeDiagnosticError(reason);
      this.publish({ saveError: detail });
      writeDiagnostic("error", "project-session", "project.save_failed", detail, { projectId: record.config.id, folderPath: record.folderPath });
      throw reason;
    }).finally(() => {
      this.pending -= 1;
      if (this.pending === 0) this.publish({ saving: false });
    });
  };
}
