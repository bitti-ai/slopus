// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const open = () => render(<SettingsView onClose={() => undefined} />);
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

/* jsdom does no layout, so the one thing that can be checked here is that the
   rule which makes the two tabs the same height is still in the sheet: the
   panels differ by hundreds of pixels, and a shrink-to-fit dialog moved the tab
   row out from under the pointer that had just clicked it. */
describe("the frame the tabs sit in", () => {
  it("gives the dialog a height of its own rather than letting the open tab set it", () => {
    const css = readFileSync("src/styles/shell.css", "utf8");
    const rule = css.slice(css.indexOf(".settings-view {"), css.indexOf(".settings-view__body"));
    expect(rule).toMatch(/^\s*height: min\(/m);
    expect(rule).not.toMatch(/^\s*max-height:/m);
  });
});

describe("the settings screen", () => {
  it("opens on the engine, because that is what has to be set before anything renders", async () => {
    open();
    expect(tab("Video engine").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText(/Transformer weights/)).toBeTruthy();
    // The other tab's contents are not merely hidden, they are not rendered:
    // a settings screen that draws both panels is the tall screen tabs replaced.
    expect(screen.queryByLabelText("Appearance")).toBeNull();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Browser preview"));
  });

  it("swaps panels when a tab is chosen, and follows the arrow keys", () => {
    open();
    fireEvent.click(tab("Appearance"));
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeTruthy();
    expect(screen.queryByLabelText(/Transformer weights/)).toBeNull();
    // Each panel is named by the tab that opened it, so a screen reader lands
    // somewhere that says what it is.
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("settings-tab-appearance");

    fireEvent.keyDown(tab("Appearance"), { key: "ArrowRight" });
    expect(tab("Video engine").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("Video engine"), { key: "ArrowLeft" });
    expect(tab("Appearance").getAttribute("aria-selected")).toBe("true");
  });

  it("counts the paths still to set on the engine tab, from either tab", () => {
    open();
    // Four of the five fields are required and none is set yet.
    expect(within(tab("Video engine")).getByText("4")).toBeTruthy();
    fireEvent.click(tab("Appearance"));
    // Still legible from the other side: what is unfinished is the reason the
    // screen was opened, and hiding it behind a tab would bury it.
    expect(within(tab("Video engine")).getByText("4")).toBeTruthy();
  });

  it("keeps the settings header short", () => {
    const { container } = open();
    for (const gone of ["belongs to this computer", "stays behind when", "needs the model files", "ships with the app"]) {
      expect(container.textContent, gone).not.toContain(gone);
    }
    expect(screen.queryByText("This computer")).toBeNull();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByText("Reads your prompt so the transformer can act on it.")).toBeTruthy();
  });

  it("puts the optional tokenizer setting last", () => {
    const { container } = open();
    const labels = Array.from(container.querySelectorAll(".settings-path label b")).map((label) => label.textContent);
    expect(labels.at(-1)).toContain("Tokenizer");
  });

  it("offers Clear all paths only beside the paths", () => {
    open();
    expect(screen.getByRole("button", { name: /Clear all paths/ })).toBeTruthy();
    fireEvent.click(tab("Appearance"));
    expect(screen.queryByRole("button", { name: /Clear all paths/ })).toBeNull();
  });

  it("configures OpenRouter and local OpenAI-compatible models without requiring a local API key", () => {
    open();
    fireEvent.click(tab("Prompt LLMs"));

    const openrouter = screen.getByRole("heading", { name: "OpenRouter" }).closest("section")!;
    expect((within(openrouter).getByLabelText("OpenRouter endpoint") as HTMLInputElement).value).toBe("https://openrouter.ai/api/v1");
    fireEvent.change(within(openrouter).getByLabelText("OpenRouter API key"), { target: { value: "sk-or-test" } });
    fireEvent.change(within(openrouter).getByLabelText("OpenRouter model"), { target: { value: "openai/gpt-test" } });
    expect(openrouter.textContent).toContain("Configured");

    const local = screen.getByRole("heading", { name: "Local OpenAI-compatible" }).closest("section")!;
    fireEvent.change(within(local).getByLabelText("Local OpenAI-compatible endpoint"), { target: { value: "http://localhost:1234/v1" } });
    fireEvent.change(within(local).getByLabelText("Local OpenAI-compatible model"), { target: { value: "local-model" } });
    expect(local.textContent).toContain("Configured");

    const stored = JSON.parse(localStorage.getItem("polstudio.agent-endpoints.v1") ?? "null");
    expect(stored.openrouter).toMatchObject({ apiKey: "sk-or-test", model: "openai/gpt-test" });
    expect(stored.local).toMatchObject({ endpoint: "http://localhost:1234/v1", model: "local-model", apiKey: "" });
  });
});
