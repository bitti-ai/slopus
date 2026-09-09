import { useSyncExternalStore } from "react";
import type { AppUpdater } from "../lib/updater";

export function UpdatePanel({ updater, blockReason }: { updater: AppUpdater; blockReason: () => string | null }) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  const busy = ["checking", "downloading", "installing"].includes(state.stage);
  const blocked = blockReason();
  return <div className="update-panel">
    <h2>App updates</h2>
    <p>Slopus checks for updates each time it starts. You choose when to install and restart.</p>
    <p role="status">{state.stage === "disabled" ? "Updates are available in installed release builds. Download a new portable version to update a portable copy."
      : state.stage === "checking" ? "Checking for updates…"
      : state.stage === "current" ? "You’re up to date."
      : state.stage === "restart" ? "Update installed. Restart Slopus to finish."
      : state.version ? `Slopus ${state.version} is available.` : "Check for a new version of Slopus."}</p>
    {state.notes && <pre className="update-panel__notes">{state.notes}</pre>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.version && blocked && <p>{blocked}</p>}
    <div className="update-panel__actions">
      <button type="button" className="secondary-button" disabled={busy || state.stage === "disabled" || state.stage === "restart"} onClick={() => void updater.check()}>Check for updates</button>
      {state.version && state.stage !== "restart" && <button type="button" className="primary-button" disabled={busy || Boolean(blocked)} onClick={() => void updater.install(blockReason)}>Install and restart</button>}
      {state.stage === "restart" && <button type="button" className="primary-button" disabled={Boolean(blocked)} onClick={() => void updater.restart(blockReason)}>Restart Slopus</button>}
    </div>
  </div>;
}

export function UpdateProgress({ updater }: { updater: AppUpdater }) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  if (state.stage !== "downloading" && state.stage !== "installing") return null;
  const percent = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : undefined;
  return <div className="update-progress" role="dialog" aria-modal="true" aria-label="Updating Slopus" tabIndex={-1} ref={(node) => node?.focus()} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Tab") event.preventDefault(); }}>
    <div className="update-panel">
      <h2>{state.stage === "downloading" ? "Downloading update…" : "Installing update…"}</h2>
      <p role="status">{state.stage === "downloading" ? (percent === undefined ? `${(state.downloaded / 1048576).toFixed(1)} MB downloaded` : `${percent}% downloaded`) : "Slopus will restart when the update is ready."}</p>
      <progress aria-label="Update download" max={100} value={state.stage === "downloading" ? percent : undefined} />
    </div>
  </div>;
}
