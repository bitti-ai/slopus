import { ArrowUp, Command, LoaderCircle, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { cancelAgentTurn, runAgentTurn, type ProviderId, type ProviderStatus } from "../../lib/runtime";
import type { ProjectRecord } from "../../lib/project";
import { PolStudioLogo } from "../PolStudioLogo";

export function AgentDock({ context, record, providers, onRecord, onProviderChange }: {
  context: string;
  record: ProjectRecord;
  providers: ProviderStatus[];
  onRecord: (record: ProjectRecord) => void;
  onProviderChange: (provider: ProviderId) => void;
}) {
  const configured = record.config.providerSettings.agent?.options.selectedProvider;
  const initial = configured === "codex" || configured === "claude" ? configured : providers.find((item) => item.state === "ready")?.id ?? "claude";
  const [provider, setProvider] = useState<ProviderId>(initial);
  const [prompt, setPrompt] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = providers.find((item) => item.id === provider);
  const ready = selected?.state === "ready";
  const messages = useMemo(() => record.config.agentConversation.messages.slice(-4), [record.config.agentConversation.messages]);

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
        {error && <p className="agent-conversation__error"><b>Provider unavailable</b>{error}</p>}
      </div>}
      <form className="agent-dock" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <span className="agent-dock__identity"><PolStudioLogo compact decorative /><b>Pol</b></span>
        <label className={`agent-provider agent-provider--${selected?.state ?? "unknown"}`} title={selected?.detail}>
          <i />
          <select aria-label="Agent provider" value={provider} onChange={(event) => { const next = event.target.value as ProviderId; setProvider(next); onProviderChange(next); }}>
            {providers.map((item) => <option value={item.id} key={item.id}>{item.label} · {providerStateLabel(item.state)}</option>)}
          </select>
        </label>
        <input
          aria-label={`Ask Pol about ${context}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={ready ? `Ask Pol to refine ${context}, generate a shot, or make an edit…` : selected?.detail ?? "No agent provider is available"}
          disabled={!ready || Boolean(requestId)}
        />
        {requestId ? <button type="button" className="agent-cancel" onClick={() => void cancelAgentTurn(requestId)} aria-label="Cancel agent turn"><Square size={13} /></button> : <>
          <span className="agent-dock__hint"><Command size={10} /> Enter</span>
          <button type="submit" disabled={!prompt.trim() || !ready} aria-label="Send to Pol"><ArrowUp size={15} /></button>
        </>}
        {requestId && <LoaderCircle className="agent-busy" size={14} />}
      </form>
    </div>
  );
}

const providerStateLabel = (state: ProviderStatus["state"]) => state === "ready" ? "Ready" : state === "notInstalled" ? "Not installed" : state === "authRequired" ? "Sign in required" : state === "disabled" ? "Disabled" : "Unavailable";
