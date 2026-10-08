// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectRecord } from "../../lib/project";
import { AGENT_TURN_EVENT, cancelAgentTurn, runAgentTurn, type AgentTurnEventPayload, type ProviderStatus } from "../../lib/runtime";
import { AgentDock, COMPOSER_MAX_LINES, readableProviderOutput } from "./AgentDock";
import { MessageText } from "./MessageText";

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
  it("shows generation progress, resumes automatically and applies the final edits without stealing editor focus", async () => {
    const record = project();
    const command = { op: "scene.generate" as const, scene: record.config.generationJobs[0].id, template: "chosen" };
    const commands = [{ op: "project.set" as const, name: "Reviewed project" }];
    vi.mocked(runAgentTurn).mockResolvedValueOnce({ result: { kind: "generation", summary: "Generate the scene", command }, events: [], messages: [] })
      .mockResolvedValueOnce({ result: { kind: "commands", summary: "Reviewed and renamed", commands }, events: [], messages: [] });
    let complete!: () => void;
    const generation = { getRecord: () => record, generate: vi.fn(async (_command, _signal, onProgress) => {
      onProgress("Encoding the generated video");
      await new Promise<void>((resolve) => { complete = resolve; });
      return { scene: command.scene, template: command.template, status: "completed" as const, detail: "Video saved" };
    }) };
    const onCommands = vi.fn().mockResolvedValue(undefined);
    render(<><input aria-label="Scene editor" /><AgentDock context="this project" record={record} providers={providers}
      onPromptStart={vi.fn()} onCommands={onCommands} generation={generation} /></>);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about this project" }), { target: { value: "Generate and review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    await waitFor(() => expect(screen.getByLabelText("Waiting for the next agent response")).toHaveTextContent("Encoding the generated video"));
    expect(runAgentTurn).toHaveBeenCalledOnce();
    expect(onCommands).not.toHaveBeenCalled();
    const editor = screen.getByRole("textbox", { name: "Scene editor" });
    editor.focus();
    await act(async () => complete());
    await waitFor(() => expect(onCommands).toHaveBeenCalledWith(commands));
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
    expect(editor).toHaveFocus();
    expect(screen.getByText("Reviewed and renamed")).toBeInTheDocument();
  });

  it("applies generator commands through the editor callback", async () => {
    const commands = [{ op: "generator.set" as const, id: "custom", settings: { name: "Renamed" } }];
    vi.mocked(runAgentTurn).mockResolvedValue({ result: { kind: "generatorCommands", summary: "Updated generator", commands }, events: [], messages: [] });
    const onCommands = vi.fn().mockResolvedValue(undefined);
    render(<AgentDock context="this project" record={project()} providers={providers} onPromptStart={vi.fn()} onCommands={onCommands} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about this project" }), { target: { value: "Rename my generator" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    await waitFor(() => expect(onCommands).toHaveBeenCalledWith(commands));
    expect(readableProviderOutput(JSON.stringify({type:"result",result:JSON.stringify({kind:"generatorCommands",summary:"Updated generator",commands})}))).toBe("Updated generator");
  });
  it.each(["video", "image"] as const)("uses the active %s tab for agent instructions without changing the saved project type", async (mode) => {
    const record = project();
    record.config.generationType = mode === "image" ? "video" : "image";
    const original = structuredClone(record.config);
    vi.mocked(runAgentTurn).mockResolvedValue({ result: { kind: "commands", summary: "Done", commands: [] }, events: [], messages: [] });
    render(<AgentDock context="this project" record={record} mode={mode} providers={providers} onPromptStart={vi.fn()} onCommands={async () => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about this project" }), { target: { value: "Make it warmer" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    await waitFor(() => expect(runAgentTurn).toHaveBeenCalledOnce());
    expect(vi.mocked(runAgentTurn).mock.calls[0][0].config.generationType).toBe(mode);
    expect(record.config).toEqual(original);
  });
  it("grows the prompt box with its text up to six lines, then scrolls", async () => {
    // jsdom lays nothing out: report 20px per line of text as the content height.
    const spy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) {
      return Math.max(2, this.value.split("\n").length) * 20;
    });
    try {
      render(<AgentDock context="this project" record={project()} providers={providers} onPromptStart={() => undefined} onCommands={async () => undefined} />);
      await act(async () => { await Promise.resolve(); });
      const box = screen.getByRole("textbox", { name: /Ask Slop about/ }) as HTMLTextAreaElement;
      // jsdom gives a textarea a 1px border, which is added to the content height.
      const border = 2;
      expect(box.style.height).toBe(`${40 + border}px`);
      fireEvent.change(box, { target: { value: "one\ntwo\nthree\nfour" } });
      expect(box.style.height).toBe(`${80 + border}px`);
      expect(box.style.overflowY).toBe("hidden");
      fireEvent.change(box, { target: { value: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") } });
      const style = getComputedStyle(box);
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      expect(box.style.height).toBe(`${COMPOSER_MAX_LINES * 20 + padding + border}px`);
      expect(box.style.overflowY).toBe("auto");
    } finally { spy.mockRestore(); }
  });

  it("is a docked pane with a toolbar, a provider picker and the shared empty state", async () => {
    const available: ProviderStatus[] = [
      providers[0],
      { id: "claude", label: "Claude Code", state: "ready", executable: "claude", version: "test", detail: "Ready" },
    ];
    const onClose = vi.fn();
    render(<AgentDock context="this project" record={project()} providers={available} onPromptStart={() => undefined} onCommands={async () => undefined} onClose={onClose} />);
    await act(async () => { await Promise.resolve(); });

    // A pane toolbar, not a title bar: the workspace's aside names the pane.
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Slop output" });
    expect(log.querySelector(".ui-empty-state .ui-empty-state__title")).toHaveTextContent("Nothing asked yet");
    expect(log).toHaveTextContent("Ask Slop to write scenes");
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

  it.each(["Enter", "button"])("clears the composer on %s submission, stops with Esc, and recalls the last prompt with Up", async (submit) => {
    let finish!: (value: Awaited<ReturnType<typeof runAgentTurn>>) => void;
    vi.mocked(runAgentTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const onPromptStart = vi.fn();
    render(<AgentDock context="this generation queue" record={project()} providers={providers} onPromptStart={onPromptStart} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });

    const field = screen.getByRole("textbox", { name: "Ask Slop about this generation queue" });
    fireEvent.change(field, { target: { value: "Create four shots" } });
    if (submit === "Enter") fireEvent.keyDown(field, { key: "Enter" });
    else fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    expect(field).toHaveValue("");
    expect(field).toBeDisabled();
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
    expect(field).toHaveValue("");
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field).toHaveValue("Leonard and Penny, in live action");
  });

  it("shows one reply per turn: no repeated drafts while working, only the answer once done", async () => {
    let finish!: (value: Awaited<ReturnType<typeof runAgentTurn>>) => void;
    vi.mocked(runAgentTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<AgentDock context="this project" record={project()} providers={providers} onPromptStart={() => undefined} onCommands={async () => undefined} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about this project" }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    await waitFor(() => expect(runAgentTurn).toHaveBeenCalled());
    const requestId = vi.mocked(runAgentTurn).mock.calls[0][3];
    const log = screen.getByRole("log", { name: "Slop output" });

    const send = (event: AgentTurnEventPayload["event"]) => act(() => eventHandler?.({ payload: { requestId, event } }));
    send({ type: "message", text: "First draft." });
    send({ type: "message", text: "First draft." });
    send({ type: "validation", round: 1, maxRounds: 3, text: "Too short." });
    send({ type: "message", text: "Second draft." });
    send({ type: "validation", round: 2, maxRounds: 3, text: "Still short." });
    expect(log.querySelectorAll(".agent-conversation__output")).toHaveLength(1);
    expect(log.querySelectorAll(".agent-conversation__validation")).toHaveLength(1);
    expect(log).toHaveTextContent("Second draft.");
    expect(log).not.toHaveTextContent("First draft.");

    await act(async () => finish({ result: { kind: "answer", content: "Hello **there**." }, events: [], messages: [
      { id: "u", role: "user", content: "Hi", createdAt: "" },
      { id: "a", role: "assistant", content: "Hello **there**.", createdAt: "" },
    ] as never }));
    expect(log.querySelectorAll(".agent-conversation__output, .agent-conversation__validation")).toHaveLength(0);
    expect(log.querySelectorAll(".agent-conversation__assistant")).toHaveLength(1);
    expect(within(log).getByText("there").tagName).toBe("STRONG");
  });

  it("formats Slop's replies as a message", () => {
    const { container } = render(<MessageText text={"Plan:\n\n1. Open on the lamp\n2. Pan to `shot-2`\n\n- *warm* light\n- soft shadows\n\n```\nscene.set\n```"} />);
    expect(container.querySelector("p")).toHaveTextContent("Plan:");
    expect([...container.querySelectorAll("ol > li")].map((item) => item.textContent)).toEqual(["Open on the lamp", "Pan to shot-2"]);
    expect(container.querySelector("ol code")).toHaveTextContent("shot-2");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelector("ul em")).toHaveTextContent("warm");
    expect(container.querySelector("pre")).toHaveTextContent("scene.set");
  });

  it("extracts model-authored content from provider transport records", () => {
    expect(readableProviderOutput('{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"kind\\":\\"answer\\",\\"content\\":\\"Ready to render.\\"}"}]}}'))
      .toBe("Ready to render.");
    expect(readableProviderOutput("plain provider output")).toBe("plain provider output");
    expect(readableProviderOutput('{"type":"item.completed","item":{"text":"{\\"op\\":\\"scene.remove\\",\\"id\\":\\"old\\"}\\n{\\"op\\":\\"commit\\",\\"summary\\":\\"Removed it.\\"}"}}'))
      .toBe("Removed it.");
  });
});
