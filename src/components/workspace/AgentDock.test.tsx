// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectRecord } from "../../lib/project";
import { AGENT_TURN_EVENT, cancelAgentTurn, runAgentTurn, type AgentTurnEventPayload, type ProviderStatus } from "../../lib/runtime";
import { AgentDock, readableProviderOutput } from "./AgentDock";

let eventHandler: ((event: { payload: AgentTurnEventPayload }) => void) | undefined;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: AgentTurnEventPayload }) => void) => {
    eventHandler = handler;
    return () => { eventHandler = undefined; };
  }),
}));

vi.mock("../../lib/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/runtime")>(),
  runAgentTurn: vi.fn(),
  cancelAgentTurn: vi.fn().mockResolvedValue(true),
}));

const providers: ProviderStatus[] = [
  { id: "codex", label: "Codex", state: "ready", executable: "codex", version: "test", detail: "Ready" },
];

const project = (): ProjectRecord => ({
  folderPath: "C:\\Slopus\\Prompt panel",
  config: createProjectConfig({
    name: "Prompt panel",
    prompt: "A quiet opening",
    aspectRatio: "16:9",
    resolution: "1080p",
    targetDurationSeconds: 15,
  }),
});

beforeEach(() => {
  localStorage.clear();
  eventHandler = undefined;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("Slop output panel", () => {
  it("is a docked pane with a header, a provider picker and a one-line empty state", async () => {
    const available: ProviderStatus[] = [
      providers[0],
      { id: "claude", label: "Claude Code", state: "ready", executable: "claude", version: "test", detail: "Ready" },
    ];
    const onClose = vi.fn();
    render(<AgentDock context="this project" record={project()} providers={available} onPromptStart={() => undefined} onCommands={async () => undefined} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("heading", { name: "Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "What should we create today?" })).not.toBeInTheDocument();
    expect(screen.getByRole("log", { name: "Slop output" })).toHaveTextContent("Ask Slop to write scenes");
    expect(screen.getByRole("img", { name: "Codex status: Ready" })).toBeInTheDocument();
    const selector = screen.getByRole("combobox", { name: "Agent provider" });
    fireEvent.click(selector);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Codex", "Claude Code"]);
    fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));
    expect(selector).toHaveTextContent("Claude Code");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Claude Code status: Ready" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close agent" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("hides the close button when the workspace gives it nothing to close", async () => {
    render(<AgentDock context="this project" record={project()} providers={providers} expanded onPromptStart={() => undefined} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("button", { name: "Close agent" })).not.toBeInTheDocument();
  });

  it("changes provider from the keyboard without submitting a prompt", async () => {
    const available: ProviderStatus[] = [providers[0], { ...providers[0], id: "claude", label: "Claude Code" }];
    render(<AgentDock context="this project" record={project()} providers={available} expanded onPromptStart={() => undefined} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });
    const selector = screen.getByRole("combobox", { name: "Agent provider" });
    selector.focus();
    fireEvent.keyDown(selector, { key: "ArrowDown" });
    expect(selector).toHaveTextContent("Claude Code");
    expect(selector).toHaveFocus();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it("hands an accepted command batch to the workspace before completing the turn", async () => {
    const commands = [{ op: "scene.set" as const, id: "job-initial-brief", title: "Warmer opening" }];
    vi.mocked(runAgentTurn).mockResolvedValue({
      result: { kind: "commands", summary: "Made the opening warmer.", commands },
      events: [],
      messages: [],
    });
    const onCommands = vi.fn(async () => undefined);
    const onPromptStart = vi.fn();
    render(<AgentDock context="this generation queue" record={project()} providers={providers} expanded={false} onPromptStart={onPromptStart} onCommands={onCommands} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about this generation queue" }), { target: { value: "Make it warmer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));

    await waitFor(() => expect(onCommands).toHaveBeenCalledWith(commands));
    expect(onPromptStart).toHaveBeenCalledTimes(1);
  });

  it("shows the running turn with a progress ring, stops it with Esc, and recalls the last prompt with Up", async () => {
    let finish!: (value: Awaited<ReturnType<typeof runAgentTurn>>) => void;
    vi.mocked(runAgentTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onPromptStart = vi.fn();
    render(<AgentDock context="this generation queue" record={project()} providers={providers} onPromptStart={onPromptStart} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });

    const field = screen.getByRole("textbox", { name: "Ask Slop about this generation queue" });
    fireEvent.change(field, { target: { value: "Create four shots" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(runAgentTurn).toHaveBeenCalled());
    expect(onPromptStart).toHaveBeenCalledTimes(1);

    const log = screen.getByRole("log", { name: "Slop output" });
    expect(screen.getByRole("img", { name: "Codex status: Processing" })).toHaveClass("agent-provider--ready");
    expect(screen.getByRole("combobox", { name: "Agent provider" })).toBeDisabled();
    expect(log).toHaveTextContent("Create four shots");
    expect(within(log).getByText("You")).toBeInTheDocument();
    const waiting = screen.getByLabelText("Waiting for the next agent response");
    expect(within(waiting).getByRole("progressbar", { name: "Thinking" })).toBeInTheDocument();
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 900 });

    const requestId = vi.mocked(runAgentTurn).mock.calls[0][3];
    act(() => eventHandler?.({ payload: { requestId, event: { type: "message", text: "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"op\\\":\\\"scene.remove\\\",\\\"id\\\":\\\"old-scene\\\"}\\n{\\\"op\\\":\\\"commit\\\",\\\"summary\\\":\\\"Drafted the scene.\\\"}\"}}" } } }));
    act(() => eventHandler?.({ payload: { requestId, event: { type: "validation", round: 1, maxRounds: 3, text: "Shot 4 starts at 18 seconds." } } }));
    expect(log).toHaveTextContent("Drafted the scene.");
    expect(log).toHaveTextContent("Correction 1 of 3: Shot 4 starts at 18 seconds.");
    expect(screen.getByLabelText("Waiting for the next agent response")).toBe(log.lastElementChild);
    expect(log.scrollTop).toBe(900);

    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel agent turn" }), { key: "Escape" });
    expect(cancelAgentTurn).toHaveBeenCalledWith(requestId);

    await act(async () => finish({ result: { kind: "answer", content: "Done" }, events: [], messages: [] }));
    expect(screen.getByRole("img", { name: "Codex status: Ready" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Agent provider" })).toBeEnabled();
    expect(screen.queryByLabelText("Waiting for the next agent response")).not.toBeInTheDocument();
    expect(field).toHaveValue("");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field).toHaveValue("Create four shots");
  });

  it("clears the conversation from the pane header", async () => {
    vi.mocked(runAgentTurn).mockRejectedValue(new Error("Nope."));
    render(<AgentDock context="this project" record={project()} providers={providers} onPromptStart={() => undefined} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });
    const clear = screen.getByRole("button", { name: "Clear conversation" });
    expect(clear).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about this project" }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    await screen.findByText(/Nope/);
    fireEvent.click(clear);
    expect(screen.queryByText(/Nope/)).not.toBeInTheDocument();
  });

  it("keeps a follow-up visible when the provider times out", async () => {
    vi.mocked(runAgentTurn).mockRejectedValue(new Error("Agent turn timed out after 300 seconds."));
    render(<AgentDock context="this generation queue" record={project()} providers={providers} expanded onPromptStart={() => undefined} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });

    const field = screen.getByRole("textbox", { name: "Ask Slop about this generation queue" });
    fireEvent.change(field, { target: { value: "Leonard and Penny, in live action" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));

    const log = await screen.findByRole("log", { name: "Slop output" });
    expect(log).toHaveTextContent("Leonard and Penny, in live action");
    expect(log).toHaveTextContent("Agent turn timed out after 300 seconds.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(field).toHaveValue("Leonard and Penny, in live action");
  });

  it("extracts model-authored content from provider transport records", () => {
    expect(readableProviderOutput('{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"kind\\":\\"answer\\",\\"content\\":\\"Ready to render.\\"}"}]}}'))
      .toBe("Ready to render.");
    expect(readableProviderOutput("plain provider output")).toBe("plain provider output");
    expect(readableProviderOutput('{"type":"item.completed","item":{"text":"{\\"op\\":\\"scene.remove\\",\\"id\\":\\"old\\"}\\n{\\"op\\":\\"commit\\",\\"summary\\":\\"Removed it.\\"}"}}'))
      .toBe("Removed it.");
  });
});
