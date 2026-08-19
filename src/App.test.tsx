// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { createProjectConfig } from "./lib/project";

describe("project library controls", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("can put back words an example chip overwrote", async () => {
    const { container } = render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    const box = screen.getByRole("textbox", { name: "Describe your video" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "a rocket launch over the ocean at dawn" } });
    // While the box holds the user's own words the row says what a click costs.
    expect(container.querySelector(".idea-row__label")!.textContent).toBe("Replace what you’ve written with an example");
    expect(screen.queryByRole("button", { name: /put my words back/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Product reveal" }));
    expect(box.value).toContain("wristwatch");
    // A controlled textarea gives no native undo after a programmatic set, so
    // the only route back is the one the app offers.
    fireEvent.click(screen.getByRole("button", { name: /put my words back/ }));
    expect(box.value).toBe("a rocket launch over the ocean at dawn");
    expect(screen.queryByRole("button", { name: /put my words back/ })).toBeNull();

    // Browsing several examples is the ordinary way the row is used, so the
    // offer must survive it — and must put back the ORIGINAL words, not the
    // example the previous click left behind.
    fireEvent.change(box, { target: { value: "a rocket launch over the ocean at dawn" } });
    fireEvent.click(screen.getByRole("button", { name: "Product reveal" }));
    fireEvent.click(screen.getByRole("button", { name: "Social ad" }));
    fireEvent.click(screen.getByRole("button", { name: "Mini documentary" }));
    fireEvent.click(screen.getByRole("button", { name: /put my words back/ }));
    expect(box.value).toBe("a rocket launch over the ocean at dawn");

    // Replacing an untouched example is not a loss, so nothing is offered.
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Social ad" }));
    fireEvent.click(screen.getByRole("button", { name: "Mini documentary" }));
    expect(screen.queryByRole("button", { name: /put my words back/ })).toBeNull();
  });

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
    // The engine pill is one line now, and in the browser that line is the
    // demo state rather than a paragraph explaining it.
    expect(await screen.findByText("Preview mode")).not.toBeNull();
  });

  it("reports a project it can’t read instead of dropping it from the library", async () => {
    const readable = createProjectConfig({ name: "Readable film", prompt: "A calm kitchen scene", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    localStorage.setItem("polstudio.web-projects.v1", JSON.stringify([
      { folderPath: "~/PolStudio/Readable", config: readable },
      // Written by a looser validator than the zod schema, so it fails to parse.
      { folderPath: "~/PolStudio/Broken", config: { ...readable, schemaVersion: 99 } },
    ]));
    render(<App />);
    // The good row still loads…
    expect(await screen.findByText("Readable film")).not.toBeNull();
    // …and the bad one is named rather than silently vanishing.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("couldn’t be read");
    expect(alert.textContent).toContain("~/PolStudio/Broken");
  });
});
