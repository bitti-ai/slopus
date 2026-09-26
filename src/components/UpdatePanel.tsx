import { CheckCircle2, Download, RefreshCw, RotateCcw } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import type { AppUpdater } from "../lib/updater";
import { Expander, InfoBar, ProgressBar, ProgressRing } from "./ui";

type UpdaterState = ReturnType<AppUpdater["getSnapshot"]>;

/* Updates, the way Windows Update shows them: one header card with a status
   glyph, a one-line status ("You're up to date", "Slopus 1.2.3 is
   available"), when the last check was, and the one action that fits the
   state at the trailing edge. A download shows as a 3px bar inside that card
   — it no longer takes over the window. Release notes fold into a "What's
   new" expander under it.

   Props are unchanged from before the rework, so SettingsView can keep
   placing it as it did: <UpdatePanel updater={…} blockReason={…} />. */

export function lastCheckedLabel(time: number | null, now = Date.now()): string {
  if (time === null) return "Not checked yet";
  const when = new Date(time);
  const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(when);
  const today = new Date(now);
  const sameDay = when.getFullYear() === today.getFullYear() && when.getMonth() === today.getMonth() && when.getDate() === today.getDate();
  const day = sameDay ? "today" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(when);
  return `Last checked: ${day}, ${clock}`;
}

function percentOf(state: UpdaterState): number | undefined {
  return state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : undefined;
}

function downloadedLabel(state: UpdaterState): string {
  const percent = percentOf(state);
  return percent === undefined ? `${(state.downloaded / 1048576).toFixed(1)} MB downloaded` : `${percent}% downloaded`;
}

function statusTitle(state: UpdaterState): string {
  switch (state.stage) {
    case "disabled": return "Updates aren’t available in this copy";
    case "checking": return "Checking for updates…";
    case "current": return "You’re up to date";
    case "available": return `Slopus ${state.version} is available`;
    case "downloading": return `Downloading Slopus ${state.version ?? "update"}`;
    case "installing": return "Installing update…";
    case "restart": return "Restart to finish updating";
    default: return "Check for updates";
  }
}

export function UpdatePanel({ updater, blockReason }: { updater: AppUpdater; blockReason: () => string | null }) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  const busy = ["checking", "downloading", "installing"].includes(state.stage);
  const blocked = blockReason();
  const transferring = state.stage === "downloading" || state.stage === "installing";

  const glyph: ReactNode = state.stage === "checking" ? <ProgressRing size={32} aria-label="Checking for updates" />
    : state.stage === "current" ? <CheckCircle2 size={32} aria-hidden="true" />
      : state.stage === "restart" ? <RotateCcw size={32} aria-hidden="true" />
        : state.stage === "available" || transferring ? <Download size={32} aria-hidden="true" />
          : <RefreshCw size={32} aria-hidden="true" />;

  const action = state.stage === "disabled" || transferring ? null
    : state.stage === "restart"
      ? <button type="button" className="primary-button" disabled={Boolean(blocked)} onClick={() => void updater.restart(blockReason)}>Restart Slopus</button>
      : state.stage === "available"
        ? <button type="button" className="primary-button" disabled={busy || Boolean(blocked)} onClick={() => void updater.install(blockReason)}>Install and restart</button>
        : <button type="button" className="secondary-button" disabled={busy} onClick={() => void updater.check()}>Check for updates</button>;

  return (
    <div className="update-panel">
      <div className={`update-card update-card--${state.stage}`}>
        <span className="update-card__glyph">{glyph}</span>
        <div className="update-card__text" aria-live="polite">
          <h2 className="update-card__title">{statusTitle(state)}</h2>
          <span className="update-card__caption">
            {state.stage === "disabled"
              ? "Installed release builds update themselves. To update a portable copy, download the new version."
              : state.stage === "installing" ? "Slopus restarts when the update is ready."
                : lastCheckedLabel(state.lastChecked)}
          </span>
          {state.stage === "downloading" && <>
            <span className="update-card__caption update-card__progress-label">{downloadedLabel(state)}</span>
            <ProgressBar value={percentOf(state)} aria-label="Update download" className="update-card__progress" />
          </>}
          {state.stage === "installing" && <ProgressBar aria-label="Installing update" className="update-card__progress" />}
        </div>
        {action && <div className="update-card__action">{action}</div>}
      </div>
      {state.error && <InfoBar severity="error" title="Update failed" message={state.error} />}
      {state.version && blocked && state.stage !== "restart" && !transferring && <InfoBar severity="warning" message={blocked} />}
      {state.stage === "restart" && blocked && <InfoBar severity="warning" message={blocked} />}
      {state.notes && (
        <Expander header="What’s new" description={state.version ? `Slopus ${state.version}` : undefined} className="update-panel__notes-expander">
          <pre className="update-panel__notes">{state.notes}</pre>
        </Expander>
      )}
    </div>
  );
}

/* The same updater state as a one-line InfoBar, for the top of the library:
   an available update, a download in progress, or a restart still owed. The
   full card lives in Settings > Updates; `onOpen` goes there. */
export function UpdateInfoBar({ updater, onOpen, onDismiss }: { updater: AppUpdater; onOpen: () => void; onDismiss?: () => void }) {
  const state = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  if (state.stage === "available") {
    return <InfoBar severity="informational" title="Update available" message={`Slopus ${state.version} is ready to install.`}
      action={<button type="button" className="secondary-button" onClick={onOpen}>View update</button>} onClose={onDismiss} />;
  }
  if (state.stage === "downloading" || state.stage === "installing") {
    return <InfoBar severity="informational" title={state.stage === "downloading" ? "Downloading update" : "Installing update"}
      message={state.stage === "downloading" ? downloadedLabel(state) : "Slopus restarts when the update is ready."} />;
  }
  if (state.stage === "restart") {
    return <InfoBar severity="success" title="Update installed" message="Restart Slopus to finish updating."
      action={<button type="button" className="secondary-button" onClick={onOpen}>Restart…</button>} />;
  }
  return null;
}

/** True when the title bar's Settings button should carry the update dot. */
export function updateNeedsAttention(stage: UpdaterState["stage"]): boolean {
  return stage === "available" || stage === "restart";
}
