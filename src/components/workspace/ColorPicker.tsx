import { Pipette } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { Flyout, tooltipProps } from "../ui";

/* A colour swatch that opens the WinUI ColorPicker shape in a Flyout: a
   saturation/value square, a hue slider, a hex field, and an eyedropper.

   The eyedropper is the browser's own EyeDropper API (Chromium / WebView2),
   which samples any pixel on the screen — so the program monitor, which is
   where the colour to key out actually is. Where the API is missing the button
   is simply not offered.

   The gradients are painted from inline styles rather than from timeline.css:
   they ARE colours (a hue wheel unrolled), not palette choices, and the
   stylesheet guard keeps literal colours out of the sheets. */

interface Hsv { h: number; s: number; v: number }

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function hexToHsv(hex: string): Hsv | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: ((h * 60) + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const channel = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, "0");
  return `#${channel(f(5))}${channel(f(3))}${channel(f(1))}`;
}

interface EyeDropperResult { sRGBHex: string }
type EyeDropperConstructor = new () => { open: () => Promise<EyeDropperResult> };
const eyeDropper = (): EyeDropperConstructor | undefined =>
  (typeof window !== "undefined" ? (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper : undefined);

export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  /* Hue is kept locally: a grey has no hue of its own, and dragging the square
     down to black must not throw away the hue the user chose. */
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { h: 120, s: 1, v: 1 });
  const [draft, setDraft] = useState(value.toUpperCase());
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    setDraft(value.toUpperCase());
    const next = hexToHsv(value);
    if (next && hsvToHex(hsv).toLowerCase() !== value.toLowerCase()) setHsv(next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };
  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    commit({ ...hsv, s: clamp01((event.clientX - rect.left) / rect.width), v: clamp01(1 - (event.clientY - rect.top) / rect.height) });
  };
  const nudge = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, Partial<Hsv>> = {
      ArrowLeft: { s: clamp01(hsv.s - step) }, ArrowRight: { s: clamp01(hsv.s + step) },
      ArrowUp: { v: clamp01(hsv.v + step) }, ArrowDown: { v: clamp01(hsv.v - step) },
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    commit({ ...hsv, ...move });
  };
  const typed = (text: string) => {
    setDraft(text);
    const normalised = text.trim().startsWith("#") ? text.trim() : `#${text.trim()}`;
    const next = hexToHsv(normalised);
    if (next) { setHsv(next); onChange(normalised.toLowerCase()); }
  };
  const Dropper = eyeDropper();
  const sample = async () => {
    if (!Dropper) return;
    try {
      const { sRGBHex } = await new Dropper().open();
      const next = hexToHsv(sRGBHex);
      if (next) commit(next);
    } catch {
      /* Esc while sampling cancels; nothing changes. */
    }
  };
  const hueColour = hsvToHex({ h: hsv.h, s: 1, v: 1 });

  return <div className="color-picker">
    <div
      ref={area}
      className="color-picker__area"
      role="slider"
      tabIndex={0}
      aria-label="Saturation and brightness"
      aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
      style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColour})` }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); dragging.current = true; pick(event); }}
      onPointerMove={(event) => { if (dragging.current) pick(event); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
      onKeyDown={nudge}
    >
      <span className="color-picker__thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) } as CSSProperties} />
    </div>
    <input
      type="range"
      className="color-picker__hue"
      aria-label="Hue"
      min={0}
      max={359}
      step={1}
      value={Math.round(hsv.h)}
      style={{ "--hue-gradient": "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" } as CSSProperties}
      onChange={(event) => commit({ ...hsv, h: Number(event.target.value) })}
    />
    <div className="color-picker__row">
      <span className="color-picker__preview" style={{ background: value }} aria-hidden="true" />
      <input
        className="text-field color-picker__hex"
        aria-label="Hex"
        value={draft}
        spellCheck={false}
        maxLength={7}
        onChange={(event) => typed(event.target.value)}
        onBlur={() => setDraft(value.toUpperCase())}
      />
      {Dropper && <button type="button" className="icon-button" aria-label="Pick a colour from the screen" {...tooltipProps("Pick a colour from the screen")} onClick={() => void sample()}>
        <Pipette size={16} aria-hidden="true" />
      </button>}
    </div>
  </div>;
}

/** A 24px swatch that opens the picker in a Flyout. */
export function ColorSwatch({ value, onChange, label, disabled }: { value: string; onChange: (hex: string) => void; label: string; disabled?: boolean }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <button
      ref={button}
      type="button"
      className="color-swatch"
      style={{ background: value }}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={disabled}
      {...tooltipProps(value.toUpperCase())}
      onClick={() => setOpen((current) => !current)}
    />
    <Flyout open={open} anchor={button} onClose={() => setOpen(false)} aria-label={label} placement="bottom">
      <ColorPicker value={value} onChange={onChange} />
    </Flyout>
  </>;
}
