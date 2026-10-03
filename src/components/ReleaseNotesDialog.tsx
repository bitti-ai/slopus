import { useEffect, type ReactNode } from "react";
import releaseNotes from "../../RELEASE_NOTES.md?raw";
import { markReleaseNotesSeen } from "../lib/releaseNotes";
import { APP_CHANNEL, APP_VERSION } from "../lib/version";
import { ContentDialog } from "./ui";

// The bundled document uses headings, paragraphs, bullet lists, bold and code.
// Render these as React elements so text is escaped, never interpreted as HTML.
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) =>
    part.startsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.startsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part);
}

const blocks = releaseNotes.trim().replace(/^# [^\n]+\r?\n/, "").trim().split(/\r?\n\s*\r?\n/);

export function ReleaseNotesDialog({ onClose }: { onClose: () => void }) {
  // Record only after the dialog actually mounts, including when opened manually.
  useEffect(() => { markReleaseNotesSeen(); }, []);

  return <ContentDialog
    title={`What's new in Slopus ${APP_VERSION}`}
    closeText="Done" onClose={onClose} defaultButton="close"
    width={760} className="release-notes-dialog"
    aria-describedby=""
  >
    <p className="release-notes__channel">{APP_CHANNEL} release</p>
    <article className="release-notes" aria-label="Release notes">
      {blocks.map((block, index) => {
        const heading = /^(#{2,6}) (.+)$/.exec(block);
        if (heading) return <h3 key={index}>{inline(heading[2])}</h3>;
        if (/^- /m.test(block)) return <ul key={index}>
          {block.split(/\r?\n(?=- )/).map((item, itemIndex) => <li key={itemIndex}>{inline(item.replace(/^- /, ""))}</li>)}
        </ul>;
        return <p key={index}>{inline(block)}</p>;
      })}
    </article>
  </ContentDialog>;
}
