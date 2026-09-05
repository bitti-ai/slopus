import { AlertCircle, Clock3, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";

/** One generation the app is still working on, as the exit guard needs it.
 *  `running` separates the shot the engine is rendering right now from the ones
 *  behind it in the queue — the same split the Generator shows. */
export interface OngoingGeneration {
  id: string;
  title: string;
  running: boolean;
}

/** Where the user was heading when the guard stopped them. */
export type ExitDestination = "library" | "quit";

const FOCUSABLE = "button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])";

/** Asks before an exit that would throw away work the engine is still doing.
 *
 *  Every claim it makes is a claim about this codebase, not a hedge:
 *   • slopfab writes no file of its own (see `run_generation` in slopfab.rs). Its
 *     frames reach the app through the `slopfab-job` event, and only once the
 *     app has encoded them (useGenerationEvents → lib/generatedVideo.ts) is
 *     there an .mp4 in the project folder. Leave before that and there is
 *     nothing on disk to come back to — which is why a scene that is still
 *     being encoded counts as ongoing too (see isGenerationOngoing).
 *   • Nothing resumes. The only route back to a stopped shot is the Generator's
 *     "Run it again", which starts the whole render from the first step.
 */
export function ExitGuardDialog({ jobs, destination, onConfirm, onCancel }: {
  jobs: OngoingGeneration[];
  destination: ExitDestination;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const keepGenerating = useRef<HTMLButtonElement>(null);

  /* Focus goes to "Keep generating" — the answer that changes nothing — and
     comes back to whatever opened the dialog when it closes, so a keyboard user
     is not dropped at the top of the document. */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    keepGenerating.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      // Tab must not walk out into the screen behind the dialog: it is still
      // rendered, and a focus ring on a control the user cannot see is the same
      // as losing focus altogether.
      const stops = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) return;
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
  }, [onCancel]);

  const rendering = jobs.filter((job) => job.running);
  const queued = jobs.filter((job) => !job.running);
  const leaving = destination === "library";

  return (
    <div className="exit-guard-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <div
        className="exit-guard"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="exit-guard-title"
        aria-describedby="exit-guard-body"
      >
        <div className="exit-guard__head">
          <span className="exit-guard__mark" aria-hidden="true"><AlertCircle size={20} /></span>
          <h2 id="exit-guard-title">
            {leaving ? "Leave the project and stop generating?" : "Close PolStudio and stop generating?"}
          </h2>
        </div>

        <div className="exit-guard__body" id="exit-guard-body">
          <p>{summary(rendering.length, queued.length)}</p>
          <p>
            {leaving
              ? "Going back to your projects stops them. "
              : "The video engine runs inside PolStudio, so closing the window stops them. "}
            No video file is written until a shot finishes, so an unfinished run leaves nothing behind — and PolStudio
            can’t pick one back up. You would run those shots again from the beginning.
          </p>
        </div>

        {jobs.length > 0 && (
          <ul className="exit-guard__jobs">
            {jobs.slice(0, 4).map((job) => (
              <li key={job.id}>
                {job.running ? <LoaderCircle size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}
                <b>{job.title}</b>
                <em>{job.running ? "Rendering now" : "Waiting to render"}</em>
              </li>
            ))}
            {jobs.length > 4 && <li className="exit-guard__more">and {jobs.length - 4} more</li>}
          </ul>
        )}

        <div className="exit-guard__actions">
          <button className="secondary-button" type="button" ref={keepGenerating} onClick={onCancel}>
            Keep generating
          </button>
          <button className="exit-guard__confirm" type="button" onClick={onConfirm}>
            {leaving ? "Stop and leave" : "Stop and close"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Counts what is actually happening, in the words the Generator uses for the
 *  same two states. Never rounds a queued shot up into a rendering one. */
export function summary(rendering: number, queued: number): string {
  const parts: string[] = [];
  if (rendering > 0) parts.push(`${rendering} ${rendering === 1 ? "shot is" : "shots are"} rendering now`);
  if (queued > 0) parts.push(`${queued} ${queued === 1 ? "shot is" : "shots are"} waiting in the queue`);
  if (parts.length === 0) return "Nothing is generating right now.";
  const sentence = parts.join(" and ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
