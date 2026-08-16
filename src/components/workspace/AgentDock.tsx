import { ArrowUp, Command, Sparkles } from "lucide-react";
import { useState } from "react";

export function AgentDock({ context }: { context: string }) {
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const send = () => {
    if (!prompt.trim()) return;
    setMessage(`Added to the project conversation: “${prompt.trim()}”`);
    setPrompt("");
    window.setTimeout(() => setMessage(null), 2600);
  };

  return (
    <div className="agent-dock-wrap">
      {message && <div className="agent-toast" role="status">{message}</div>}
      <form className="agent-dock" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <span className="agent-dock__identity"><Sparkles size={15} /><b>Pol</b></span>
        <input
          aria-label={`Ask Pol about ${context}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={`Ask Pol to refine ${context}, generate a shot, or make an edit…`}
        />
        <span className="agent-dock__hint"><Command size={10} /> Enter</span>
        <button type="submit" disabled={!prompt.trim()} aria-label="Send to Pol"><ArrowUp size={15} /></button>
      </form>
    </div>
  );
}
