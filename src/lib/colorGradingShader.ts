// Procedural looks adapted from FilmCraft, copyright 2026 The FilmCraft
// contributors (MIT). See public/licenses/filmcraft.txt.
export const COLOR_GRADING_WGSL = /* wgsl */ `
@group(0) @binding(4) var<storage, read> curves: array<f32>;
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(.2126, .7152, .0722)); }
fn sCurve(c: vec3f, k: f32) -> vec3f {
  let x = clamp(c, vec3f(0.), vec3f(1.));
  return mix(x, x * x * (3. - 2. * x), k);
}
fn creativeLook(c: vec3f) -> vec3f {
  let l = luma(c);
  switch u32(params.creative.x) {
    case 1u: { return sCurve(c + vec3f(0., .08, .1) * (1. - l) + vec3f(.1, .04, -.06) * l, .35); }
    case 2u: { return mix(c * vec3f(1.06, 1., .9) + vec3f(.02, .01, 0.), vec3f(l), .15) * .94 + .04; }
    case 3u: { return sCurve(c * vec3f(.9, .98, 1.1) + vec3f(0., 0., .02), .2); }
    case 4u: { return sCurve(mix(c, vec3f(l), .55), .6); }
    case 5u: { return mix(c, vec3f(l), .25) * .84 + .08; }
    case 6u: { return sCurve(vec3f(l), .3); }
    case 7u: { return sCurve(c * vec3f(1.1, 1.02, .82) + vec3f(.03, .01, 0.), .15); }
    case 8u: { return c * vec3f(.75, .85, 1.15) * .8; }
    default: { return c; }
  }
}
fn curve(channel: u32, x: f32) -> f32 {
  let p = clamp(x, 0., 1.) * 1023.;
  let i = u32(p);
  return mix(curves[channel * 1024u + i], curves[channel * 1024u + min(i + 1u, 1023u)], fract(p));
}
fn hasCurve(channel: u32) -> bool { return (u32(params.tonal.w) & (1u << channel)) != 0u; }
fn rgbToHsl(c: vec3f) -> vec3f {
  let hi = max(c.r, max(c.g, c.b)); let lo = min(c.r, min(c.g, c.b));
  let d = hi - lo; let l = (hi + lo) * .5;
  if (d < .000001) { return vec3f(0., 0., l); }
  var h = (c.g - c.b) / d;
  if (hi == c.g) { h = (c.b - c.r) / d + 2.; }
  else if (hi == c.b) { h = (c.r - c.g) / d + 4.; }
  return vec3f(fract(h / 6. + 1.), d / max(1. - abs(2. * l - 1.), .000001), l);
}
fn hslToRgb(h: vec3f) -> vec3f {
  let c = (1. - abs(2. * h.z - 1.)) * h.y;
  let rgb = clamp(abs(fract(h.x + vec3f(0., 2./3., 1./3.)) * 6. - 3.) - 1., vec3f(0.), vec3f(1.));
  return (rgb - .5) * c + h.z;
}
fn applyCurves(input: vec3f) -> vec3f {
  var c = input;
  if (hasCurve(0u)) { c = vec3f(curve(0u, c.r), curve(0u, c.g), curve(0u, c.b)); }
  if (hasCurve(1u)) { c.r = curve(1u, c.r); }
  if (hasCurve(2u)) { c.g = curve(2u, c.g); }
  if (hasCurve(3u)) { c.b = curve(3u, c.b); }
  if ((u32(params.tonal.w) & 496u) != 0u) {
    var h = rgbToHsl(clamp(c, vec3f(0.), vec3f(1.)));
    let original = h;
    if (hasCurve(5u)) { h.x = fract(h.x + curve(5u, original.x) - .5 + 1.); }
    if (hasCurve(4u)) { h.y *= curve(4u, original.x) * 2.; }
    if (hasCurve(7u)) { h.y *= curve(7u, original.z) * 2.; }
    if (hasCurve(8u)) { h.y *= curve(8u, original.y) * 2.; }
    if (hasCurve(6u)) { h.z += (curve(6u, original.x) - .5) * .5; }
    c = hslToRgb(vec3f(h.x, clamp(h.yz, vec2f(0.), vec2f(1.))));
  }
  return c;
}
fn wheelOffset(w: vec4f) -> vec3f {
  // Cosine colour directions: red at right, green at upper left, blue below.
  return vec3f(w.x, -.5 * w.x + .8660254 * w.y, -.5 * w.x - .8660254 * w.y);
}
fn applyWheels(c: vec3f) -> vec3f {
  let l = clamp(luma(c), 0., 1.);
  let shadows = (1. - l) * (1. - l); let highlights = l * l;
  let midtones = 1. - shadows - highlights;
  var v = c + (wheelOffset(params.shadows) + params.shadows.z) * .3 * shadows;
  v += (wheelOffset(params.midtones) + params.midtones.z) * .3 * midtones;
  return v * (1. + (wheelOffset(params.highlights) + params.highlights.z) * .5 * highlights);
}
`;
