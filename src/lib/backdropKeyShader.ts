/** Flat-backdrop keying. Only the 1x1 plate pass examines the frame border;
 * all subsequent passes sample that GPU texture, without CPU readback.
 * Mode: 0 legacy distance, 1 green, 2 blue, 3 black, 4 white, 5 automatic. */
export const BACKDROP_PLATE_WGSL = /* wgsl */ `
@group(0) @binding(1) var picture: texture_external;
fn classifyBackdrop(rgb: vec3f) -> u32 {
  if (rgb.g - max(rgb.r, rgb.b) > .1) { return 1u; }
  if (rgb.b - max(rgb.r, rgb.g) > .1) { return 2u; }
  if (dot(rgb, vec3f(.333333)) < .5) { return 3u; }
  return 4u;
}
@fragment fn fs() -> @location(0) vec4f {
  if (params.keyControls.x != 5.) { return vec4f(params.key.rgb, params.keyControls.x); }
  var sums: array<vec3f, 4>;
  var counts: array<f32, 4>;
  // Eight samples on each edge, inset to avoid codec padding.
  for (var i = 0u; i < 32u; i++) {
    let along = (f32(i % 8u) + .5) / 8.;
    let side = i / 8u;
    var uv = vec2f(along, .02);
    if (side == 1u) { uv = vec2f(along, .98); }
    if (side == 2u) { uv = vec2f(.02, along); }
    if (side == 3u) { uv = vec2f(.98, along); }
    let rgb = textureSampleBaseClampToEdge(picture, linearSampler, uv).rgb;
    let bucket = classifyBackdrop(rgb) - 1u;
    sums[bucket] += rgb;
    counts[bucket] += 1.;
  }
  var selected = 0u;
  for (var i = 1u; i < 4u; i++) {
    if (counts[i] > counts[selected]) { selected = i; }
  }
  return vec4f(sums[selected] / max(counts[selected], 1.), f32(selected + 1u));
}
`;

export const BACKDROP_KEY_WGSL = /* wgsl */ `
@group(0) @binding(3) var backdropPlate: texture_2d<f32>;
fn screenSignal(rgb: vec3f, mode: f32) -> f32 {
  var other = rgb.rb;
  var key = rgb.g;
  if (mode == 2.) { other = rgb.rg; key = rgb.b; }
  return key - mix(max(other.x, other.y), (other.x + other.y) * .5, params.keyControls.z);
}
fn backdropKey(color: vec4f) -> vec4f {
  let plate = textureLoad(backdropPlate, vec2i(0), 0);
  let rgb = color.rgb;
  let gain = params.keyControls.y;
  var a = 1.;
  if (plate.a <= 2.) {
    a = 1. - gain * screenSignal(rgb, plate.a) / max(screenSignal(plate.rgb, plate.a), .04);
    if (params.keyMatte.w > 0.) {
      let normalized = rgb / max(max(rgb.r, max(rgb.g, rgb.b)), .001);
      let normalizedPlate = plate.rgb / max(max(plate.r, max(plate.g, plate.b)), .001);
      let shadowAlpha = 1. - gain * screenSignal(normalized, plate.a) / max(screenSignal(normalizedPlate, plate.a), .04);
      a = min(a, shadowAlpha);
    }
  } else if (plate.a == 3.) {
    let delta = max(rgb - plate.rgb, vec3f(0.));
    a = gain * max(delta.r, max(delta.g, delta.b)) / max(1. - max(plate.r, max(plate.g, plate.b)), .2);
  } else {
    let delta = max(vec3f(1.) - rgb / max(plate.rgb, vec3f(.2)), vec3f(0.));
    a = gain * max(delta.r, max(delta.g, delta.b));
  }
  a = clamp(a, 0., 1.);
  // Recover straight foreground before clipping the matte; clipping is an
  // artistic adjustment and must not change the color solve underneath it.
  var foreground = mix(rgb, (rgb - (1. - a) * plate.rgb) / max(a, .04), params.keyMatte.z);
  if (plate.a == 1.) {
    let limit = mix(max(foreground.r, foreground.b), (foreground.r + foreground.b) * .5, params.keyControls.z);
    foreground.g -= params.keyControls.w * max(foreground.g - limit, 0.);
  } else if (plate.a == 2.) {
    let limit = mix(max(foreground.r, foreground.g), (foreground.r + foreground.g) * .5, params.keyControls.z);
    foreground.b -= params.keyControls.w * max(foreground.b - limit, 0.);
  }
  let alpha = color.a * clamp((a - params.keyMatte.x) / max(params.keyMatte.y - params.keyMatte.x, .001), 0., 1.);
  return vec4f(clamp(foreground, vec3f(0.), vec3f(1.)) * alpha, alpha);
}
`;

export const BACKDROP_REFINE_WGSL = /* wgsl */ `
@group(0) @binding(1) var picture: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let center = textureSampleLevel(picture, linearSampler, uv, 0.);
  let pixel = 1. / vec2f(textureDimensions(picture));
  var lowest = center.a;
  var highest = center.a;
  var neighborLow = 1.;
  var neighborHigh = 0.;
  var total = center * 4.;
  var weight = 4.;
  var edgeColor = center;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) { continue; }
      let offset = vec2f(f32(x), f32(y)) * pixel;
      let nearby = textureSampleLevel(picture, linearSampler, uv + offset, 0.);
      neighborLow = min(neighborLow, nearby.a);
      neighborHigh = max(neighborHigh, nearby.a);
      edgeColor += nearby;
      if (params.keyEdge.y != 0.) {
        let moved = textureSampleLevel(picture, linearSampler, uv + offset * abs(params.keyEdge.y), 0.);
        lowest = min(lowest, moved.a);
        highest = max(highest, moved.a);
        edgeColor += moved;
      }
      if (params.keyEdge.x > 0.) {
        let softened = textureSampleLevel(picture, linearSampler, uv + offset * params.keyEdge.x, 0.);
        let w = select(1., 2., x == 0 || y == 0);
        total += softened * w;
        weight += w;
      }
    }
  }
  var alpha = center.a;
  if (params.keyEdge.z > 0. && neighborHigh < .05 && alpha < .5) { alpha = 0.; }
  if (params.keyEdge.w > 0. && neighborLow > .95) { alpha = 1.; }
  if (params.keyEdge.y > 0.) { alpha = min(alpha, lowest); }
  if (params.keyEdge.y < 0.) { alpha = max(alpha, highest); }
  if (params.keyEdge.x > 0.) { alpha = mix(alpha, total.a / weight, min(params.keyEdge.x, 1.)); }
  // Extend neighboring foreground colors into newly grown transparent pixels.
  var rgb = edgeColor.rgb / max(edgeColor.a, .00001);
  if (center.a > .04) { rgb = center.rgb / center.a; }
  return vec4f(rgb * alpha, alpha);
}
`;
