import { useEffect, useRef, useState } from "react";
import { Checkbox, ContentDialog, InfoBar, SettingsCard } from "./ui";
import { Video20 } from "./ui/icons";
import { inTauri } from "../lib/nativeShell";
import { importGeneratorSlop, portableGenerator, serializeGeneratorSlop } from "../lib/slop";
import { openSlopFile, readBrowserSlopFile, saveSlopFile } from "../lib/slopFiles";
import type { GeneratorTemplate } from "../lib/settings";

export function GeneratorSharing({ templates }: { templates: GeneratorTemplate[] }) {
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choices = templates.map((template) => {
    try { portableGenerator(template); return { template, reason: null }; }
    catch (reason) { return { template, reason: reason instanceof Error ? reason.message : String(reason) }; }
  });
  const begin = () => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(null); setMessage(null); return true;
  };
  const finish = () => { pending.current = false; if (mounted.current) setBusy(false); };
  const fail = (reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); };
  const accept = (contents: string) => {
    if (!mounted.current) return;
    const imported = importGeneratorSlop(contents);
    setMessage(`Added ${imported.length} generator ${imported.length === 1 ? "template" : "templates"}.`);
  };
  const importFile = async () => {
    if (!inTauri()) { input.current?.click(); return; }
    if (!begin()) return;
    try { const contents = await openSlopFile(); if (contents !== null) accept(contents); }
    catch (reason) { fail(reason); } finally { finish(); }
  };
  const exportFile = async () => {
    if (!begin()) return;
    try {
      const chosen = templates.filter((template) => selected.includes(template.id));
      const contents = serializeGeneratorSlop(chosen);
      if (await saveSlopFile(contents, chosen.length === 1 ? chosen[0].name : "generators") && mounted.current) {
        setChoosing(false); setMessage(`Exported ${chosen.length} generator ${chosen.length === 1 ? "template" : "templates"}.`);
      }
    } catch (reason) { fail(reason); } finally { finish(); }
  };
  return <>
    <SettingsCard icon={<Video20 />} header="Share generator templates" description="Share download URLs and generator settings in a .slop file.">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void importFile()}>Import</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => {
        setError(null); setMessage(null); setSelected(choices.filter((choice) => !choice.reason).slice(0, 100).map(({ template }) => template.id)); setChoosing(true);
      }}>Export</button>
    </SettingsCard>
    <input ref={input} type="file" accept=".slop,application/json" hidden aria-label="Import .slop file" disabled={busy} onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file || !begin()) return;
      void readBrowserSlopFile(file).then(accept).catch(fail).finally(finish);
    }} />
    {error && !choosing && <InfoBar severity="error" title="Couldn’t share generator templates" message={error} onClose={() => setError(null)} />}
    {message && <InfoBar severity="success" title={message} onClose={() => setMessage(null)} />}
    {choosing && <ContentDialog title="Export generator templates" defaultButton="primary" primaryText={busy ? "Exporting…" : "Export"} primaryDisabled={busy || selected.length === 0 || selected.length > 100}
      onPrimary={() => void exportFile()} closeText="Cancel" closeDisabled={busy} disableEscape={busy} onClose={() => { setChoosing(false); setError(null); }}>
      <p>Choose up to 100 templates to share. Each model file and LoRA needs a download URL.</p>
      <div className="generator-sharing__choices">
        {choices.map(({ template, reason }) => <div className="generator-sharing__choice" key={template.id}>
          <Checkbox label={template.name} description={reason ?? undefined} aria-label={`Export ${template.name}`} checked={selected.includes(template.id)} disabled={busy || Boolean(reason)}
            onChange={(checked) => setSelected((current) => checked ? [...current, template.id] : current.filter((id) => id !== template.id))} />
        </div>)}
      </div>
      {error && <InfoBar severity="error" title="Couldn’t export templates" message={error} />}
    </ContentDialog>}
  </>;
}
