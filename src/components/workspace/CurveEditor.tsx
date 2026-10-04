import { useId, useRef, useState, type PointerEvent } from "react";
import { ComboBox } from "../ui";
import { curveEvaluator } from "../../lib/colorCurves";
import { CURVE_CHANNELS, defaultCurve, type CurveChannel, type CurvePoint, type VideoEffects } from "../../lib/effectSettings";

const LABELS: Record<CurveChannel, string> = { rgb: "RGB", red: "Red", green: "Green", blue: "Blue", hueVsSat: "Hue vs saturation", hueVsHue: "Hue vs hue", hueVsLuma: "Hue vs luma", lumaVsSat: "Luma vs saturation", satVsSat: "Saturation vs saturation" };
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export function CurveEditor({ value, disabled, onChange }: { value: NonNullable<VideoEffects["curves"]>; disabled: boolean; onChange: (value: NonNullable<VideoEffects["curves"]>) => void }) {
  const [channel, setChannel] = useState<CurveChannel>("rgb");
  const [selected, setSelected] = useState(0);
  const drag = useRef<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const hint = useId();
  const points = value[channel] ?? defaultCurve(channel);
  const latest = useRef(points); latest.current = points;
  const index = Math.min(selected, points.length - 1);
  const periodic = channel.startsWith("hue");
  const evaluate = curveEvaluator(points, periodic);
  const commit = (next: CurvePoint[]) => { if (!disabled) { latest.current = next; onChange({ ...value, [channel]: next }); } };
  const move = (i: number, x: number, y: number) => {
    const next = latest.current.map((p) => [...p] as CurvePoint);
    const last = next.length - 1;
    const lo = i > 0 ? next[i - 1][0] + .001001 : 0;
    const hi = i < last ? next[i + 1][0] - .001001 : 1;
    next[i] = [i === 0 ? 0 : i === last ? 1 : lo > hi ? next[i][0] : clamp(x, lo, hi), clamp(y)];
    if (periodic && (i === 0 || i === last)) next[i === 0 ? last : 0][1] = next[i][1];
    commit(next);
  };
  const position = (event: PointerEvent<SVGSVGElement>): CurvePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [clamp((event.clientX - rect.left) / rect.width), clamp(1 - (event.clientY - rect.top) / rect.height)];
  };
  const addPoint = (x: number, y: number) => {
    if (disabled || points.length >= 32 || points.some((p) => Math.abs(p[0] - x) < .004)) return;
    const next = [...points, [x, y] as CurvePoint].sort((a, b) => a[0] - b[0]);
    setSelected(next.findIndex((p) => p[0] === x)); commit(next);
  };
  const remove = () => { if (index > 0 && index < points.length - 1) { commit(points.filter((_, i) => i !== index)); setSelected(index - 1); } };
  return <div className="grading-curves">
    <ComboBox aria-label="Curve channel" value={channel} disabled={disabled} options={CURVE_CHANNELS.map((c) => ({ value: c, label: LABELS[c] }))}
      onChange={(c) => { setChannel(c); setSelected(0); drag.current = null; }} />
    <svg ref={svg} className={`grading-curves__graph grading-curves__graph--${channel}`} viewBox="0 0 256 256" aria-label={`${LABELS[channel]} curve`} aria-describedby={hint}
      style={{ color: ({ red: "#ed7373", green: "#73c88f", blue: "#81aaff" } as Partial<Record<CurveChannel, string>>)[channel] }}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        const [x, y] = position(e);
        const nearest = points.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < .045);
        if (nearest >= 0) { setSelected(nearest); drag.current = nearest; e.currentTarget.setPointerCapture(e.pointerId); }
        else addPoint(x, y);
      }}
      onPointerMove={(e) => { if (drag.current !== null && !disabled) move(drag.current, ...position(e)); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {[64, 128, 192].map((n) => <path key={n} className="grading-curves__grid" d={`M ${n} 0 V 256 M 0 ${n} H 256`} />)}
      <path className="grading-curves__baseline" d={CURVE_CHANNELS.indexOf(channel) < 4 ? "M 0 256 L 256 0" : "M 0 128 H 256"} />
      <path className="grading-curves__line" d={Array.from({ length: 257 }, (_, i) => `${i ? "L" : "M"} ${i} ${(1 - evaluate(i / 256)) * 256}`).join(" ")} />
      {points.map(([x, y], i) => <circle key={i} cx={x * 256} cy={(1 - y) * 256} r={i === index ? 5 : 4} className={i === index ? "grading-curves__point grading-curves__point--selected" : "grading-curves__point"}
        role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={`${LABELS[channel]} point ${i + 1}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(y * 100)} aria-valuetext={`Input ${Math.round(x * 100)}, output ${Math.round(y * 100)}`}
        onFocus={() => setSelected(i)} onKeyDown={(e) => {
          if (disabled) return;
          const step = e.shiftKey ? .1 : .01;
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
            e.preventDefault(); e.stopPropagation();
            move(i, x + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0), y + (e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0));
          } else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); remove(); }
        }} />)}
    </svg>
    <div className="grading-curves__coordinates">
      <label>Input <input className="text-field" aria-label="Curve point input" type="number" min={0} max={100} step={1} value={+(points[index][0] * 100).toFixed(1)} disabled={disabled || index === 0 || index === points.length - 1}
        onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) move(index, e.target.valueAsNumber / 100, points[index][1]); }} /></label>
      <label>Output <input className="text-field" aria-label="Curve point output" type="number" min={0} max={100} step={1} value={+(points[index][1] * 100).toFixed(1)} disabled={disabled}
        onChange={(e) => { if (Number.isFinite(e.target.valueAsNumber)) move(index, points[index][0], e.target.valueAsNumber / 100); }} /></label>
    </div>
    <div className="grading-curves__actions">
      <button type="button" className="secondary-button" disabled={disabled || points.length >= 32} onClick={() => {
        let gap = 0; for (let i = 1; i < points.length - 1; i++) if (points[i + 1][0] - points[i][0] > points[gap + 1][0] - points[gap][0]) gap = i;
        const x = (points[gap][0] + points[gap + 1][0]) / 2; addPoint(x, evaluate(x));
      }}>Add point</button>
      <button type="button" className="secondary-button" disabled={disabled || index === 0 || index === points.length - 1} onClick={remove}>Remove point</button>
      <button type="button" className="secondary-button" disabled={disabled} onClick={() => { commit(defaultCurve(channel)); setSelected(0); }}>Reset curve</button>
    </div>
    <p id={hint} className="clip-effect__note">Click to add a point; drag to shape the curve. Arrow keys move a focused point. Delete removes it.</p>
  </div>;
}
