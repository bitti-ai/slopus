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
  folderPath: "C:\\PolStudio\\Prompt panel",
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

describe("Pol output panel", () => {
  it("can always expand and collapse, and expands itself while a turn is running", async () => {
    let finish!: (value: Awaited<ReturnType<typeof runAgentTurn>>) => void;
    vi.mocked(runAgentTurn).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const record = project();
    render(<AgentDock context="this generation queue" record={record} providers={providers} onRecord={() => undefined} />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole("log", { name: "Pol output" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Pol output" }));
    expect(screen.getByRole("log", { name: "Pol output" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Pol output" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Ask Pol about this generation queue" }), { target: { value: "Create four shots" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Pol" }));
    await waitFor(() => expect(runAgentTurn).toHaveBeenCalled());
    const log = screen.getByRole("log", { name: "Pol output" });
    expect(log).toHaveTextContent("Sending this request to Codex");
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 900 });
    const toggle = screen.getByRole("button", { name: "Collapse Pol output" });
    expect(toggle.closest(".agent-dock-row")).not.toBeNull();
    expect(toggle.closest(".agent-dock")).toBeNull();

    const requestId = vi.mocked(runAgentTurn).mock.calls[0][3];
    act(() => eventHandler?.({ payload: { requestId, event: { type: "message", text: "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"kind\\\":\\\"mutation\\\",\\\"summary\\\":\\\"Drafted the scene.\\\",\\\"project\\\":{}}\"}}" } } }));
    act(() => eventHandler?.({ payload: { requestId, event: { type: "validation", round: 1, maxRounds: 3, text: "Shot 4 starts at 18 seconds." } } }));
    expect(screen.getByRole("log", { name: "Pol output" })).toHaveTextContent("Drafted the scene.");
    expect(screen.getByRole("log", { name: "Pol output" })).toHaveTextContent("Correction 1 of 3: Shot 4 starts at 18 seconds.");
    expect(log.scrollTop).toBe(900);

    await act(async () => finish({ result: { kind: "answer", content: "Done" }, events: [], record }));
  });

  it("extracts model-authored content from provider transport records", () => {
    expect(readableProviderOutput('{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"kind\\":\\"answer\\",\\"content\\":\\"Ready to render.\\"}"}]}}'))
      .toBe("Ready to render.");
    expect(readableProviderOutput("plain provider output")).toBe("plain provider output");
  });
});
