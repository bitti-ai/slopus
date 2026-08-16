// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import { parseProjectConfig } from "../lib/project";
import { formatDurationTimecode } from "./ProjectWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";

describe("project workspace timecode", () => {
  it("formats project duration as valid hours, minutes, and seconds", () => {
    expect(formatDurationTimecode(0)).toBe("00:00:00");
    expect(formatDurationTimecode(59)).toBe("00:00:59");
    expect(formatDurationTimecode(60)).toBe("00:01:00");
    expect(formatDurationTimecode(600)).toBe("00:10:00");
  });

  it("surfaces native save failures in the workspace", async () => {
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Portable Launch Film", config: parseProjectConfig(completeFixture) },
      onBack: () => undefined,
      onSave: async () => { throw new Error("The original project file is locked."); },
    }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t save project");
    expect(alert.textContent).toContain("The original project file is locked.");
  });
});
