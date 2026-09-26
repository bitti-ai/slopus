// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { installRangeFill, rangePercent, uninstallRangeFill } from "./rangeFill";

const range = (value: string, min = "", max = "") => {
  const input = document.createElement("input");
  input.type = "range";
  if (min) input.min = min;
  if (max) input.max = max;
  input.value = value;
  return input;
};

/* MutationObserver callbacks are microtasks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  uninstallRangeFill(document);
  document.body.innerHTML = "";
});

describe("rangePercent", () => {
  it("maps the value into [min, max] and clamps", () => {
    expect(rangePercent(range("50"))).toBe("50%");
    expect(rangePercent(range("5", "0", "20"))).toBe("25%");
    expect(rangePercent(range("-1", "-2", "2"))).toBe("25%");
    const degenerate = range("1", "1", "1");
    expect(rangePercent(degenerate)).toBe("0%");
  });
});

describe("installRangeFill", () => {
  it("fills existing ranges, follows input events and new ranges, and uninstalls", async () => {
    const first = range("30");
    document.body.append(first);
    const stop = installRangeFill();
    expect(first.style.getPropertyValue("--p")).toBe("30%");

    first.value = "80";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    expect(first.style.getPropertyValue("--p")).toBe("80%");

    const wrapper = document.createElement("div");
    const added = range("10", "0", "40");
    wrapper.append(added);
    document.body.append(wrapper);
    await flush();
    expect(added.style.getPropertyValue("--p")).toBe("25%");

    // A programmatic change that reaches the attribute, the way React writes a
    // controlled value: property first (no event fires), then the attribute.
    added.value = "20";
    added.setAttribute("value", "20");
    await flush();
    expect(added.style.getPropertyValue("--p")).toBe("50%");
    added.max = "80";
    await flush();
    expect(added.style.getPropertyValue("--p")).toBe("25%");

    // Installing twice is harmless and returns the same uninstall.
    expect(installRangeFill()).toBe(stop);
    stop();
    first.value = "10";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    expect(first.style.getPropertyValue("--p")).toBe("80%");
  });

  it("leaves opted-out ranges and other inputs alone", () => {
    const own = range("50");
    own.dataset.rangeFill = "off";
    const text = document.createElement("input");
    document.body.append(own, text);
    installRangeFill();
    text.dispatchEvent(new Event("input", { bubbles: true }));
    expect(own.style.getPropertyValue("--p")).toBe("");
    expect(text.style.getPropertyValue("--p")).toBe("");
  });

  it("can be scoped to an element", () => {
    const host = document.createElement("section");
    const inside = range("40");
    const outside = range("60");
    host.append(inside);
    document.body.append(host, outside);
    const stop = installRangeFill(host);
    expect(inside.style.getPropertyValue("--p")).toBe("40%");
    expect(outside.style.getPropertyValue("--p")).toBe("");
    stop();
  });
});
