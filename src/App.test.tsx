// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { ProjectCard, relativeDate } from "./components/ProjectCard";
import { chooseOption, comboValue, optionNames } from "./components/workspace/comboTestUtils";
import { installBrowserGuards } from "./lib/nativeShell";
import { agentPaneMax } from "./components/ProjectWorkspace";
import { createProjectConfig, STORY_TRACK_ID } from "./lib/project";

describe("how long ago a project was edited", () => {
  afterEach(cleanup);
  const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

  it("says what is true, including inside the first hour", () => {
    // N8: this used to floor at an hour, so a project saved two seconds ago was
    // labelled "Edited 1h ago" — the card's one claim about the project's life,
    // wrong for the whole first hour of it.
    expect(relativeDate(secondsAgo(2))).toBe("just now");
    expect(relativeDate(secondsAgo(59))).toBe("just now");
    expect(relativeDate(secondsAgo(90))).toBe("1 min ago");
    expect(relativeDate(secondsAgo(59 * 60))).toBe("59 min ago");
    expect(relativeDate(secondsAgo(60 * 60))).toBe("1h ago");
    // Elapsed time, not the nearest label: 1h59m is not two hours yet.
    expect(relativeDate(secondsAgo(119 * 60))).toBe("1h ago");
    expect(relativeDate(secondsAgo(26 * 3_600))).toBe("1d ago");
    // A clock that has moved backwards since the save is not a project edited
    // in the future.
    expect(relativeDate(secondsAgo(-30))).toBe("just now");
  });

  it("prints a just-saved project as just saved", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container } = render(<ProjectCard project={{ folderPath: "C:\\Ceramic Lamp", config }} index={0} onOpen={() => undefined} />);
    expect(container.querySelector(".project-card__meta")!.textContent).toContain("Edited just now");
  });

  it("states its selection through the shared selectable-card rule", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(<ProjectCard project={{ folderPath: "C:\\Ceramic Lamp", config }} selected onOpen={() => undefined} />);
    const card = screen.getByRole("option", { name: "Ceramic lamp" });
    expect(card).toHaveAttribute("aria-selected", "true");
    expect(card).toHaveClass("ui-selectable", "ui-selectable--card");
    expect(card).not.toHaveClass("project-card--selected");
  });

  it("uses the first visual timeline asset as the project cover", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    config.assets = [{
      id: "asset-cover", kind: "video", name: "Opening shot", relativePath: "media/opening.mp4", sourcePath: null,
      mimeType: "video/mp4", durationMs: 5_000, width: 1920, height: 1080, createdAt: config.createdAt,
    }];
    config.timeline.tracks = config.timeline.tracks.map((track) => track.id === STORY_TRACK_ID ? { ...track, clips: [{
      id: "clip-cover", assetId: "asset-cover", trackId: track.id, startMs: 2_000, durationMs: 3_000,
      sourceStartMs: 750, label: "Opening shot", color: null, status: "approved",
    }] } : track);
    const { container } = render(<ProjectCard project={{ folderPath: "C:\\Ceramic Lamp", config }} index={0} onOpen={() => undefined} />);
    expect(container.querySelector(".project-card__thumb > .media-thumb")?.getAttribute("aria-label")).toBe("Opening shot");
  });
});

describe("project library controls", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("loads a saved image project with a generated cover and no timeline clips", async () => {
    const config = createProjectConfig({ name: "Saved illustration", prompt: "A ceramic lamp", generationType: "image", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    config.assets = [{
      id: "image-cover", kind: "image", name: "Generated illustration", relativePath: "media/illustration.jpg", sourcePath: null,
      mimeType: "image/jpeg", durationMs: null, width: 1920, height: 1088, createdAt: config.createdAt,
    }];
    config.imageScene!.outputAssetId = "image-cover";
    expect(config.timeline.tracks.every((track) => track.clips.length === 0)).toBe(true);
    localStorage.setItem("slopus.web-projects.v1", JSON.stringify([{ folderPath: "~/Slopus/Saved illustration", config }]));

    render(<App />);

    const card = await screen.findByRole("option", { name: "Saved illustration" });
    expect(card.querySelector(".media-thumb")).toHaveAttribute("aria-label", "Generated illustration");
    // One click selects, like a GridView item; it does not open.
    fireEvent.click(card);
    expect(card).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Editor" })).toBeNull();
    fireEvent.doubleClick(card);
    expect(await screen.findByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
    const again = await screen.findByRole("option", { name: "Saved illustration" });
    // The tile that was opened is still the selected one, and Enter opens it.
    expect(again).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(again, { key: "Enter" });
    expect(await screen.findByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
  });

  it("uses a named New Project form with a default Look instead of a length", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByRole("dialog", { name: "New project" })).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Untitled video");
    expect(screen.queryByRole("textbox", { name: "Describe your video" })).toBeNull();
    expect(screen.queryByText("What do you want to make?")).toBeNull();
    expect(screen.queryByText(/Add reference images/)).toBeNull();
    expect(screen.queryByText(/Not sure where to start/)).toBeNull();

    expect(screen.queryByLabelText("Length in seconds")).toBeNull();
    expect(screen.queryByLabelText("Length slider")).toBeNull();
    const look = screen.getByRole("combobox", { name: "Look" });
    expect(comboValue(look)).toBe("");
    chooseOption(look, /^watercolor$/i);
    expect(comboValue(look)).toBe("watercolor");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
  });

  it("puts the brand in the title bar, focuses search with Ctrl+F and switches between grid and list", async () => {
    const { container } = render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    // 16px icon, "Slopus" and the version and channel as the window caption; no web header.
    expect(container.querySelector(".titlebar__title")?.textContent).toBe("Slopus");
    expect(container.querySelector(".titlebar__secondary")?.textContent).toBe(`v${__APP_VERSION__} - Alpha`);
    expect(container.querySelector(".titlebar__icon img")?.getAttribute("src")).toContain("marketing/icon.png");
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(container.querySelector("kbd")).toBeNull();

    const search = screen.getByRole("searchbox", { name: "Search projects" });
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(search);

    const list = screen.getByRole("button", { name: "List view" });
    fireEvent.click(list);
    expect(list.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".project-grid--list")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More options for Northern Light — Brand Film" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Delete project…"]);
  });

  it("answers Ctrl+F and Alt+Left through the browser guard, which only blocks what the app left alone", async () => {
    const uninstall = installBrowserGuards();
    try {
      render(<App />);
      await screen.findByText("Northern Light — Brand Film");
      const search = screen.getByRole("searchbox", { name: "Search projects" });
      const find = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
      act(() => { document.body.dispatchEvent(find); });
      expect(document.activeElement).toBe(search);
      expect(find.defaultPrevented).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      const settings = screen.getByRole("main", { name: "Settings" });
      const back = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
      act(() => { settings.dispatchEvent(back); });
      expect(screen.queryByRole("main", { name: "Settings" })).toBeNull();
      expect(back.defaultPrevented).toBe(true);
      // Nothing claims Alt+Left in the library: still no browser Back.
      const idle = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
      document.body.dispatchEvent(idle);
      expect(idle.defaultPrevented).toBe(true);
    } finally { uninstall(); }
  });

  it("opens the tile menu with a right-click and moves the selection with the arrow keys", async () => {
    // Opening a video project mounts the program monitor; jsdom plays nothing.
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    const tiles = screen.getAllByRole("option");
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.map((tile) => tile.tabIndex)).toEqual(tiles.map((_, index) => index === 0 ? 0 : -1));
    fireEvent.contextMenu(tiles[1], { clientX: 40, clientY: 40 });
    expect(tiles[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(await screen.findByRole("button", { name: "Back to project library" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
    const again = await screen.findAllByRole("option");
    again[1].focus();
    fireEvent.keyDown(again[1], { key: "ArrowLeft" });
    expect(again[0]).toHaveFocus();
    expect(again[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(again[0], { key: "End" });
    expect(again.at(-1)).toHaveFocus();
  });

  it("confirms permanent project deletion before removing it from the library", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "More options for Northern Light — Brand Film" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete project…" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete “Northern Light — Brand Film”?" });
    expect(dialog.textContent).toContain("permanently deletes the project folder and every file inside it");
    expect(dialog.textContent).toContain("~/Slopus/Northern Light");
    // Cancel is the default answer.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Northern Light — Brand Film")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More options for Northern Light — Brand Film" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete project…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("Northern Light — Brand Film")).toBeNull());
    const stored = JSON.parse(localStorage.getItem("slopus.web-projects.v1") ?? "[]") as Array<{ config: { id: string } }>;
    expect(stored.some((project) => project.config.id === "sample-1")).toBe(false);
    expect(screen.getByText("2 projects")).not.toBeNull();
  });

  it("answers the app accelerators: Ctrl+N and Ctrl+,", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.keyDown(document.body, { key: "n", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New project" })).toBeNull();
    fireEvent.keyDown(document.body, { key: ",", ctrlKey: true });
    expect(screen.getByRole("main", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Projects" })).toBeNull();
  });

  it("offers frame sizes MiniMax H3 can generate, relabelled when the shape changes", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const shape = screen.getByRole("combobox", { name: "Aspect ratio" });
    const size = screen.getByRole("combobox", { name: "Resolution" });

    // The ladder the user asked for, in pixels rather than a name for them.
    expect(optionNames(size)).toEqual([
      "736 × 416", "960 × 544", "1152 × 640", "1376 × 768 (default)", "1920 × 1088", "2432 × 1344", "2720 × 1536", "3648 × 2048",
    ]);
    // Every edge a multiple of 32 — the whole reason the old 720p/1080p/4K
    // ladder was replaced.
    for (const option of optionNames(size)) {
      const [width, height] = option.split(" (")[0].split(" × ").map(Number);
      expect([width % 32, height % 32]).toEqual([0, 0]);
    }

    /* A frame size is two numbers, and one of them changes with the shape. The
       old labels ("1080p HD") could sit above either and say nothing. */
    chooseOption(shape, "Vertical 9:16");
    expect(optionNames(size)).toEqual([
      "416 × 736", "544 × 960", "640 × 1152", "768 × 1376 (default)", "1088 × 1920", "1344 × 2432", "1536 × 2720", "2048 × 3648",
    ]);

    chooseOption(size, "544 × 960");
    expect(comboValue(size)).toBe("544p");
  });

  it("opens a newly named empty project with the agent pane showing", async () => {
    localStorage.setItem("slopus.workspace.agentPane", "closed");
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Ceramic lamp film" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    // A new project starts with the Agent, even if the pane was last closed.
    const pane = await screen.findByRole("complementary", { name: "Agent" });
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Edit project settings for Ceramic lamp film" })).toBeInTheDocument();
    expect(screen.queryByText("First scene")).toBeNull();
    const draft = within(pane).getByRole("textbox", { name: /Ask Slop about/ });
    fireEvent.change(draft, { target: { value: "Keep this unfinished idea" } });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("main", { name: "Settings" });
    expect(screen.queryByRole("textbox", { name: /Ask Slop about/ })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    fireEvent.keyDown(settings, { key: "Escape" });
    expect(screen.queryByRole("main", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("textbox", { name: /Ask Slop about/ })).toBe(draft);
    expect(draft).toHaveValue("Keep this unfinished idea");
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus());
    // The pane header's close button hides the pane and hands focus back to
    // the title-bar toggle.
    fireEvent.click(within(pane).getByRole("button", { name: "Close agent" }));
    expect(pane).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Agent" })).toHaveFocus();
  });

  it("keeps the agent pane to about a third of the window", () => {
    // At the 900px window minimum the 360px default would take 40% of it.
    expect(agentPaneMax(900)).toBe(315);
    expect(agentPaneMax(1600)).toBe(560);
    expect(agentPaneMax(2560)).toBe(640);
    expect(agentPaneMax(600)).toBe(280);
  });

  it("creates an empty project when the new-project form is left blank", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByRole("dialog", { name: "New project" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("complementary", { name: "Agent" })).toBeVisible();
    expect(screen.getAllByText("Untitled video").length).toBeGreaterThan(0);
    expect(screen.queryByText("First scene")).toBeNull();
  });

  it("reports a project it can’t read instead of dropping it from the library", async () => {
    const readable = createProjectConfig({ name: "Readable film", prompt: "A calm kitchen scene", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    localStorage.setItem("slopus.web-projects.v1", JSON.stringify([
      { folderPath: "~/Slopus/Readable", config: readable },
      // Written by a looser validator than the zod schema, so it fails to parse.
      { folderPath: "~/Slopus/Broken", config: { ...readable, schemaVersion: 99 } },
    ]));
    render(<App />);
    // The good row still loads…
    expect(await screen.findByText("Readable film")).not.toBeNull();
    // …and the bad one is named rather than silently vanishing.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("ui-infobar");
    expect(alert.textContent).toContain("couldn’t be read");
    expect(alert.textContent).toContain("~/Slopus/Broken");
  });
});
