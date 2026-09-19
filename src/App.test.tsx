// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { ProjectCard, relativeDate } from "./components/ProjectCard";
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
    expect(container.querySelector(".project-card__art > .media-thumb")?.getAttribute("aria-label")).toBe("Opening shot");
  });
});

describe("project library controls", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

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
    const look = screen.getByRole("combobox", { name: "Default Look" });
    expect(look).toHaveValue("");
    fireEvent.change(look, { target: { value: "watercolor" } });
    expect(look).toHaveValue("watercolor");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
  });

  it("focuses search with Ctrl/Cmd+K and switches between grid and list", async () => {
    const { container } = render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    expect(container.querySelector(".brand__wordmark")?.textContent).toBe("Slopus");
    expect(container.querySelector(".brand__edition")?.textContent).toBe("ALPHA");
    expect(container.querySelector(".brand .slopus-logo__ticket")).toBeNull();
    const icon = container.querySelector(".brand img");
    expect(icon?.getAttribute("src")).toContain("marketing/icon.png");
    expect(icon?.nextElementSibling?.textContent).toBe("Slopus");

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

  it("confirms permanent project deletion before removing it from the library", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "More options for Northern Light — Brand Film" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete Project" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete “Northern Light — Brand Film”?" });
    expect(dialog.textContent).toContain("permanently deletes the project folder and every file inside it");
    expect(dialog.textContent).toContain("~/Slopus/Northern Light");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Northern Light — Brand Film")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More options for Northern Light — Brand Film" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete Project" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

    await waitFor(() => expect(screen.queryByText("Northern Light — Brand Film")).toBeNull());
    const stored = JSON.parse(localStorage.getItem("slopus.web-projects.v1") ?? "[]") as Array<{ config: { id: string } }>;
    expect(stored.some((project) => project.config.id === "sample-1")).toBe(false);
    expect(screen.getByText("2 projects")).not.toBeNull();
  });

  it("offers frame sizes MiniMax H3 can generate, relabelled when the shape changes", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    const shape = screen.getByRole("combobox", { name: /Aspect Ratio/ }) as HTMLSelectElement;
    const size = screen.getByRole("combobox", { name: /Resolution/ }) as HTMLSelectElement;

    // The ladder the user asked for, in pixels rather than a name for them.
    expect([...size.options].map((option) => option.textContent)).toEqual([
      "736 × 416", "960 × 544", "1152 × 640", "1376 × 768 (default)", "1920 × 1088", "2432 × 1344",
    ]);
    // Every edge a multiple of 32 — the whole reason the old 720p/1080p/4K
    // ladder was replaced.
    for (const option of [...size.options]) {
      const [width, height] = option.textContent!.split(" (")[0].split(" × ").map(Number);
      expect([width % 32, height % 32]).toEqual([0, 0]);
    }

    /* A frame size is two numbers, and one of them changes with the shape. The
       old labels ("1080p HD") could sit above either and say nothing. */
    fireEvent.change(shape, { target: { value: "9:16" } });
    expect([...size.options].map((option) => option.textContent)).toEqual([
      "416 × 736", "544 × 960", "640 × 1152", "768 × 1376 (default)", "1088 × 1920", "1344 × 2432",
    ]);

    // The settings header says the same numbers as the always-visible fields.
    fireEvent.change(size, { target: { value: "544p" } });
    expect(document.querySelector(".composer__options-value")!.textContent)
      .toBe("Vertical 9:16 · 544 × 960");
  });

  it("opens a newly named empty project on its Agent starting page", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Ceramic lamp film" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByRole("heading", { name: "What should we create today?" })).not.toBeNull();
    expect(screen.getByText("Ceramic lamp film")).not.toBeNull();
    expect(screen.queryByText("First scene")).toBeNull();
    const draft = screen.getByRole("textbox", { name: /Ask Slop about/ });
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
  });

  it("creates an empty project when the new-project form is left blank", async () => {
    render(<App />);
    await screen.findByText("Northern Light — Brand Film");
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(screen.getByRole("dialog", { name: "New project" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("heading", { name: "What should we create today?" })).not.toBeNull();
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
    expect(alert.textContent).toContain("couldn’t be read");
    expect(alert.textContent).toContain("~/Slopus/Broken");
  });
});
