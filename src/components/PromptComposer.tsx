import { ChevronDown, Clapperboard, Clock3, ImagePlus, Monitor, Sparkles, WandSparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { chooseInitialReferenceImages, isTauri } from "../lib/persistence";
import type { AspectRatio, CreateProjectInput, Resolution } from "../lib/project";
import { projectNameFromPrompt } from "../lib/project";
import { PolStudioLogo } from "./PolStudioLogo";

interface PromptComposerProps {
  busy: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
}

/** Clicking a chip fills the box with a complete starter description. */
const ideas: { label: string; prompt: string }[] = [
  { label: "Product reveal", prompt: "A cinematic product reveal for a minimalist wristwatch — slow macro camera moves, warm studio light, a single hero shot at the end." },
  { label: "Social ad", prompt: "A punchy social ad for a new oat-milk coffee — bright kitchen light, quick cuts, upbeat and friendly." },
  { label: "Mini documentary", prompt: "A short documentary portrait of a ceramicist at work — natural window light, unhurried handheld camera, honest and quiet." },
];

const aspectRatioLabels: Record<AspectRatio, string> = {
  "16:9": "Widescreen 16:9",
  "9:16": "Vertical 9:16",
  "1:1": "Square 1:1",
  "4:5": "Portrait 4:5",
};

const resolutionLabels: Record<Resolution, string> = {
  "720p": "720p",
  "1080p": "1080p HD",
  "4k": "4K",
};

const durationOptions: { value: number; label: string }[] = [
  { value: 15, label: "15 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 90, label: "1 minute 30" },
];

const durationLabel = (seconds: number) =>
  durationOptions.find((option) => option.value === seconds)?.label ?? `${seconds} seconds`;

const modifierKey =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl";

export function PromptComposer({ busy, onCreate }: PromptComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [duration, setDuration] = useState(60);
  const [referenceImages, setReferenceImages] = useState<NonNullable<CreateProjectInput["referenceImages"]>>([]);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);

  const referencesAvailable = isTauri();
  /* The box holds words the user typed, not an untouched example, so a chip
     click would throw them away. */
  const replacesUserText = prompt.trim().length > 0 && !ideas.some((idea) => idea.prompt === prompt);

  /* The description box is the first thing you use, so start in it — saving a
     click on the headline flow. Runs once, and only while focus is still on the
     document body, so it never yanks focus off a field the user already picked
     (Ctrl+K search included). */
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    promptInput.current?.focus({ preventScroll: true });
  }, []);

  const addReferenceImages = async () => {
    setReferenceError(null);
    try {
      const selected = await chooseInitialReferenceImages();
      setReferenceImages((current) => [...current, ...selected.filter((image) => !current.some((item) => item.sourcePath === image.sourcePath))]);
    } catch (reason) {
      setReferenceError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    await onCreate({
      name: projectNameFromPrompt(prompt),
      prompt,
      aspectRatio,
      resolution,
      targetDurationSeconds: duration,
      referenceImages,
    });
  };

  return (
    <section className="composer-shell" aria-labelledby="create-heading">
      <div className="composer-shell__glow" />
      <div className="composer-heading">
        <span className="eyebrow"><Sparkles size={14} /> New project</span>
        <h2 id="create-heading">What do you want to make?</h2>
        <p>Write it the way you would say it out loud. Pol Studio turns your description into a real project you can edit — nothing here is final.</p>
      </div>

      <div className="composer">
        <div className="composer__input-row">
          <PolStudioLogo compact decorative className="composer__brand-mark" />
          <textarea
            ref={promptInput}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
            }}
            placeholder="A moody 45-second launch film for a sustainable running shoe…"
            rows={3}
            aria-label="Describe your video"
          />
        </div>

        {(referenceImages.length > 0 || referenceError) && <div className="composer__references" aria-label="Reference images for this project">
          {referenceImages.map((image) => <span className="composer__reference" key={image.sourcePath}><ImagePlus size={14} /><b>{image.name}</b><button onClick={() => setReferenceImages((current) => current.filter((item) => item.sourcePath !== image.sourcePath))} aria-label={`Remove ${image.name}`}><X size={14} /></button></span>)}
          {referenceError && <small role="alert">{referenceError}</small>}
        </div>}

        <details className="composer__options">
          <summary>
            <span className="composer__options-title">Video settings</span>
            <span className="composer__options-value">{aspectRatioLabels[aspectRatio]} · {resolutionLabels[resolution]} · {durationLabel(duration)}</span>
            <ChevronDown className="composer__options-chevron" size={17} />
          </summary>
          <div className="composer__options-body">
            <p className="composer__options-note">These are already set to sensible defaults. Change them only if you want something different.</p>
            <div className="composer__options-grid">
              <label>
                <span><Monitor size={15} /> Video shape</span>
                <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}>
                  <option value="16:9">Widescreen 16:9</option>
                  <option value="9:16">Vertical 9:16</option>
                  <option value="1:1">Square 1:1</option>
                  <option value="4:5">Portrait 4:5</option>
                </select>
              </label>
              <label>
                <span><Clapperboard size={15} /> Picture quality</span>
                <select value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)}>
                  <option value="720p">720p</option>
                  <option value="1080p">1080p HD</option>
                  <option value="4k">4K</option>
                </select>
              </label>
              <label>
                <span><Clock3 size={15} /> Length</span>
                <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
                  {durationOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
          </div>
        </details>

        <div className="composer__actions">
          <button
            className="composer__attach"
            onClick={() => void addReferenceImages()}
            disabled={busy || !referencesAvailable}
            title={referencesAvailable ? "Add PNG, JPEG, or WebP images to guide the look" : "Reference image import is available in the desktop app"}
          >
            <ImagePlus size={16} /> Add reference images{referenceImages.length > 0 && <b>{referenceImages.length}</b>}
          </button>
          <span className="composer__hint">Or press <kbd>{modifierKey}</kbd><kbd>Enter</kbd></span>
          <button className="primary-button composer__submit" disabled={!prompt.trim() || busy} aria-busy={busy} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : <WandSparkles size={18} />}
            Create project
          </button>
        </div>
      </div>

      {/* Clicking a chip overwrites the box. That is the right idiom while the
          box is empty or still holds an example, but silently discarding words
          the user typed is not — a controlled textarea gives no usable undo
          after a programmatic set. Rather than disable the chips (which would
          block the common "try another example" flow), say plainly what the
          click will do. */}
      <div className="idea-row">
        <span className="idea-row__label">{replacesUserText ? "Replace what you’ve written with an example" : "Not sure where to start?"}</span>
        {ideas.map((idea) => <button key={idea.label} onClick={() => setPrompt(idea.prompt)} title={replacesUserText ? `Replace your description with the “${idea.label}” example` : `Use the “${idea.label}” example`}>{idea.label}</button>)}
      </div>
    </section>
  );
}
