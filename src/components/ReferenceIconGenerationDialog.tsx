import { ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function ReferenceIconGenerationDialog({ count, onAnswer, builtins = false }: {
  count: number;
  builtins?: boolean;
  onAnswer: (confirmed: boolean, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onAnswer(false, false);
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const stops = Array.from(dialog.current.querySelectorAll<HTMLElement>("button, input"));
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && (active === last || !dialog.current.contains(active))) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onAnswer]);

  return <div className="exit-guard-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onAnswer(false, false); }}>
    <div className="exit-guard" ref={dialog} role="alertdialog" aria-modal="true" aria-labelledby="reference-icon-generation-title" aria-describedby="reference-icon-generation-description">
      <div className="exit-guard__head">
        <span className="exit-guard__mark" aria-hidden="true"><ImagePlus size={20} /></span>
        <h2 id="reference-icon-generation-title">{builtins ? "Generate built-in reference icons?" : "Generate reference icons?"}</h2>
      </div>
      <div className="exit-guard__body" id="reference-icon-generation-description">
        {builtins ? <>
          <p>Generate icons for {count} built-in references to make them easier to browse?</p>
          <p>This can take a long time. Icon generation runs in the background and pauses for normal video generation, so you can keep creating videos.</p>
          <p>The icons are shared across projects and saved in a reference-icons subfolder beside the log files.</p>
        </> : <>
          <p>{count} {count === 1 ? "reference needs an icon" : "references need icons"}. Generate them now using the video engine? This uses your GPU; waiting videos take priority.</p>
          <p>Cancel skips this batch.</p>
        </>}
      </div>
      <label className="reference-icon-option">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        <span><b>Don't ask again</b><small>{builtins ? "Remember whether to generate missing built-in icons when you open Add a reference." : "Remember Start as automatic generation, or Cancel as turning it off."}</small></span>
      </label>
      <div className="exit-guard__actions">
        <button className="secondary-button" type="button" ref={cancel} onClick={() => onAnswer(false, remember)}>Cancel</button>
        <button className="primary-button" type="button" onClick={() => onAnswer(true, remember)}>Start generation</button>
      </div>
    </div>
  </div>;
}
