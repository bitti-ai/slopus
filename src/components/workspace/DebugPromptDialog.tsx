import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { PromptSegment } from "../../lib/project";

export function DebugPromptDialog({ sceneTitle, segments, onClose }: {
  sceneTitle: string;
  segments: PromptSegment[];
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const prompt = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        event.preventDefault();
        (document.activeElement === closeButton.current ? prompt.current : closeButton.current)?.focus();
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [onClose]);

  return createPortal(<div className="debug-prompt-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="debug-prompt-dialog" role="dialog" aria-modal="true" aria-labelledby="debug-prompt-title" aria-describedby="debug-prompt-scene">
      <header className="debug-prompt-dialog__header">
        <div><h2 id="debug-prompt-title">Debug Prompt</h2><p id="debug-prompt-scene">{sceneTitle}</p></div>
        <button ref={closeButton} type="button" className="icon-button icon-button--strong" aria-label="Close debug prompt" onClick={onClose}><X size={18} /></button>
      </header>
      {/* Render compiler segments directly to preserve the exact engine prompt. */}
      <pre ref={prompt} tabIndex={0} className="compiled-prompt__text" aria-label="The compiled MiniMax H3 prompt">{segments.map((segment, index) =>
        <span key={index} className={`prompt-part prompt-part--${segment.kind}`}>{segment.value}</span>)}</pre>
    </section>
  </div>, document.body);
}
