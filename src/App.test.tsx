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
});
