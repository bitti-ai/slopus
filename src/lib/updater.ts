import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./persistence";

type Stage = "disabled" | "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "restart";
interface UpdaterState {
  stage: Stage;
  version: string | null;
  notes: string;
  downloaded: number;
  total: number | undefined;
  error: string | null;
}
type UpdateHandle = Pick<Update, "version" | "body" | "download" | "install" | "close">;
interface UpdaterDependencies {
  enabled: () => Promise<boolean>;
  check: () => Promise<UpdateHandle | null>;
  relaunch: () => Promise<void>;
}
const native: UpdaterDependencies = {
  enabled: async () => isTauri() && await invoke<boolean>("app_updater_enabled"),
  check: () => check({ timeout: 15_000 }),
  relaunch,
};
const describe = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** App-owned state survives Settings closing and React StrictMode effects. */
export class AppUpdater {
  private state: UpdaterState = { stage: "disabled", version: null, notes: "", downloaded: 0, total: undefined, error: null };
  private listeners = new Set<() => void>();
  private update: UpdateHandle | null = null;
  private started = false;
  private busy = false;
  constructor(private dependencies: UpdaterDependencies = native) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<UpdaterState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  start = async () => {
    if (this.started) return;
    this.started = true;
    try {
      if (!await this.dependencies.enabled()) return;
      this.publish({ stage: "idle" });
      await this.check();
    } catch (reason) {
      this.publish({ error: describe(reason) });
    }
  };
  check = async () => {
    if (this.busy || this.state.stage === "disabled" || this.state.stage === "restart") return;
    this.busy = true;
    this.publish({ stage: "checking", error: null });
    try {
      if (this.update) await this.update.close();
      this.update = null;
      this.publish({ version: null, notes: "" });
      this.update = await this.dependencies.check();
      this.publish({ stage: this.update ? "available" : "current", version: this.update?.version ?? null, notes: this.update?.body ?? "" });
    } catch (reason) {
      this.publish({ stage: this.update ? "available" : "idle", error: `Could not check for updates. ${describe(reason)}` });
    } finally { this.busy = false; }
  };
  install = async (blockReason: () => string | null) => {
    if (this.busy || !this.update || this.state.stage !== "available") return;
    const blocked = blockReason();
    if (blocked) { this.publish({ error: blocked }); return; }
    this.busy = true;
    this.publish({ stage: "downloading", error: null, downloaded: 0, total: undefined });
    let installed = false;
    try {
      await this.update.download((event) => {
        if (event.event === "Started") this.publish({ total: event.data.contentLength });
        if (event.event === "Progress") this.publish({ downloaded: this.state.downloaded + event.data.chunkLength });
      }, { timeout: 120_000 });
      // A background job may have started while the download was in flight.
      const nowBlocked = blockReason();
      if (nowBlocked) throw new Error(nowBlocked);
      this.publish({ stage: "installing" });
      await this.update.install();
      installed = true;
      this.publish({ stage: "restart" });
      await this.dependencies.relaunch();
    } catch (reason) {
      this.publish({ stage: installed ? "restart" : "available", error: describe(reason) });
    } finally { this.busy = false; }
  };
  restart = async (blockReason: () => string | null) => {
    if (this.busy || this.state.stage !== "restart") return;
    const blocked = blockReason();
    if (blocked) { this.publish({ error: blocked }); return; }
    this.busy = true;
    this.publish({ error: null });
    try { await this.dependencies.relaunch(); }
    catch (reason) { this.publish({ error: describe(reason) }); }
    finally { this.busy = false; }
  };
}
