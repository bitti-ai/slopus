import { listen } from "@tauri-apps/api/event";
import { Agent32, Clear16, Dismiss16, Send16, Stop14 } from "../ui/icons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { describeDiagnosticError, errorContext, writeDiagnostic } from "../../lib/diagnostics";
import { isTauri } from "../../lib/persistence";
import {
  AGENT_TURN_EVENT,
  cancelAgentTurn,
  type AgentTurnEvent,
  type AgentScope,
  type AgentTurnEventPayload,
  type AgentCommand,
  type ProviderId,
  type ProviderStatus,
} from "../../lib/runtime";
import { runAgentWorkflow, type AgentGenerationHost } from "../../lib/agentWorkflow";
import { loadAgentProvider, saveAgentProvider } from "../../lib/settings";
import type { ProjectRecord } from "../../lib/project";
import type { AgentMessage } from "../../lib/project";
import { ComboBox, EmptyState, PaneHeader, ProgressRing, tooltipProps } from "../ui";
import { MessageText } from "./MessageText";
import { readableProviderOutput } from "../../lib/agentOutput";
export { readableProviderOutput } from "../../lib/agentOutput";

/** How tall the prompt box grows before it scrolls. */
export const COMPOSER_MAX_LINES = 6;

export interface AgentActivity {
  kind: "output" | "diagnostic" | "validation";
  text: string;
}

interface TranscriptMessage {
  id: string;
  kind: AgentActivity["kind"] | "user" | "assistant" | "error";
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
export function AgentDock({ context, record, scope = "project", mode = record.config.generationType === "image" ? "image" : "video", providers, onPromptStart, onCommands, onClose, onBusyChange, generation }: {
  context: string;
  scope?: AgentScope;
  record: ProjectRecord;
  /** Active editor context; legacy project types no longer restrict capabilities. */
  mode?: "video" | "image";
  providers: ProviderStatus[];
  /** @deprecated The dock is always a pane now; kept so callers need not change. */
  expanded?: boolean;
  onPromptStart: () => void;
  onCommands: (commands: AgentCommand[]) => Promise<void>;
  generation?: AgentGenerationHost;
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
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const seenActivity = useRef(new Set<string>());
  const [sessionMessages, setSessionMessages] = useState<AgentMessage[]>([]);
  const activeRequest = useRef<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const [workDetail, setWorkDetail] = useState<string | null>(null);
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
  const empty = !transcript.length && !requestId;

  const appendActivity = (item: AgentActivity | { kind: "assistant" | "error"; text: string }) => {
    // CLIs can emit the same reply in both a message and a final result.
    // Deduplicate only within this turn; never replace a posted message.
    const key = `${item.kind === "assistant" ? "output" : item.kind}\0${item.text}`;
    if (seenActivity.current.has(key)) return;
    seenActivity.current.add(key);
    const message = { ...item, id: crypto.randomUUID() };
    setTranscript((current) => [...current, message]);
  };

  useEffect(() => {
    setSessionMessages([]);
    setTranscript([]);
    seenActivity.current.clear();
    setRequestId(null);
    setWorkDetail(null);
  }, [record.config.id, record.folderPath]);

  useEffect(() => () => {
    activeController.current?.abort(new Error("Agent request cancelled."));
    if (activeRequest.current) void cancelAgentTurn(activeRequest.current);
    activeRequest.current = null;
    activeController.current = null;
  }, [record.config.id, record.folderPath]);

  /* One listener lives for the dock's lifetime. A request id filters out any
     delayed event from a turn the user already cancelled or replaced. */
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<AgentTurnEventPayload>(AGENT_TURN_EVENT, ({ payload }) => {
      if (payload.requestId !== activeRequest.current || activeController.current?.signal.aborted) return;
      const item = activityFromEvent(payload.event);
      if (!item) return;
      appendActivity(item);
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
  }, [transcript, requestId, workDetail]);

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
    if (!clean || !ready || activeRequest.current) return;
    onPromptStart();
    const id = crypto.randomUUID();
    activeRequest.current = id;
    setRequestId(id);
    const userMessage: AgentMessage = { id: crypto.randomUUID(), role: "user", content: clean, createdAt: new Date().toISOString() };
    setTranscript((current) => [...current, { id: userMessage.id, kind: "user", text: clean }]);
    setLastPrompt(clean);
    setPrompt("");
    seenActivity.current.clear();
    const controller = new AbortController();
    activeController.current = controller;
    try {
      // The native agent uses this legacy field to select its instructions.
      // Override only the request snapshot, never the saved project document.
      setWorkDetail(null);
      const response = await runAgentWorkflow({ ...record, config: { ...record.config, generationType: mode } },
        provider, clean, id, sessionMessages, controller.signal, generation,
        (detail) => { if (activeRequest.current === id) setWorkDetail(readableProviderOutput(detail)); }, scope);
      controller.signal.throwIfAborted();
      if (activeRequest.current !== id) return;
      if ("commands" in response.result) await onCommands(response.result.commands);
      controller.signal.throwIfAborted();
      if (activeRequest.current !== id) return;
      const content = "summary" in response.result ? response.result.summary : response.result.content;
      setSessionMessages((current) => [...current, userMessage,
        { id: crypto.randomUUID(), role: "assistant", content, createdAt: new Date().toISOString() }]);
      const text = readableProviderOutput(content);
      if (text) appendActivity({ kind: "assistant", text });
    } catch (reason) {
      if (activeRequest.current !== id) return;
      if (controller.signal.aborted) {
        appendActivity({ kind: "assistant", text: "Request stopped." });
      } else {
        const detail = describeDiagnosticError(reason);
        writeDiagnostic("error", "agent", "turn.failed", detail, { requestId: id, provider, projectId: record.config.id, ...errorContext(reason) });
        const readable = readableProviderOutput(detail);
        appendActivity({ kind: "error", text: `Couldn’t finish that request.${readable ? ` ${readable}` : ""}` });
      }
    } finally {
      if (activeRequest.current === id) {
        const restoreFocus = document.activeElement === field.current || document.activeElement === cancelButton.current;
        activeRequest.current = null;
        activeController.current = null;
        setWorkDetail(null);
        setRequestId(null);
        if (restoreFocus) requestAnimationFrame(() => field.current?.focus());
      }
    }
  };
  const cancel = () => {
    activeController.current?.abort(new Error("Agent request cancelled."));
    if (requestId) void cancelAgentTurn(requestId);
  };
  const clear = () => {
    setSessionMessages([]);
    setTranscript([]);
    seenActivity.current.clear();
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
          description={scope === "settings" ? "Ask Slop to configure generators, find weight files or update LoRAs." : `Ask Slop to write scenes from a prompt, refine shots or edit ${context}.`}
        />}
        {transcript.map((item) => <Bubble key={item.id} className={`agent-conversation__${item.kind}`}
          speaker={item.kind === "user" ? "You" : item.kind === "assistant" || item.kind === "error" ? "Slop" : activityLabel(item.kind)}>
          {item.kind === "output" || item.kind === "assistant" ? <MessageText text={item.text} /> : item.text}
        </Bubble>)}
        {requestId && <Bubble className="agent-conversation__waiting" speaker="Slop" aria-label="Waiting for the next agent response">
          <span className="agent-conversation__thinking"><ProgressRing size={16} aria-label={workDetail ? "Working" : "Thinking"} /><span aria-hidden="true">{workDetail ?? "Thinking…"}</span></span>
        </Bubble>}
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

/** One chat bubble: the speaker's name, then what they said. Which side it
 *  sits on (yours right, Slop's left) is the stylesheet's. */
function Bubble({ className, speaker, children, "aria-label": label }: { className: string; speaker: string; children: ReactNode; "aria-label"?: string }) {
  return <div className={`agent-message ${className}`} aria-label={label}>
    <b className="agent-message__speaker">{speaker}</b>
    <div className="agent-message__bubble">{children}</div>
  </div>;
}

const activityLabel =(kind: AgentActivity["kind"]): string => {
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
    case "validation": {
      const text = readableProviderOutput(event.text);
      return { kind: "validation", text: `Correction ${event.round} of ${event.maxRounds}${text ? `: ${text}` : ""}` };
    }
    case "diagnostic": {
      const text = readableProviderOutput(event.text);
      return text ? { kind: "diagnostic", text } : null;
    }
    case "message": {
      const text = readableProviderOutput(event.text);
      return text ? { kind: "output", text } : null;
    }
  }
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
