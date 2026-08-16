import { ArrowUp, Clapperboard, Clock3, Monitor, Sparkles, WandSparkles } from "lucide-react";
import { useState } from "react";
import type { AspectRatio, CreateProjectInput, Resolution } from "../lib/project";
import { projectNameFromPrompt } from "../lib/project";

interface PromptComposerProps {
  busy: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
}

const ideas = [
  "Cinematic product reveal",
  "Social campaign cut",
  "Documentary mini-story",
];

export function PromptComposer({ busy, onCreate }: PromptComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [resolution, setResolution] = useState<Resolution>("1080p");
  const [duration, setDuration] = useState(60);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    await onCreate({
      name: projectNameFromPrompt(prompt),
      prompt,
      aspectRatio,
      resolution,
      targetDurationSeconds: duration,
    });
  };

  return (
    <section className="composer-shell" aria-labelledby="create-heading">
      <div className="composer-shell__glow" />
      <div className="composer-heading">
        <span className="eyebrow"><WandSparkles size={13} /> New project</span>
        <h2 id="create-heading">What do you want to make?</h2>
        <p>Describe the story. Your agent will shape the first cut inside a real, editable project.</p>
      </div>
      <div className="composer">
        <div className="composer__input-row">
          <Sparkles className="composer__spark" size={19} />
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
            }}
            placeholder="A moody 45-second launch film for a sustainable running shoe…"
            rows={2}
            aria-label="Describe your video"
          />
          <button className="composer__submit" disabled={!prompt.trim() || busy} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : <ArrowUp size={19} />}
            <span className="sr-only">Create project</span>
          </button>
        </div>
        <div className="composer__settings">
          <label><Monitor size={14} /><span>Format</span>
            <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}>
              <option>16:9</option><option>9:16</option><option>1:1</option><option>4:5</option>
            </select>
          </label>
          <span className="composer__divider" />
          <label><Clapperboard size={14} /><span>Quality</span>
            <select value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)}>
              <option value="720p">720p</option><option value="1080p">1080p</option><option value="4k">4K</option>
            </select>
          </label>
          <span className="composer__divider" />
          <label><Clock3 size={14} /><span>Length</span>
            <select value={duration} onChange={(event) => setDuration(Number(event.target.value))}>
              <option value={15}>15 sec</option><option value={30}>30 sec</option><option value={60}>1 min</option><option value={90}>90 sec</option>
            </select>
          </label>
          <span className="composer__hint">⌘ Enter to create</span>
        </div>
      </div>
      <div className="idea-row">
        <span>Try an idea</span>
        {ideas.map((idea) => <button key={idea} onClick={() => setPrompt(idea)}>{idea}</button>)}
      </div>
    </section>
  );
}

