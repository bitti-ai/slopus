import { listen } from "@tauri-apps/api/event";
import { ArrowUp, ChevronDown, ChevronUp, LoaderCircle, Square, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../../lib/persistence";
import {
  AGENT_TURN_EVENT,
  cancelAgentTurn,
  runAgentTurn,
  type AgentTurnEvent,
  type AgentTurnEventPayload,
  type ProviderId,
  type ProviderStatus,
} from "../../lib/runtime";
import { loadAgentProvider, saveAgentProvider } from "../../lib/settings";
import type { ProjectRecord } from "../../lib/project";

interface AgentActivity {
  kind: "output" | "diagnostic" | "validation" | "system";
  text: string;
}

export function AgentDock({ context, record, providers, onRecord }: {
  context: string;
  record: ProjectRecord;
  providers: ProviderStatus[];
  onRecord: (record: ProjectRecord) => void;
}) {
  const configured = loadAgentProvider() ?? record.config.providerSettings.agent?.options.selectedProvider;
  const initial = configured === "codex" || configured === "claude" ? configured : providers.find((item) => item.state === "ready")?.id ?? "claude";
  const [provider, setProvider] = useState<ProviderId>(initial);
  const [prompt, setPrompt] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const activeRequest = useRef<string | null>(null);
  const conversation = useRef<HTMLDivElement | null>(null);
  const selected = providers.find((item) => item.id === provider);
  const ready = selected?.state === "ready";
  const messages = useMemo(() => record.config.agentConversation.messages.slice(-4), [record.config.agentConversation.messages]);

  /* One listener lives for the dock's lifetime. A request id filters out any
     delayed event from a turn the user already cancelled or replaced. */
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<AgentTurnEventPayload>(AGENT_TURN_EVENT, ({ payload }) => {
      if (payload.requestId !== activeRequest.current) return;
      const item = activityFromEvent(payload.event);
      if (!item) return;
      setActivity((current) => {
        const previous = current.at(-1);
        if (previous?.kind === item.kind && previous.text === item.text) return current;
        return [...current, item].slice(-100);
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    const panel = conversation.current;
    if (expanded && panel) panel.scrollTop = panel.scrollHeight;
  }, [activity, messages, error, expanded]);

  const blockedDetail = selected && !ready
    ? [selected.detail, providerNextStep(selected)].filter(Boolean).join(" ")
    : null;
  const placeholder = ready
    ? `Ask Pol to write a new scene from a prompt, refine ${context}, or make an edit…`
    : blockedDetail ?? "No agent provider is available";

  const send = async () => {
    const clean = prompt.trim();
    if (!clean || !ready || requestId) return;
    const id = crypto.randomUUID();
    activeRequest.current = id;
    setRequestId(id);
    setError(null);
    setActivity([{ kind: "system", text: `Sending this request to ${selected?.label ?? provider}.` }]);
    setExpanded(true);
    try {
      const response = await runAgentTurn(record, provider, clean, id);
      onRecord(response.record);
      setPrompt("");
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(detail);
    } finally {
      activeRequest.current = null;
      setRequestId(null);
    }
  };

  return (
    <div className={`agent-dock-wrap${expanded ? " agent-dock-wrap--expanded" : ""}`}>
      {expanded && <div ref={conversation} className="agent-conversation" role="log" aria-label="Pol output" aria-live="polite">
        {messages.map((message) => <p key={message.id} className={`agent-conversation__${message.role}`}><b>{message.role === "user" ? "You" : "Pol"}</b><span>{message.content}</span></p>)}
        {activity.map((item, index) => <p key={`${item.kind}-${index}`} className={`agent-conversation__${item.kind}`}>
          <b>{activityLabel(item.kind)}</b><span>{item.text}</span>
        </p>)}
        {messages.length === 0 && activity.length === 0 && !error && <p className="agent-conversation__empty"><b>Pol</b><span>No activity yet. Send a prompt to start.</span></p>}
        {error && <p className="agent-conversation__error"><b>Pol</b><span>Couldn’t finish that request. {error}</span></p>}
      </div>}
      <div className="agent-dock-row">
        <button
          type="button"
          className="agent-panel-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse Pol output" : "Expand Pol output"}
          title={expanded ? "Collapse Pol output" : "Expand Pol output"}
          onClick={() => setExpanded((visible) => !visible)}
        >{expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</button>
        <form className="agent-dock" onSubmit={(event) => { event.preventDefault(); void send(); }}>
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
          {!ready && <span className="agent-dock__blocked"><TriangleAlert size={14} aria-hidden="true" /> {selected ? providerStateLabel(selected.state) : "Unavailable"}</span>}
          <button type="submit" disabled={!prompt.trim() || !ready} aria-label="Send to Pol" title={ready ? "Send to Pol — or press Enter" : blockedDetail ?? "No agent provider is available"}><ArrowUp size={16} /></button>
        </>}
        {requestId && <LoaderCircle className="agent-busy" size={16} />}
        </form>
      </div>
    </div>
  );
}

const activityLabel = (kind: AgentActivity["kind"]): string => {
  switch (kind) {
    case "output": return "LLM";
    case "validation": return "Validator";
    case "diagnostic": return "Error";
    case "system": return "Status";
  }
};

function activityFromEvent(event: AgentTurnEvent): AgentActivity | null {
  switch (event.type) {
    case "started": return { kind: "system", text: `${event.provider === "claude" ? "Claude Code" : "Codex"} started processing.` };
    case "completed": return { kind: "system", text: "The provider returned a response." };
    case "validation": return { kind: "validation", text: `Correction ${event.round} of ${event.maxRounds}: ${event.text}` };
    case "diagnostic": return event.text.trim() ? { kind: "diagnostic", text: event.text.trim() } : null;
    case "message": {
      const text = readableProviderOutput(event.text);
      return text ? { kind: "output", text } : null;
    }
  }
}

/** Provider CLIs stream NDJSON. Pull out the model-authored text so the panel
 *  shows what Pol is saying instead of transport records. */
export function readableProviderOutput(line: string): string | null {
  const clean = line.trim();
  if (!clean) return null;
  let value: unknown;
  try { value = JSON.parse(clean); } catch { return clean; }
  if (!value || typeof value !== "object") return clean;
  const record = value as Record<string, unknown>;
  const message = record.message as Record<string, unknown> | undefined;
  const candidates: unknown[] = [];
  if (Array.isArray(message?.content)) {
    candidates.push(...message.content.map((part) => (part as Record<string, unknown>)?.text ?? (part as Record<string, unknown>)?.thinking));
  }
  candidates.push((record.item as Record<string, unknown> | undefined)?.text, record.result);
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const text = candidate.trim();
    try {
      const turn = JSON.parse(text) as Record<string, unknown>;
      const summary = turn.kind === "mutation" ? turn.summary : turn.content;
      if (typeof summary === "string" && summary.trim()) return summary.trim();
    } catch { /* A normal model message is already displayable text. */ }
    return text;
  }
  return null;
}

const providerStateLabel = (state: ProviderStatus["state"]) => state === "checking" ? "Checking…" : state === "ready" ? "Ready" : state === "notInstalled" ? "Not installed" : state === "authRequired" ? "Sign in required" : state === "disabled" ? "Disabled" : "Unavailable";

const providerNextStep = ({ state, label }: ProviderStatus): string => {
  switch (state) {
    case "notInstalled": return `Install ${label} and make sure it is on your PATH, then reopen this project.`;
    case "authRequired": return `Sign in to ${label} in your terminal, then reopen this project.`;
    case "disabled": return `${label} is switched off for this project.`;
    case "checking":
    case "ready":
    case "unavailable": return "";
  }
};
