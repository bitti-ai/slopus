/* ============================================================================
   Range fill — the Fluent slider's filled track, for every slider at once.

   controls.css paints input[type="range"] with the accent up to `--p`, a
   percentage, because CSS cannot read an input's value. Rather than have each
   screen compute and set it, `installRangeFill()` (called once at startup)
   keeps `--p` current on every range under `root`:

   - an initial pass over the ranges already in the document,
   - `input` / `change` listeners (captured at the root) for user drags,
   - a MutationObserver for ranges added later and for value/min/max
     attribute changes (React mirrors a controlled input's value into the
     attribute, so programmatic changes are seen too).

   A range can opt out with `data-range-fill="off"` (a scrubber with its own
   look). `<Slider>` in src/components/ui sets `--p` itself as well; the two
   agree, so either can run first.
   ========================================================================== */

/** The value's position in [min, max] as a CSS percentage string. */
export function rangePercent(input: HTMLInputElement): string {
  const min = input.min === "" ? 0 : Number(input.min);
  const max = input.max === "" ? 100 : Number(input.max);
  const value = Number(input.value);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(value) || max <= min) return "0%";
  const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
  return `${Math.round(ratio * 10000) / 100}%`;
}

const isRange = (node: unknown): node is HTMLInputElement =>
  typeof HTMLInputElement !== "undefined" && node instanceof HTMLInputElement && node.type === "range";

/** Set `--p` on one range input (no-op for anything else or an opted-out range). */
export function updateRangeFill(input: Element): void {
  if (!isRange(input) || input.dataset.rangeFill === "off") return;
  const next = rangePercent(input);
  if (input.style.getPropertyValue("--p") !== next) input.style.setProperty("--p", next);
}

function sweep(node: ParentNode | Node) {
  if (isRange(node)) updateRangeFill(node);
  if ("querySelectorAll" in node) {
    for (const range of (node as ParentNode).querySelectorAll('input[type="range"]')) updateRangeFill(range);
  }
}

const installed = new WeakMap<Node, () => void>();

/**
 * Keep `--p` updated on every range under `root`. Idempotent per root.
 * Returns the uninstall function (also reachable via `uninstallRangeFill(root)`).
 */
export function installRangeFill(root: Document | Element = document): () => void {
  const existing = installed.get(root);
  if (existing) return existing;

  const onInput = (event: Event) => updateRangeFill(event.target as Element);
  root.addEventListener("input", onInput, true);
  root.addEventListener("change", onInput, true);

  let observer: MutationObserver | undefined;
  if (typeof MutationObserver !== "undefined") {
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") updateRangeFill(record.target as Element);
        else for (const added of record.addedNodes) sweep(added);
      }
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["value", "min", "max", "type"] });
  }
  sweep(root);

  const uninstall = () => {
    root.removeEventListener("input", onInput, true);
    root.removeEventListener("change", onInput, true);
    observer?.disconnect();
    installed.delete(root);
  };
  installed.set(root, uninstall);
  return uninstall;
}

/** Undo `installRangeFill(root)`. */
export function uninstallRangeFill(root: Document | Element = document): void {
  installed.get(root)?.();
}
