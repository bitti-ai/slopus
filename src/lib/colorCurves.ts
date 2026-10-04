import { CURVE_CHANNELS, defaultCurve, type CurvePoint, type VideoEffects } from "./effectSettings";

export const CURVE_SAMPLES = 1024;

/** Shape-preserving cubic Hermite interpolation. Flat spans and local extrema
 * have zero tangents; the Fritsch–Carlson limiter prevents segment overshoot. */
export function curveEvaluator(points: readonly CurvePoint[], periodic = false): (x: number) => number {
  const slopes = points.slice(1).map((p, i) => (p[1] - points[i][1]) / (p[0] - points[i][0]));
  const tangents = points.map((_, i) => i === 0 ? slopes[0] : i === points.length - 1 ? slopes[i - 1]
    : slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  // Equal endpoint values and tangents make the red hue seam continuous.
  if (periodic) tangents[0] = tangents[tangents.length - 1] = 0;
  slopes.forEach((slope, i) => {
    if (slope === 0) { tangents[i] = tangents[i + 1] = 0; return; }
    const length = Math.hypot(tangents[i] / slope, tangents[i + 1] / slope);
    if (length > 3) { tangents[i] *= 3 / length; tangents[i + 1] *= 3 / length; }
  });
  return (x) => {
    if (x <= points[0][0]) return points[0][1];
    if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
    let i = 0;
    while (points[i + 1][0] < x) i++;
    const [x0, y0] = points[i], [x1, y1] = points[i + 1];
    const width = x1 - x0, t = (x - x0) / width, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * width * tangents[i]
      + (3 * t2 - 2 * t3) * y1 + (t3 - t2) * width * tangents[i + 1];
  };
}

/** Only control data crosses to the GPU, never picture pixels. */
export function compileCurves(curves: VideoEffects["curves"]): { values: Float32Array; mask: number } {
  const values = new Float32Array(CURVE_CHANNELS.length * CURVE_SAMPLES);
  let mask = 0;
  CURVE_CHANNELS.forEach((channel, index) => {
    const points = curves?.[channel] ?? defaultCurve(channel);
    if (points.some(([x, y]) => Math.abs(y - (index < 4 ? x : 0.5)) > 1e-7)) mask |= 1 << index;
    const evaluate = curveEvaluator(points, channel.startsWith("hue"));
    for (let i = 0; i < CURVE_SAMPLES; i++) values[index * CURVE_SAMPLES + i] = evaluate(i / (CURVE_SAMPLES - 1));
  });
  return { values, mask };
}
