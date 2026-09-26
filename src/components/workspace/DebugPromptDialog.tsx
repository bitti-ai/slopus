import { useRef } from "react";
import type { PromptSegment } from "../../lib/project";
import { ContentDialog } from "../ui";

/** The exact prompt the engine is sent, in a ContentDialog. Ctrl+A inside the
 *  prompt selects the prompt alone (not the whole window), so it can be
 *  copied in one go. */
export function DebugPromptDialog({ sceneTitle, segments, onClose, title = "Debug prompt", promptLabel = "The compiled MiniMax H3 prompt" }: {
  sceneTitle: string;
  segments: PromptSegment[];
  onClose: () => void;
  title?: string;
  promptLabel?: string;
}) {
  const prompt = useRef<HTMLPreElement>(null);

  return <ContentDialog title={title} closeText="Close" onClose={onClose} width={880} className="debug-prompt-dialog" initialFocus={prompt}>
    <p className="debug-prompt-dialog__scene">{sceneTitle}</p>
    {/* Render compiler segments directly to preserve the exact engine prompt. */}
    <pre
      ref={prompt}
      tabIndex={0}
      className="compiled-prompt__text"
      aria-label={promptLabel}
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") return;
        event.preventDefault();
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(event.currentTarget);
        selection.removeAllRanges();
        selection.addRange(range);
      }}
    >{segments.map((segment, index) =>
      <span key={index} className={`prompt-part prompt-part--${segment.kind}`}>{segment.value}</span>)}</pre>
  </ContentDialog>;
}
