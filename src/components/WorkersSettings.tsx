import { useEffect, useState, useSyncExternalStore } from "react";
import { Add20, Check14, Delete16, Desktop20, Refresh16, Spinner16, Worker20 } from "./ui/icons";
import { InfoBar, SettingsCard, SettingsGroup, TextField } from "./ui";
import {
  addWorker, getWorkerList, refreshWorkers, removeWorker, selectWorker, setWorkerToken, subscribeWorkers,
  type GenerationWorker,
} from "../lib/workers";

const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

function workerDescription(worker: GenerationWorker): string {
  if (!worker.online) return worker.error ?? "Offline";
  if (!worker.compatible) return `Runs Slopus ${worker.version ?? "of another version"}. Update it to match this app.`;
  const gpu = worker.gpus[0];
  return [
    worker.address,
    gpu && `${gpu.name} (${Math.ceil(gpu.memoryBytes / 1024 ** 3)} GB)`,
    worker.runtime?.state === "ready" ? worker.runtime.platform : worker.runtime?.detail,
  ].filter(Boolean).join(" · ");
}

function TokenField({ worker, onError }: { worker: GenerationWorker; onError: (message: string | null) => void }) {
  const [token, setToken] = useState("");
  return <span className="settings-worker-token">
    <TextField className="settings-field" type="password" aria-label={`${worker.name} access token`} value={token} autoComplete="off" spellCheck={false}
      placeholder={worker.hasToken ? "Token saved" : "Access token"} onChange={setToken} />
    <button type="button" className="secondary-button" disabled={!token.trim() || !worker.id}
      onClick={() => void setWorkerToken(worker.id!, token).then(() => { setToken(""); onError(null); }, (reason) => onError(message(reason)))}>Save</button>
  </span>;
}

/** Settings → Workers: generate on this computer or on a LAN worker. */
export function WorkersSetting({ desktop }: { desktop: boolean }) {
  const list = useSyncExternalStore(subscribeWorkers, getWorkerList);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState("");

  useEffect(() => {
    if (!desktop) return;
    const refresh = () => { void refreshWorkers().catch((reason) => setError(message(reason))); };
    refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => window.clearInterval(timer);
  }, [desktop]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try { await action(); } catch (reason) { setError(message(reason)); } finally { setBusy(null); }
  };

  const selectedId = list?.selectedId ?? null;
  const workers = list?.workers ?? [];
  const local = selectedId === null;
  const inUse = <span className="settings-worker-selected"><Check14 aria-hidden="true" /> In use</span>;

  return <>
    {error && <InfoBar severity="error" message={error} onClose={() => setError(null)} />}
    <SettingsGroup heading="Generate on">
      <p className="settings-caption">Run <code>slopus-worker</code> on another computer on this network and it appears here. Weights with download links are downloaded on the worker; other model files, references and images are sent from this computer. Finished videos and images are saved in this project as usual.</p>
      <SettingsCard icon={<Desktop20 />} header="This computer" description="Slopus generates with this computer’s GPU and weights">
        {local ? inUse : <button type="button" className="secondary-button" disabled={!desktop || busy !== null} onClick={() => void run("local", () => selectWorker(null))}>Use</button>}
      </SettingsCard>
      {workers.map((worker) => {
        const selected = worker.id !== null && worker.id === selectedId;
        const removable = worker.manual || (!worker.discovered && !worker.online);
        return <SettingsCard key={worker.key} icon={<Worker20 />} header={worker.name} description={workerDescription(worker)} className="settings-worker">
          {worker.requiresToken && worker.online && <TokenField worker={worker} onError={setError} />}
          {selected ? inUse : <button type="button" className="secondary-button" aria-label={`Use worker ${worker.name}`}
            disabled={!desktop || busy !== null || !worker.online || !worker.compatible || (worker.requiresToken && !worker.hasToken)}
            onClick={() => void run(worker.key, () => selectWorker(worker.id))}>{busy === worker.key ? <Spinner16 className="spin" /> : null}Use</button>}
          {removable && <button type="button" className="icon-button" disabled={busy !== null} aria-label={`Remove worker ${worker.name}`} data-tooltip="Remove worker"
            onClick={() => void run(worker.key, () => removeWorker(worker.key))}><Delete16 /></button>}
        </SettingsCard>;
      })}
      {selectedId && !workers.some((worker) => worker.id === selectedId) && <InfoBar severity="warning" message="The selected worker is not answering. Generation will fail until it is back, or until you choose another." />}
    </SettingsGroup>
    <SettingsGroup heading="Find workers">
      <SettingsCard icon={<Refresh16 />} header="Search the network" description="Workers announce themselves automatically on most home and office networks">
        <button type="button" className="secondary-button" disabled={!desktop || busy !== null} onClick={() => void run("refresh", refreshWorkers)}>
          {busy === "refresh" ? <Spinner16 className="spin" /> : null}Refresh
        </button>
      </SettingsCard>
      <SettingsCard icon={<Add20 />} header="Add by address" description="For networks where workers are not found automatically, for example 192.168.1.20 or worker-pc:47321">
        <TextField className="settings-field" aria-label="Worker address" value={address} spellCheck={false} placeholder="Address" onChange={setAddress} />
        <button type="button" className="secondary-button" disabled={!desktop || !address.trim() || busy !== null}
          onClick={() => void run("add", async () => { await addWorker(address); setAddress(""); })}>{busy === "add" ? <Spinner16 className="spin" /> : null}Add</button>
      </SettingsCard>
    </SettingsGroup>
  </>;
}
