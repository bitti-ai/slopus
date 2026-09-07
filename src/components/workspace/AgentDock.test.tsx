// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectRecord } from "../../lib/project";
import { AGENT_TURN_EVENT, runAgentTurn, type AgentTurnEventPayload, type ProviderStatus } from "../../lib/runtime";
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
  it("shows only the provider light when compact and moves a name-only selector into the Agent controls", async () => {
    const available: ProviderStatus[] = [
      providers[0],
      { id: "claude", label: "Claude Code", state: "ready", executable: "claude", version: "test", detail: "Ready" },
    ];
    const view = (expanded: boolean) => <AgentDock context="this project" record={project()} providers={available} expanded={expanded} onPromptStart={() => undefined} onCommands={async () => undefined} />;
    const app = render(view(false));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole("img", { name: "Codex status: Ready" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Agent provider" })).not.toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();

    app.rerender(view(true));
    expect(screen.getByRole("heading", { name: "What should we create today?" })).toBeInTheDocument();
    expect(screen.queryByText("No activity yet. Send a prompt to start.")).not.toBeInTheDocument();
    const selector = screen.getByRole("combobox", { name: "Agent provider" });
    fireEvent.click(selector);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Codex", "Claude Code"]);
    expect(selector.closest(".agent-dock__actions")).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Claude Code" }));
    expect(selector).toHaveTextContent("Claude Code");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Claude Code status: Ready" })).toBeInTheDocument();
  });

  it("supports keyboard selection and dismisses the provider menu without submitting a prompt", async () => {
    const available: ProviderStatus[] = [providers[0], { ...providers[0], id: "claude", label: "Claude Code" }];
    render(<AgentDock context="this project" record={project()} providers={available} expanded onPromptStart={() => undefined} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });
    const selector = screen.getByRole("combobox", { name: "Agent provider" });
    selector.focus();
    fireEvent.keyDown(selector, { key: "ArrowDown" });
    fireEvent.keyDown(selector, { key: "End" });
    expect(selector).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "Claude Code" }).id);
    fireEvent.keyDown(selector, { key: "Enter" });
    expect(selector).toHaveTextContent("Claude Code");
    expect(selector).toHaveFocus();
    expect(runAgentTurn).not.toHaveBeenCalled();
    fireEvent.click(selector);
    fireEvent.keyDown(selector, { key: "Home" });
    fireEvent.keyDown(selector, { key: "Escape" });
    expect(selector).toHaveTextContent("Claude Code");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.click(selector);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
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

  it("uses the Agent page as its expanded view and requests it when a turn starts", async () => {
    let finish!: (value: Awaited<ReturnType<typeof runAgentTurn>>) => void;
    vi.mocked(runAgentTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const record = project();
    const onPromptStart = vi.fn();
    const view = (expanded: boolean) => <AgentDock context="this generation queue" record={record} providers={providers} expanded={expanded} onPromptStart={onPromptStart} onCommands={async () => undefined} />;
    const app = render(view(false));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole("log", { name: "Slop output" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Slop output/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Agent provider" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Codex status: Ready" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Ask Slop about this generation queue" })).toHaveAttribute("rows", "1");

    fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about this generation queue" }), { target: { value: "Create four shots" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    await waitFor(() => expect(runAgentTurn).toHaveBeenCalled());
    expect(onPromptStart).toHaveBeenCalledTimes(1);

    app.rerender(view(true));
    const log = screen.getByRole("log", { name: "Slop output" });
    expect(screen.getByRole("heading", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Codex status: Processing" })).toHaveClass("agent-provider--ready");
    expect(screen.getByRole("textbox", { name: "Ask Slop about this generation queue" })).toHaveAttribute("rows", "2");
    expect(screen.getByRole("combobox", { name: "Agent provider" })).toHaveTextContent("Codex");
    expect(screen.getByRole("combobox", { name: "Agent provider" })).not.toHaveTextContent("Ready");
    expect(log).toHaveTextContent("Create four shots");
    expect(log).not.toHaveTextContent("Sending this request to Codex");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Agent provider" })).toBeDisabled();
    expect(screen.getByLabelText("Waiting for the next agent response")).toBeInTheDocument();
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 900 });

    const requestId = vi.mocked(runAgentTurn).mock.calls[0][3];
    act(() => eventHandler?.({ payload: { requestId, event: { type: "message", text: "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"op\\\":\\\"scene.remove\\\",\\\"id\\\":\\\"old-scene\\\"}\\n{\\\"op\\\":\\\"commit\\\",\\\"summary\\\":\\\"Drafted the scene.\\\"}\"}}" } } }));
    act(() => eventHandler?.({ payload: { requestId, event: { type: "validation", round: 1, maxRounds: 3, text: "Shot 4 starts at 18 seconds." } } }));
    expect(screen.getByRole("log", { name: "Slop output" })).toHaveTextContent("Drafted the scene.");
    expect(screen.getByRole("log", { name: "Slop output" })).toHaveTextContent("Correction 1 of 3: Shot 4 starts at 18 seconds.");
    expect(screen.getByLabelText("Waiting for the next agent response")).toBe(log.lastElementChild);
    expect(log.scrollTop).toBe(900);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await act(async () => finish({ result: { kind: "answer", content: "Done" }, events: [], messages: [] }));
    expect(screen.getByRole("img", { name: "Codex status: Ready" })).not.toHaveClass("agent-provider-light--busy");
    expect(screen.getByRole("combobox", { name: "Agent provider" })).toBeEnabled();
    expect(screen.queryByLabelText("Waiting for the next agent response")).not.toBeInTheDocument();
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
