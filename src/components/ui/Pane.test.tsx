// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneHeader } from "./Chrome";
import { SelectorBar } from "./Controls";
import { EmptyState, ItemHeader } from "./Pane";
import { PropSection } from "./PropRow";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("ItemHeader", () => {
  it("names the item as a heading with a kind chip, a meta line and actions", () => {
    const { container } = render(
      <ItemHeader
        id="clip-name"
        color="var(--clip-generated)"
        icon={<svg data-testid="glyph" />}
        name="Lanterns drift upward"
        meta="Generated video · V1 · 6.2 s"
        actions={<button type="button">More</button>}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Lanterns drift upward" })).toHaveAttribute("id", "clip-name");
    expect(screen.getByText("Generated video · V1 · 6.2 s")).toHaveClass("ui-item-header__meta");
    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
    const chip = container.querySelector(".ui-item-header__chip") as HTMLElement;
    expect(chip).toHaveAttribute("aria-hidden", "true");
    expect(chip).toContainElement(screen.getByTestId("glyph"));
    expect(chip.style.getPropertyValue("--item-kind")).toBe("var(--clip-generated)");
  });

  it("takes an editable name and a custom chip, and drops the chip when given none", () => {
    function Rename() {
      const [name, setName] = useState("Shot 1");
      return <ItemHeader name={<input className="ui-item-header__input" aria-label="Shot name" value={name} onChange={(event) => setName(event.target.value)} />} />;
    }
    const view = render(<Rename />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(view.container.querySelector(".ui-item-header__chip")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Shot name" }), { target: { value: "Shot 2" } });
    expect(screen.getByRole("textbox", { name: "Shot name" })).toHaveValue("Shot 2");
    view.unmount();

    const { container } = render(<ItemHeader name="Hero" chip={<img alt="" src="data:," />} level={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Hero" })).toBeInTheDocument();
    expect(container.querySelector(".ui-item-header__chip--custom img")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("shows a glyph, a title, one sentence and an action", () => {
    const onImport = vi.fn();
    const { container } = render(
      <EmptyState
        icon={<svg data-testid="glyph" />}
        title="No media yet"
        description="Import video, images or audio."
        action={<button type="button" onClick={onImport}>Import</button>}
      />,
    );
    expect(screen.getByText("No media yet")).toHaveClass("ui-empty-state__title");
    expect(screen.getByText("Import video, images or audio.")).toHaveClass("ui-empty-state__description");
    expect(container.querySelector(".ui-empty-state__icon")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(onImport).toHaveBeenCalled();
  });

  it("needs only a title", () => {
    const { container } = render(<EmptyState title="Nothing selected" />);
    expect(container.querySelector(".ui-empty-state__icon, .ui-empty-state__description, .ui-empty-state__action")).toBeNull();
  });
});

describe("PaneHeader as a toolbar", () => {
  it("works with no title: compact views lead, actions trail", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PaneHeader
        views={<SelectorBar compact aria-label="Sources" value="scenes" onChange={onChange} items={[{ value: "scenes", label: "Scenes" }, { value: "media", label: "Media" }]} />}
        actions={<button type="button">Import</button>}
      />,
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Sources" })).toHaveClass("ui-selector-bar--compact");
    expect(container.querySelector(".ui-pane-header__views")).toContainElement(screen.getByRole("tablist"));
    expect(container.querySelector(".ui-pane-header__actions")).toContainElement(screen.getByRole("button", { name: "Import" }));
    fireEvent.click(screen.getByRole("tab", { name: "Media" }));
    expect(onChange).toHaveBeenCalledWith("media");
  });
});

describe("PropSection summary", () => {
  it("shows the summary in the header whether open or collapsed", () => {
    render(<PropSection title="Transform" summary="1 changed"><span>rows</span></PropSection>);
    const toggle = screen.getByRole("button", { name: /Transform/ });
    expect(screen.getByText("1 changed")).toHaveClass("ui-prop-section__summary");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("1 changed")).toBeVisible();
    expect(screen.getByText("rows")).not.toBeVisible();
  });

  it("renders no summary element without one", () => {
    const { container } = render(<PropSection title="Timing" summary={null} />);
    expect(container.querySelector(".ui-prop-section__summary")).toBeNull();
  });
});
