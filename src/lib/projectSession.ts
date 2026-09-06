import { describeDiagnosticError, writeDiagnostic } from "./diagnostics";
import type { ProjectConfig, ProjectRecord } from "./project";

export type ProjectUpdate = ProjectConfig | ((current: ProjectConfig) => ProjectConfig);
export type ProjectWriter = (record: ProjectRecord) => Promise<ProjectRecord | void>;

/** The editable document and its ordered writes outlive any workspace view. */
export class ProjectSession {
  private state: { config: ProjectConfig; dirty: boolean; saving: boolean; saveError: string | null };
  private listeners = new Set<() => void>();
  private writes = Promise.resolve();
  private revision = 0;
  private pending = 0;
  constructor(readonly record: ProjectRecord, private writer: ProjectWriter) {
    this.state = { config: record.config, dirty: false, saving: false, saveError: null };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  update = (next: ProjectUpdate, dirty = true) => {
    const config = typeof next === "function" ? next(this.state.config) : next;
    if (config === this.state.config) return;
    if (dirty) this.revision += 1;
    this.publish({ config, dirty: this.state.dirty || dirty });
  };
  dismissError = () => this.publish({ saveError: null });
  save = (): Promise<void> => {
    const revision = this.revision;
    const record = { ...this.record, config: this.state.config };
    this.pending += 1;
    this.publish({ saving: true, saveError: null });
    const write = this.writes.catch(() => undefined).then(() => this.writer(record));
    this.writes = write.then(() => undefined, () => undefined);
    return write.then(() => {
      if (this.revision === revision) this.publish({ dirty: false });
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
