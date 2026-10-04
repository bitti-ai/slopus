import { useEffect, useState, useSyncExternalStore } from "react";
import { loadDebugOptionsEnabled, subscribeDebugOptions } from "../../lib/settings";
import { ComboBox } from "../ui";
import { DebugPromptDialog } from "./DebugPromptDialog";

/** Template previews use the same compiler output as the generation queue. */
export function TemplateDebugPrompt({ name, prompts }: {
  name: string;
  prompts: Array<{ label: string; prompt: string }>;
}) {
  const enabled = useSyncExternalStore(subscribeDebugOptions, loadDebugOptionsEnabled);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  useEffect(() => { if (!enabled || !prompts.length) setOpen(false); }, [enabled, prompts.length]);
  if (!enabled) return null;
  const index = Math.min(selected, prompts.length - 1);
  const current = prompts[index];
  return <>
    <button type="button" className="secondary-button debug-prompt__toggle" aria-haspopup="dialog" disabled={!current}
      onClick={() => { setSelected(0); setOpen(true); }}>Debug prompt</button>
    {open && current && <DebugPromptDialog sceneTitle={name} segments={[{ kind: "brief", value: current.prompt }]} onClose={() => setOpen(false)}
      controls={prompts.length > 1 && <ComboBox aria-label="Template view" value={index} onChange={setSelected}
        options={prompts.map(({ label }, value) => ({ label, value }))} />} />}
  </>;
}
