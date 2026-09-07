import { listen } from "@tauri-apps/api/event";
import { ArrowUp, Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  }, [activity, messages, error, expanded, pendingPrompt]);

  const blockedDetail = selected && !ready
    ? [selected.detail, providerNextStep(selected)].filter(Boolean).join(" ")
    : null;
  const placeholder = ready
    ? `Ask Slop to write a new scene from a prompt, refine ${context}, or make an edit…`
    : blockedDetail ?? "No agent provider is available";
  const providerStatusLabel = requestId && selected
    ? `${selected.label} status: Processing`
    : selected
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
          {requestId && <p className="agent-conversation__waiting" aria-label="Waiting for the next agent response">
            <b>Slop</b><span className="agent-conversation__waiting-dots" aria-hidden="true"><i /><i /><i /></span>
          </p>}
        </div>
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
            {expanded && <AgentProviderSelector providers={providers} provider={provider} busy={Boolean(requestId)} statusLabel={providerStatusLabel} detail={blockedDetail} onChange={(next) => { setProvider(next); saveAgentProvider(next); }} />}
            {requestId
              ? <button type="button" className="agent-cancel" onClick={() => void cancelAgentTurn(requestId)} aria-label="Cancel agent turn"><LoaderCircle className="agent-busy" size={16} aria-hidden="true" /></button>
              : <button type="submit" disabled={!prompt.trim() || !ready} aria-label="Send to Slop" title={ready ? "Send to Slop — or press Enter" : blockedDetail ?? "No agent provider is available"}><ArrowUp size={16} /></button>}
          </div>
        </form>
      </div>
    </div>
  );
}

function AgentProviderSelector({ providers, provider, busy, statusLabel, detail, onChange }: {
  providers: ProviderStatus[];
  provider: ProviderId;
  busy: boolean;
  statusLabel: string;
  detail: string | null;
  onChange: (provider: ProviderId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = providers.find((item) => item.id === provider);
  const expanded = open && !busy;

  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [expanded]);

  const show = () => {
    setActiveIndex(Math.max(0, providers.findIndex((item) => item.id === provider)));
    setOpen(true);
  };
  const pick = (item: ProviderStatus) => {
    if (busy) return;
    onChange(item.id);
    setOpen(false);
  };

  return <div ref={root} className="agent-provider" title={detail ?? undefined}>
    <button
      type="button"
      className="agent-provider__trigger"
      role="combobox"
      aria-label="Agent provider"
      aria-expanded={expanded}
      aria-haspopup="listbox"
      aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && providers[activeIndex] ? `${listId}-${activeIndex}` : undefined}
      disabled={busy}
      onClick={() => expanded ? setOpen(false) : show()}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (!expanded) show();
          else if (providers.length) setActiveIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + providers.length) % providers.length);
        } else if (expanded && (event.key === "Home" || event.key === "End")) {
          event.preventDefault();
          setActiveIndex(event.key === "Home" ? 0 : providers.length - 1);
        } else if (expanded && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          if (providers[activeIndex]) pick(providers[activeIndex]);
        } else if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        } else if (event.key === "Tab") setOpen(false);
      }}
    >
      <span className={`agent-provider-light agent-provider--${selected?.state ?? "unknown"}`} role="img" aria-label={statusLabel}><i /></span>
      <span className="agent-provider__name">{selected?.label ?? "Choose LLM"}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {expanded && <div id={listId} className="agent-provider__options" role="listbox" aria-label="Agent providers">
      {providers.map((item, index) => <div
        key={item.id}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={item.id === provider}
        className={`agent-provider__option${index === activeIndex ? " agent-provider__option--active" : ""}`}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActiveIndex(index)}
        onClick={() => pick(item)}
      >
        <span className={`agent-provider-light agent-provider--${item.state}`} aria-hidden="true"><i /></span>
        <span>{item.label}</span>
        {item.id === provider && <Check size={14} aria-hidden="true" />}
      </div>)}
    </div>}
  </div>;
}

const activityLabel = (kind: AgentActivity["kind"]): string => {
  switch (kind) {
    case "output": return "LLM";
    case "validation": return "Validator";
    case "diagnostic": return "Error";
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
