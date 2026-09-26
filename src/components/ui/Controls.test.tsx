// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Checkbox, Expander, InfoBadge, ProgressBar, ProgressRing, Radio, RadioGroup, SelectorBar, Slider, ToggleSwitch,
} from "./Controls";
import { CommandBar, CommandBarButton, CommandBarSeparator, NavItem, NavPane, PaneHeader, StatusBar, TextField } from "./Chrome";
import { Flyout } from "./Flyout";
import { InfoBar } from "./InfoBar";

afterEach(cleanup);

describe("ToggleSwitch", () => {
  it("is a switch with On/Off text beside it and a visible label as its name", () => {
    const onChange = vi.fn();
    const view = render(<ToggleSwitch label="Autosave" checked={false} onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "Autosave" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Off")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    view.rerender(<ToggleSwitch aria-label="Loop" checked onChange={onChange} stateText={false} />);
    expect(screen.getByRole("switch", { name: "Loop" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("On")).not.toBeInTheDocument();
  });

  it("does nothing when disabled", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch aria-label="x" checked={false} disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("Checkbox", () => {
  it("wraps a native checkbox with a label and supports indeterminate", () => {
    const onChange = vi.fn();
    const view = render(<Checkbox label="Mute" description="Silence this track" checked={false} indeterminate onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: /Mute/ }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box).toHaveAccessibleDescription("Silence this track");
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
    view.rerender(<Checkbox label="Mute" checked onChange={onChange} />);
    expect(box.indeterminate).toBe(false);
    expect(box).toBeChecked();
  });
});

describe("RadioGroup", () => {
  it("is a labelled radiogroup from data or children", () => {
    function Group() {
      const [value, setValue] = useState<"fit" | "fill" | "stretch">("fit");
      return (
        <RadioGroup label="Scaling" value={value} onChange={setValue} options={[{ value: "fit", label: "Fit" }, { value: "fill", label: "Fill" }]}>
          <Radio value="stretch" label="Stretch" disabled />
        </RadioGroup>
      );
    }
    render(<Group />);
    expect(screen.getByRole("radiogroup", { name: "Scaling" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Fit" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Fill" }));
    expect(screen.getByRole("radio", { name: "Fill" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Stretch" })).toBeDisabled();
  });
});

describe("Slider", () => {
  it("sets --p from the value and reports numbers", () => {
    const onChange = vi.fn();
    render(<Slider aria-label="Volume" value={30} min={0} max={60} onChange={onChange} />);
    const slider = screen.getByRole("slider", { name: "Volume" });
    expect(slider.style.getPropertyValue("--p")).toBe("50%");
    fireEvent.change(slider, { target: { value: "45" } });
    expect(onChange).toHaveBeenCalledWith(45, expect.anything());
  });
});

describe("Progress", () => {
  it("reports determinate values and omits them when indeterminate", () => {
    const view = render(<ProgressBar aria-label="Export" value={42.4} />);
    const bar = screen.getByRole("progressbar", { name: "Export" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    view.rerender(<ProgressBar aria-label="Export" state="paused" />);
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(bar).toHaveClass("ui-progress--indeterminate", "ui-progress--paused");
    view.rerender(<ProgressRing aria-label="Loading" size={32} />);
    expect(screen.getByRole("progressbar", { name: "Loading" })).toHaveClass("ui-ring--indeterminate");
    view.rerender(<ProgressRing aria-label="Loading" value={150} />);
    expect(screen.getByRole("progressbar", { name: "Loading" })).toHaveAttribute("aria-valuenow", "100");
  });
});

describe("InfoBadge", () => {
  it("shows a capped number or a dot", () => {
    const view = render(<InfoBadge value={120} aria-label="120 jobs" />);
    expect(screen.getByRole("status", { name: "120 jobs" })).toHaveTextContent("99+");
    view.rerender(<InfoBadge severity="critical" />);
    expect(document.querySelector(".ui-badge--dot.ui-badge--critical")).toBeInTheDocument();
  });
});

describe("Expander", () => {
  it("toggles its content", () => {
    render(<Expander header="Advanced">secret</Expander>);
    const header = screen.getByRole("button", { name: "Advanced" });
    expect(screen.getByText("secret")).not.toBeVisible();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("secret")).toBeVisible();
  });
});

describe("SelectorBar", () => {
  it("is a tablist with one tab stop, arrow keys moving the selection", () => {
    function Bar() {
      const [value, setValue] = useState("all");
      return <SelectorBar aria-label="Filter" value={value} onChange={setValue} items={[{ value: "all", label: "All" }, { value: "video", label: "Video" }, { value: "audio", label: "Audio", disabled: true }, { value: "image", label: "Image" }]} />;
    }
    render(<Bar />);
    const all = screen.getByRole("tab", { name: "All" });
    expect(screen.getByRole("tablist", { name: "Filter" })).toBeInTheDocument();
    expect(all).toHaveAttribute("aria-selected", "true");
    expect(all).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Video" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Video" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Image" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(all).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("tab", { name: "Image" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("CommandBar", () => {
  it("renders subtle buttons with tooltip data and arrow navigation", () => {
    const save = vi.fn();
    render(
      <CommandBar aria-label="Editor" end={<span>end</span>}>
        <CommandBarButton icon={<i />} label="Save" shortcut="Ctrl+S" onClick={save} />
        <CommandBarSeparator />
        <CommandBarButton icon={<i />} label="Snap" pressed />
        <CommandBarButton label="Export" />
      </CommandBar>,
    );
    expect(screen.getByRole("toolbar", { name: "Editor" })).toBeInTheDocument();
    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toHaveAttribute("data-tooltip", "Save");
    expect(saveButton).toHaveAttribute("data-tooltip-shortcut", "Ctrl+S");
    expect(saveButton).toHaveAttribute("aria-keyshortcuts", "Control+S");
    expect(screen.getByRole("button", { name: "Snap" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Export" })).toHaveTextContent("Export");
    // Labelled buttons keep a tooltip too: the label is hidden when the bar is narrow.
    expect(screen.getByRole("button", { name: "Export" })).toHaveAttribute("data-tooltip", "Export");
    fireEvent.click(saveButton);
    expect(save).toHaveBeenCalled();
    saveButton.focus();
    fireEvent.keyDown(saveButton, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Snap" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("button", { name: "Export" })).toHaveFocus();
  });
});

describe("chrome pieces", () => {
  it("renders a pane header, nav items with a badge, a text field and a status bar", () => {
    const onChange = vi.fn();
    render(
      <>
        <PaneHeader title="Inspector" id="inspector-title" actions={<button>More</button>} />
        <NavPane aria-label="Main" footer={<NavItem label="Settings" />}>
          <NavItem label="Library" selected badge={3} badgeLabel="3 running" />
          <NavItem label="Queue" badge />
        </NavPane>
        <TextField aria-label="Search" value="" onChange={onChange} icon={<i />} trailing={<button className="ui-textfield__button">x</button>} />
        <StatusBar aria-label="Status" end={<span>100%</span>}><span>Ready</span></StatusBar>
      </>,
    );
    expect(screen.getByRole("heading", { name: "Inspector" })).toHaveAttribute("id", "inspector-title");
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Library/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("status", { name: "3 running" })).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: "Queue" })).not.toHaveAttribute("aria-current");
    fireEvent.change(screen.getByRole("textbox", { name: "Search" }), { target: { value: "cat" } });
    expect(onChange).toHaveBeenCalledWith("cat", expect.anything());
    expect(screen.getByRole("region", { name: "Status" })).toHaveTextContent("Ready100%");
  });
});

describe("InfoBar", () => {
  it("is a status for information and an alert for errors, with an optional close", () => {
    const onClose = vi.fn();
    const view = render(<InfoBar severity="success" title="Saved" message="out.mp4" action={<button>Open folder</button>} onClose={onClose} />);
    expect(screen.getByRole("status")).toHaveTextContent("Savedout.mp4");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    view.rerender(<InfoBar severity="error" title="Export failed">Disk full</InfoBar>);
    expect(screen.getByRole("alert")).toHaveTextContent("Export failedDisk full");
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });
});

describe("Flyout", () => {
  function Anchored() {
    const button = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button ref={button} aria-expanded={open} onClick={() => setOpen(!open)}>Queue</button>
        <button>Elsewhere</button>
        <Flyout open={open} anchor={button} onClose={() => setOpen(false)} aria-label="Work queue">
          <button>First</button>
        </Flyout>
      </>
    );
  }

  it("places a fixed-width flyout by its real width, so it stays inside the window", () => {
    // jsdom lays nothing out: offsetWidth is 0, like content measured before
    // the width applies. The anchor sits near the right edge.
    const anchor = { left: window.innerWidth - 60, right: window.innerWidth - 28, top: 10, bottom: 42, width: 32, height: 32 };
    render(<Flyout open anchor={anchor} onClose={() => undefined} aria-label="Queue" width={360}><button>Row</button></Flyout>);
    const panel = screen.getByRole("dialog", { name: "Queue" });
    expect(panel.style.width).toBe("360px");
    expect(parseFloat(panel.style.left) + 360).toBeLessThanOrEqual(window.innerWidth - 8);
  });

  it("opens anchored, focuses inside, and light-dismisses", () => {
    render(<Anchored />);
    const anchor = screen.getByRole("button", { name: "Queue" });
    fireEvent.click(anchor);
    const flyout = screen.getByRole("dialog", { name: "Work queue" });
    expect(flyout.parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    // Pressing the anchor itself is not "outside": its own click toggles.
    fireEvent.mouseDown(anchor);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(anchor);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(anchor);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(anchor);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(anchor).toHaveFocus();
  });
});
