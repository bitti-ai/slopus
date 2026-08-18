import { ArrowUp, LoaderCircle, Square, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { cancelAgentTurn, runAgentTurn, type ProviderId, type ProviderStatus } from "../../lib/runtime";
import { loadAgentProvider, saveAgentProvider } from "../../lib/settings";
import type { ProjectRecord } from "../../lib/project";
import { PolStudioLogo } from "../PolStudioLogo";

export function AgentDock({ context, record, providers, onRecord }: {
  context: string;
  record: ProjectRecord;
  providers: ProviderStatus[];
  onRecord: (record: ProjectRecord) => void;
}) {
  /* Which agent drives Pol depends on what is installed and signed in on THIS
     computer, so the choice is remembered per machine and survives a restart.
     Projects written before that existed still carry their own choice; it is
     read once as a seed and the stored preference takes over from there. */
  const configured = loadAgentProvider() ?? record.config.providerSettings.agent?.options.selectedProvider;
  const initial = configured === "codex" || configured === "claude" ? configured : providers.find((item) => item.state === "ready")?.id ?? "claude";
  const [provider, setProvider] = useState<ProviderId>(initial);
  const [prompt, setPrompt] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = providers.find((item) => item.id === provider);
  const ready = selected?.state === "ready";
  const messages = useMemo(() => record.config.agentConversation.messages.slice(-4), [record.config.agentConversation.messages]);

  // When Pol can't run, say what is wrong AND what the user can do about it.
  const blockedDetail = selected && !ready
    ? [selected.detail, providerNextStep(selected)].filter(Boolean).join(" ")
    : null;

  // The dock is one line tall, so on a narrow window the placeholder gets an
  // ellipsis (see .agent-dock input in workspace.css). Keep the full sentence
  // reachable on hover so nothing that matters is lost to the truncation.
  const placeholder = ready
    ? `Ask Pol to refine ${context}, generate a shot, or make an edit…`
    : blockedDetail ?? "No agent provider is available";

  const send = async () => {
    const clean = prompt.trim();
    if (!clean || !ready || requestId) return;
    const id = crypto.randomUUID();
    setRequestId(id);
    setError(null);
    try {
      const response = await runAgentTurn(record, provider, clean, id);
      onRecord(response.record);
      setPrompt("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRequestId(null);
    }
  };

  return (
    <div className="agent-dock-wrap">
      {(messages.length > 0 || error) && <div className="agent-conversation" aria-live="polite">
        {messages.map((message) => <p key={message.id} className={`agent-conversation__${message.role}`}><b>{message.role === "user" ? "You" : "Pol"}</b>{message.content}</p>)}
        {error && <p className="agent-conversation__error"><b>Pol</b>Couldn’t finish that request. {error}</p>}
      </div>}
      <form className="agent-dock" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <span className="agent-dock__identity"><PolStudioLogo compact decorative /><b>Pol</b></span>
        <label className={`agent-provider agent-provider--${selected?.state ?? "unknown"}`} title={blockedDetail ?? selected?.detail}>
          <i />
          <select aria-label="Agent provider" value={provider} onChange={(event) => { const next = event.target.value as ProviderId; setProvider(next); saveAgentProvider(next); }}>
            {providers.map((item) => <option value={item.id} key={item.id}>{item.label} · {providerStateLabel(item.state)}</option>)}
          </select>
        </label>
        <input
          aria-label={`Ask Pol about ${context}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={placeholder}
          title={placeholder}
          disabled={!ready || Boolean(requestId)}
        />
        {requestId ? <button type="button" className="agent-cancel" onClick={() => void cancelAgentTurn(requestId)} aria-label="Cancel agent turn"><Square size={14} /></button> : <>
          {/* The keyboard shortcut is a hint, not news: it lives on the button
              it describes rather than taking a permanent slice of a one-line
              dock. Why Pol CANNOT run still gets its own visible label — that
              is a state the user has to act on. */}
          {!ready && <span className="agent-dock__blocked"><TriangleAlert size={14} aria-hidden="true" /> {selected ? providerStateLabel(selected.state) : "Unavailable"}</span>}
          <button type="submit" disabled={!prompt.trim() || !ready} aria-label="Send to Pol" title={ready ? "Send to Pol — or press Enter" : blockedDetail ?? "No agent provider is available"}><ArrowUp size={16} /></button>
        </>}
        {requestId && <LoaderCircle className="agent-busy" size={16} />}
      </form>
    </div>
  );
}

const providerStateLabel = (state: ProviderStatus["state"]) => state === "ready" ? "Ready" : state === "notInstalled" ? "Not installed" : state === "authRequired" ? "Sign in required" : state === "disabled" ? "Disabled" : "Unavailable";

/* Only states with a genuine user action get a next step — never invent one. */
const providerNextStep = ({ state, label }: ProviderStatus): string => {
  switch (state) {
    case "notInstalled":
      return `Install ${label} and make sure it is on your PATH, then reopen this project.`;
    case "authRequired":
      return `Sign in to ${label} in your terminal, then reopen this project.`;
    case "disabled":
      return `${label} is switched off for this project.`;
    case "ready":
    case "unavailable":
      return "";
  }
};
