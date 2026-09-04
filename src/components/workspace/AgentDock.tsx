import { listen } from "@tauri-apps/api/event";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeDiagnosticError, errorContext, writeDiagnostic } from "../../lib/diagnostics";
import { isTauri } from "../../lib/persistence";
import {
  AGENT_TURN_EVENT,
  cancelAgentTurn,
  runAgentTurn,
  type AgentTurnEvent,
  type AgentTurnEventPayload,
  type ProjectCommand,
  type ProviderId,
  type ProviderStatus,
} from "../../lib/runtime";
import { loadAgentProvider, saveAgentProvider } from "../../lib/settings";
import type { ProjectRecord } from "../../lib/project";
import type { AgentMessage } from "../../lib/project";

interface AgentActivity {
  kind: "output" | "diagnostic" | "validation";
  text: string;
}

export function AgentDock({ context, record, providers, expanded, onPromptStart, onCommands }: {
  context: string;
  record: ProjectRecord;
  providers: ProviderStatus[];
  expanded: boolean;
  onPromptStart: () => void;
  onCommands: (commands: ProjectCommand[]) => Promise<void>;
}) {
  const configured = loadAgentProvider() ?? record.config.providerSettings.agent?.options.selectedProvider;
  const initial = providers.some((item) => item.id === configured)
    ? configured as ProviderId
    : providers.find((item) => item.state === "ready")?.id ?? "claude";
  const [provider, setProvider] = useState<ProviderId>(initial);
  const [prompt, setPrompt] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<AgentMessage[]>([]);
  const [hasStarted, setHasStarted] = useState(false);
  const activeRequest = useRef<string | null>(null);
  const conversation = useRef<HTMLDivElement | null>(null);
  const selected = providers.find((item) => item.id === provider);
  const ready = selected?.state === "ready";
  const messages = useMemo(() => sessionMessages.slice(-4), [sessionMessages]);

  useEffect(() => {
    setSessionMessages([]);
    setHasStarted(false);
  }, [record.config.id]);

  /* One listener lives for the dock's lifetime. A request id filters out any
     delayed event from a turn the user already cancelled or replaced. */
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<AgentTurnEventPayload>(AGENT_TURN_EVENT, ({ payload }) => {
      if (payload.requestId !== activeRequest.current) return;
      const nextStatus = statusFromEvent(payload.event);
      if (nextStatus) setStatus(nextStatus);
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
  }, [activity, messages, error, expanded, status, pendingPrompt]);

  const blockedDetail = selected && !ready
    ? [selected.detail, providerNextStep(selected)].filter(Boolean).join(" ")
    : null;
  const placeholder = ready
    ? `Ask Slop to write a new scene from a prompt, refine ${context}, or make an edit…`
    : blockedDetail ?? "No agent provider is available";
  const providerStatusLabel = selected
    ? `${selected.label} status: ${providerStateLabel(selected.state)}`
    : "Agent status: Unavailable";

  const send = async () => {
    const clean = prompt.trim();
    if (!clean || !ready || requestId) return;
    setHasStarted(true);
    onPromptStart();
    const id = crypto.randomUUID();
    activeRequest.current = id;
    setRequestId(id);
    setError(null);
    setPendingPrompt(clean);
    setStatus(`Sending this request to ${selected?.label ?? provider}.`);
    setActivity([]);
    try {
      const response = await runAgentTurn(record, provider, clean, id, sessionMessages);
      if (response.result.kind === "commands") await onCommands(response.result.commands);
      setSessionMessages(response.messages);
      setPendingPrompt(null);
      setPrompt("");
    } catch (reason) {
      const detail = describeDiagnosticError(reason);
      writeDiagnostic("error", "agent", "turn.failed", detail, { requestId: id, provider, projectId: record.config.id, ...errorContext(reason) });
      setError(detail);
      setStatus(null);
    } finally {
      activeRequest.current = null;
      setRequestId(null);
    }
  };

  return (
    <div className={`agent-dock-wrap${expanded ? " agent-dock-wrap--expanded" : ""}${expanded && !hasStarted ? " agent-dock-wrap--welcome" : ""}`}>
      {expanded && !hasStarted && <h1 className="agent-welcome-title">What should we create today?</h1>}
      {expanded && hasStarted && <div className="agent-expanded-content">
        <h1 className="sr-only">Agent</h1>
        <div ref={conversation} className="agent-conversation" role="log" aria-label="Slop output" aria-live="polite">
          {messages.map((message) => <p key={message.id} className={`agent-conversation__${message.role}`}><b>{message.role === "user" ? "You" : "Slop"}</b><span>{message.content}</span></p>)}
          {pendingPrompt && <p className="agent-conversation__user agent-conversation__pending"><b>You</b><span>{pendingPrompt}</span></p>}
          {activity.map((item, index) => <p key={`${item.kind}-${index}`} className={`agent-conversation__${item.kind}`}>
            <b>{activityLabel(item.kind)}</b><span>{item.text}</span>
          </p>)}
          {error && <p className="agent-conversation__error"><b>Slop</b><span>Couldn’t finish that request. {error}</span></p>}
        </div>
        {status && <div className="agent-latest-status" role="status"><b>Status</b><span>{status}</span></div>}
      </div>}
      <div className="agent-dock-row">
        <form className="agent-dock" onSubmit={(event) => { event.preventDefault(); void send(); }}>
          {!expanded && <span className={`agent-provider-light agent-provider--${selected?.state ?? "unknown"}`} role="img" aria-label={providerStatusLabel}><i /></span>}
          <textarea
            aria-label={`Ask Slop about ${context}`}
            rows={expanded ? 2 : 1}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder={placeholder}
            title={placeholder}
            disabled={!ready || Boolean(requestId)}
          />
          <div className="agent-dock__actions">
            {expanded && <label className={`agent-provider agent-provider--${selected?.state ?? "unknown"}`} title={blockedDetail ?? undefined}>
              <span className="agent-provider-light" role="img" aria-label={providerStatusLabel}><i /></span>
              <select aria-label="Agent provider" value={provider} disabled={Boolean(requestId)} onChange={(event) => { const next = event.target.value as ProviderId; setProvider(next); saveAgentProvider(next); }}>
                {providers.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
              </select>
            </label>}
            {requestId
              ? <button type="button" className="agent-cancel" onClick={() => void cancelAgentTurn(requestId)} aria-label="Cancel agent turn"><Square size={14} /></button>
              : <button type="submit" disabled={!prompt.trim() || !ready} aria-label="Send to Slop" title={ready ? "Send to Slop — or press Enter" : blockedDetail ?? "No agent provider is available"}><ArrowUp size={16} /></button>}
            {requestId && <LoaderCircle className="agent-busy" size={16} />}
          </div>
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
  }
};

const statusFromEvent = (event: AgentTurnEvent): string | null => {
  switch (event.type) {
    case "started": return `${providerLabel(event.provider)} started processing.`;
    case "completed": return "The provider returned a response.";
    case "message":
    case "validation":
    case "diagnostic": return null;
  }
};

function activityFromEvent(event: AgentTurnEvent): AgentActivity | null {
  switch (event.type) {
    case "started":
    case "completed": return null;
    case "validation": return { kind: "validation", text: `Correction ${event.round} of ${event.maxRounds}: ${event.text}` };
    case "diagnostic": return event.text.trim() ? { kind: "diagnostic", text: event.text.trim() } : null;
    case "message": {
      const text = readableProviderOutput(event.text);
      return text ? { kind: "output", text } : null;
    }
  }
}

const providerLabel = (provider: ProviderId) => ({
  claude: "Claude Code",
  codex: "Codex",
  openrouter: "OpenRouter",
  local: "Local OpenAI-compatible",
})[provider];

/** Provider CLIs stream NDJSON. Pull out the model-authored text so the panel
 *  shows what Slop is saying instead of transport records. */
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
      const summary = turn.kind === "commands" ? turn.summary : turn.content;
      if (typeof summary === "string" && summary.trim()) return summary.trim();
    } catch { /* A normal model message is already displayable text. */ }
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command.op === "commit" && typeof command.summary === "string" && command.summary.trim()) {
          return command.summary.trim();
        }
      } catch { /* Keep looking for a JSONL commit line. */ }
    }
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
