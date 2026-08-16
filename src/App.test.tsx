// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";

describe("project library controls", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("focuses search with Ctrl/Cmd+K and switches between grid and list", async () => {
    const { container } = render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    expect(container.querySelector(".brand .pol-logo")).not.toBeNull();
    expect(container.querySelector(".brand img")).toBeNull();

    const search = screen.getByRole("textbox", { name: "Search projects" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(search);

    const list = screen.getByRole("button", { name: "List view" });
    fireEvent.click(list);
    expect(list.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".project-grid--list")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More options for Northern Light — Brand Film" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Open project" })).not.toBeNull());
  });

  it("opens a prompt-created project in Generator with its initial draft selected", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.change(screen.getByRole("textbox", { name: "Describe your video" }), { target: { value: "A quiet product film for a ceramic lamp" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await screen.findByRole("heading", { name: "Generator" });
    expect(screen.getByRole("heading", { name: "First scene" })).not.toBeNull();
    expect(screen.getByText("Generation runtime unavailable")).not.toBeNull();
  });
});
