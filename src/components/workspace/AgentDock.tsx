import { listen } from "@tauri-apps/api/event";
import { Agent32, Clear16, Dismiss16, Send16, Stop14 } from "../ui/icons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { ComboBox, EmptyState, PaneHeader, ProgressRing, tooltipProps } from "../ui";

/** How tall the prompt box grows before it scrolls. */
export const COMPOSER_MAX_LINES = 6;

interface AgentActivity {
  kind: "output" | "diagnostic" | "validation";
  text: string;
}

/** The agent as a docked tool pane: a 36px pane toolbar (the provider picker
 *  leading, clear and close trailing — no title, the workspace's aside already
 *  names the pane), the conversation, and a flush text box with a send button.
 *
 *  The pane container — its placement, splitter and show/hide — belongs to the
 *  workspace. `onClose` wires the header's close button to it; without it the
 *  button is not shown. `expanded` is accepted for compatibility and no longer
 *  changes the layout: the pane is always the full conversation. */
export function AgentDock({ context, record, mode = record.config.generationType === "image" ? "image" : "video", providers, onPromptStart, onCommands, onClose, onBusyChange }: {
  context: string;
  record: ProjectRecord;
  /** Active editor context; legacy project types no longer restrict capabilities. */
  mode?: "video" | "image";
  providers: ProviderStatus[];
  /** @deprecated The dock is always a pane now; kept so callers need not change. */
  expanded?: boolean;
  onPromptStart: () => void;
  onCommands: (commands: ProjectCommand[]) => Promise<void>;
  /** Hide the pane (the header's × button). */
  onClose?: () => void;
  /** Told when a turn starts and ends, so the Agent toggle can show it. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const configured = loadAgentProvider() ?? record.config.providerSettings.agent?.options.selectedProvider;
  const initial = providers.some((item) => item.id === configured)
    ? configured as ProviderId
    : providers.find((item) => item.state === "ready")?.id ?? "claude";
  const [provider, setProvider] = useState<ProviderId>(initial);
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<AgentMessage[]>([]);
  const activeRequest = useRef<string | null>(null);
  const busy = requestId !== null;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  const conversation = useRef<HTMLDivElement | null>(null);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  /* The prompt box grows with what is typed, up to six lines, then scrolls —
     the way the Windows Copilot and Teams composers behave — instead of a
     resize grip. */
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || 20;
    const chrome = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    const max = Math.round(line * COMPOSER_MAX_LINES + chrome);
    element.style.height = "auto";
    const wanted = element.scrollHeight + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
    element.style.height = `${Math.min(wanted, max)}px`;
    element.style.overflowY = wanted > max ? "auto" : "hidden";
  }, [prompt]);
  const selected = providers.find((item) => item.id === provider);
  const ready = selected?.state === "ready";
  const messages = useMemo(() => sessionMessages.slice(-4), [sessionMessages]);
  const empty = !messages.length && !pendingPrompt && !activity.length && !error && !requestId;

  useEffect(() => {
    setSessionMessages([]);
    setActivity([]);
    setError(null);
    setPendingPrompt(null);
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
    if (panel) panel.scrollTop = panel.scrollHeight;
  }, [activity, messages, error, pendingPrompt, requestId]);

  /* The text box is disabled while a turn runs; keep the focus in the pane
     (on the stop button) so Esc still reaches it. */
  useEffect(() => {
    if (requestId && document.activeElement === field.current) cancelButton.current?.focus();
  }, [requestId]);

  const blockedDetail = selected && !ready
    ? [selected.detail, providerNextStep(selected)].filter(Boolean).join(" ")
    : null;
  const placeholder = ready
    ? mode === "image" ? "Ask Slop to compose an image or refine the layout" : `Ask Slop about ${context}`
    : blockedDetail ?? "No agent provider is available";
  const providerStatusLabel = requestId && selected
    ? `${selected.label} status: Processing`
    : selected
    ? `${selected.label} status: ${providerStateLabel(selected.state)}`
    : "Agent status: Unavailable";

  const send = async () => {
    const clean = prompt.trim();
    if (!clean || !ready || requestId) return;
    onPromptStart();
    const id = crypto.randomUUID();
    activeRequest.current = id;
    setRequestId(id);
    setError(null);
    setPendingPrompt(clean);
    setLastPrompt(clean);
    setActivity([]);
    try {
      // The native agent uses this legacy field to select its instructions.
      // Override only the request snapshot, never the saved project document.
      const response = await runAgentTurn({ ...record, config: { ...record.config, generationType: mode } }, provider, clean, id, sessionMessages);
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
      requestAnimationFrame(() => field.current?.focus());
    }
  };
  const cancel = () => { if (requestId) void cancelAgentTurn(requestId); };
  const clear = () => {
    setSessionMessages([]);
    setActivity([]);
    setError(null);
    setPendingPrompt(null);
  };

  return (
    <div
      className="agent-dock"
      onKeyDown={(event) => {
        // Esc stops a running turn, from anywhere in the pane.
        if (event.key === "Escape" && requestId && !event.defaultPrevented) {
          event.preventDefault();
          cancel();
        }
      }}
    >
      <PaneHeader
        className="agent-dock__header"
        views={<>
          <span className={`agent-provider-light agent-provider--${selected?.state ?? "unknown"}`} role="img" aria-label={providerStatusLabel} data-tooltip={blockedDetail ?? providerStatusLabel}><i /></span>
          <ComboBox
            className="agent-provider"
            aria-label="Agent provider"
            value={provider}
            disabled={Boolean(requestId) || !providers.length}
            placeholder="Choose LLM"
            options={providers.map((item) => ({
              value: item.id,
              label: item.label,
              icon: <span className={`agent-provider-light agent-provider--${item.state}`}><i /></span>,
              description: item.state === "ready" ? undefined : providerStateLabel(item.state),
            }))}
            onChange={(next) => { setProvider(next as ProviderId); saveAgentProvider(next as ProviderId); }}
          />
        </>}
        actions={<>
          <button type="button" className="icon-button agent-dock__action" aria-label="Clear conversation" {...tooltipProps("Clear conversation")} disabled={Boolean(requestId) || empty} onClick={clear}><Clear16 aria-hidden="true" /></button>
          {onClose && <button type="button" className="icon-button agent-dock__action" aria-label="Close agent" {...tooltipProps("Close")} onClick={onClose}><Dismiss16 aria-hidden="true" /></button>}
        </>}
      />
      <div ref={conversation} className="agent-conversation" role="log" aria-label="Slop output" aria-live="polite">
        {empty && <EmptyState
          className="agent-conversation__empty"
          icon={<Agent32 />}
          title="Nothing asked yet"
          description={`Ask Slop to write scenes from a prompt, refine shots or edit ${context}.`}
        />}
        {messages.map((message) => <p key={message.id} className={`agent-conversation__${message.role}`}><b>{message.role === "user" ? "You" : "Slop"}</b><span>{message.content}</span></p>)}
        {pendingPrompt && <p className="agent-conversation__pending"><b>You</b><span>{pendingPrompt}</span></p>}
        {activity.map((item, index) => <p key={`${item.kind}-${index}`} className={`agent-conversation__${item.kind}`}>
          <b>{activityLabel(item.kind)}</b><span>{item.text}</span>
        </p>)}
        {error && <p className="agent-conversation__error"><b>Slop</b><span>Couldn’t finish that request. {error}</span></p>}
        {requestId && <p className="agent-conversation__waiting" aria-label="Waiting for the next agent response">
          <b>Slop</b><span className="agent-conversation__thinking"><ProgressRing size={16} aria-label="Thinking" /><span aria-hidden="true">Thinking…</span></span>
        </p>}
      </div>
      <form className="agent-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea
          ref={field}
          className="text-field agent-composer__field"
          aria-label={`Ask Slop about ${context}`}
          aria-keyshortcuts="Enter Shift+Enter ArrowUp Escape"
          rows={2}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            // Up in an empty box brings back the last prompt, like a shell.
            if (event.key === "ArrowUp" && !prompt && lastPrompt) {
              event.preventDefault();
              setPrompt(lastPrompt);
              return;
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          placeholder={placeholder}
          data-tooltip={ready ? undefined : placeholder}
          disabled={!ready || Boolean(requestId)}
        />
        {requestId
          ? <button ref={cancelButton} type="button" className="agent-composer__send agent-cancel" onClick={cancel} aria-label="Cancel agent turn" aria-keyshortcuts="Escape" {...tooltipProps("Stop", "Esc")}><Stop14 aria-hidden="true" /></button>
          : <button type="submit" className="agent-composer__send" disabled={!prompt.trim() || !ready} aria-label="Send to Slop" aria-keyshortcuts="Enter" {...tooltipProps(ready ? "Send" : blockedDetail ?? "No agent provider is available", ready ? "Enter" : undefined)}><Send16 aria-hidden="true" /></button>}
      </form>
    </div>
  );
}

const activityLabel = (kind: AgentActivity["kind"]): string => {
  switch (kind) {
    case "output": return "Slop";
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
