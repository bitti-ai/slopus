/// <reference types="@webgpu/types" />
import { keyColor, KEY_FEATHER, RGB_DISTANCE_SCALE } from "./chromaKey";
import type { VideoEffects, LutTable } from "./effectSettings";
import type { ClipChromaKey } from "./project";

export type GpuEffects = VideoEffects & { chromaKey?: ClipChromaKey | null; look?: { temperature: number } | null };

const VERTEX = /* wgsl */ `
struct VertexOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  let corners = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  let p = corners[index];
  return VertexOut(vec4f(p, 0., 1.), vec2f(p.x * .5 + .5, .5 - p.y * .5));
}
`;
const PARAMS = /* wgsl */ `
struct Params {
  key: vec4f,
  grade: vec4f,
  detail: vec4f,
  domainMin: vec4f,
  domainMax: vec4f,
  blur: vec4f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(2) var linearSampler: sampler;
`;
const IMPORT = VERTEX + PARAMS + /* wgsl */ `
@group(0) @binding(1) var picture: texture_external;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleBaseClampToEdge(picture, linearSampler, uv);
  var alpha = color.a;
  if (params.detail.w > 0.) {
    let difference = distance(color.rgb, params.key.rgb) / ${RGB_DISTANCE_SCALE};
    alpha *= smoothstep(params.key.a, params.key.a + ${KEY_FEATHER}, difference);
  }
  // Premultiply before filtering so removed key colors cannot bleed into edges.
  return vec4f(color.rgb * alpha, alpha);
}
`;
const TEXTURE = "@group(0) @binding(1) var picture: texture_2d<f32>;";
const BLUR = VERTEX + PARAMS + TEXTURE + /* wgsl */ `
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let radius = params.blur.x;
  let sigma = max(radius / 3., .333333);
  let step = params.blur.yz / vec2f(textureDimensions(picture));
  var total = vec4f(0.);
  var weights = 0.;
  for (var i = -24; i <= 24; i++) {
    if (abs(f32(i)) > ceil(radius)) { continue; }
    let weight = exp(-f32(i * i) / (2. * sigma * sigma));
    total += textureSampleLevel(picture, linearSampler, uv + f32(i) * step, 0.) * weight;
    weights += weight;
  }
  return total / weights;
}
`;
const FINISH = VERTEX + PARAMS + TEXTURE + /* wgsl */ `
@group(0) @binding(3) var<storage, read> lut: array<f32>;
fn lookup(p: vec3u) -> vec3f {
  let size = u32(params.detail.y);
  let offset = (p.x + size * (p.y + size * p.z)) * 3u;
  return vec3f(lut[offset], lut[offset + 1u], lut[offset + 2u]);
}
fn applyLut(color: vec3f) -> vec3f {
  let size = params.detail.y;
  let position = clamp((color - params.domainMin.xyz) / (params.domainMax.xyz - params.domainMin.xyz), vec3f(0.), vec3f(1.)) * (size - 1.);
  let lo = vec3u(floor(position));
  let hi = min(lo + vec3u(1u), vec3u(u32(size) - 1u));
  let f = fract(position);
  return mix(
    mix(mix(lookup(lo), lookup(vec3u(hi.x, lo.y, lo.z)), f.x),
        mix(lookup(vec3u(lo.x, hi.y, lo.z)), lookup(vec3u(hi.xy, lo.z)), f.x), f.y),
    mix(mix(lookup(vec3u(lo.xy, hi.z)), lookup(vec3u(hi.x, lo.y, hi.z)), f.x),
        mix(lookup(vec3u(lo.x, hi.yz)), lookup(hi), f.x), f.y), f.z);
}
fn straight(color: vec4f) -> vec3f { return color.rgb / max(color.a, .00001); }
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let sampled = textureSampleLevel(picture, linearSampler, uv, 0.);
  var rgb = straight(sampled);
  if (params.detail.x > 0.) {
    let pixel = 1. / vec2f(textureDimensions(picture));
    let neighbors = (
      textureSampleLevel(picture, linearSampler, uv + vec2f(pixel.x, 0.), 0.) +
      textureSampleLevel(picture, linearSampler, uv - vec2f(pixel.x, 0.), 0.) +
      textureSampleLevel(picture, linearSampler, uv + vec2f(0., pixel.y), 0.) +
      textureSampleLevel(picture, linearSampler, uv - vec2f(0., pixel.y), 0.)) * .25;
    rgb += (rgb - straight(neighbors)) * params.detail.x;
  }
  rgb *= exp2(params.grade.x);
  rgb = (rgb - vec3f(.5)) * params.grade.y + vec3f(.5);
  let luma = dot(rgb, vec3f(.2126, .7152, .0722));
  rgb = mix(vec3f(luma), rgb, params.grade.z);
  if (params.detail.y >= 2. && params.detail.z > 0.) { rgb = mix(rgb, applyLut(rgb), params.detail.z); }
  let distanceFromCenter = length((uv - vec2f(.5)) * 1.41421356);
  rgb *= 1. - params.grade.w * smoothstep(.3, 1., distanceFromCenter);
  rgb += vec3f(params.domainMin.w * .1, 0., -params.domainMin.w * .1);
  return vec4f(clamp(rgb, vec3f(0.), vec3f(1.)) * sampled.a, sampled.a);
}
`;
const BLIT = VERTEX + /* wgsl */ `
@group(0) @binding(0) var picture: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(picture, linearSampler, uv, 0.);
}
`;

function pipeline(device: GPUDevice, code: string, format: GPUTextureFormat): GPURenderPipeline {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: "auto", vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

/** Shared by monitor and export. All pictures stay in GPU textures; output is premultiplied. */
export function createVideoEffectsProcessor(device: GPUDevice) {
  const importPipeline = pipeline(device, IMPORT, "rgba16float");
  const blurPipeline = pipeline(device, BLUR, "rgba16float");
  const finishPipeline = pipeline(device, FINISH, "rgba16float");
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  const uniforms = Array.from({ length: 3 }, () => device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const emptyLut = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE });
  const luts: { table: LutTable; buffer: GPUBuffer }[] = [];
  let textures: GPUTexture[] = [];
  let dimensions = "";
  return {
    render(frame: VideoFrame, effects: GpuEffects): GPUTexture {
      const width = frame.displayWidth, height = frame.displayHeight;
      if (dimensions !== `${width}x${height}`) {
        textures.forEach((texture) => texture.destroy());
        textures = Array.from({ length: 3 }, () => device.createTexture({
          size: [width, height], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        }));
        dimensions = `${width}x${height}`;
      }
      const table = effects.lut?.table;
      let lutBuffer = emptyLut;
      if (table) {
        const cached = luts.find((entry) => entry.table === table);
        if (cached) lutBuffer = cached.buffer;
        else {
          lutBuffer = device.createBuffer({ size: table.values.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
          device.queue.writeBuffer(lutBuffer, 0, new Float32Array(table.values));
          luts.push({ table, buffer: lutBuffer });
          if (luts.length > 8) luts.shift()!.buffer.destroy();
        }
      }
      const grade = effects.colorCorrection;
      const data = new Float32Array([
        ...(effects.chromaKey ? keyColor(effects.chromaKey.color) : [0, 0, 0]), (effects.chromaKey?.tolerance ?? 0) / 100,
        grade?.exposure ?? 0, 1 + (grade?.contrast ?? 0) / 100, (grade?.saturation ?? 100) / 100, (effects.vignette?.amount ?? 0) / 100,
        (effects.sharpen?.amount ?? 0) / 100, table?.size ?? 0, (effects.lut?.intensity ?? 0) / 100, effects.chromaKey ? 1 : 0,
        ...(table?.domainMin ?? [0, 0, 0]), (effects.look?.temperature ?? 0) / 100, ...(table?.domainMax ?? [1, 1, 1]), 0,
        effects.blur?.radius ?? 0, 0, 0, 0,
      ]);
      device.queue.writeBuffer(uniforms[0], 0, data);
      const encoder = device.createCommandEncoder();
      const pass = (renderPipeline: GPURenderPipeline, source: GPUExternalTexture | GPUTextureView, target: GPUTexture, uniform: GPUBuffer, lut?: GPUBuffer) => {
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: source }, { binding: 2, resource: sampler },
        ];
        if (lut) entries.push({ binding: 3, resource: { buffer: lut } });
        const group = device.createBindGroup({ layout: renderPipeline.getBindGroupLayout(0), entries });
        const render = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
        render.setPipeline(renderPipeline); render.setBindGroup(0, group); render.draw(3); render.end();
      };
      pass(importPipeline, device.importExternalTexture({ source: frame }), textures[0], uniforms[0]);
      if ((effects.blur?.radius ?? 0) > 0) {
        data[21] = 1;
        device.queue.writeBuffer(uniforms[1], 0, data);
        pass(blurPipeline, textures[0].createView(), textures[1], uniforms[1]);
        data[21] = 0; data[22] = 1;
        device.queue.writeBuffer(uniforms[2], 0, data);
        pass(blurPipeline, textures[1].createView(), textures[0], uniforms[2]);
      }
      pass(finishPipeline, textures[0].createView(), textures[2], uniforms[0], lutBuffer);
      device.queue.submit([encoder.finish()]);
      return textures[2];
    },
    dispose() {
      textures.forEach((texture) => texture.destroy());
      uniforms.forEach((buffer) => buffer.destroy());
      luts.forEach(({ buffer }) => buffer.destroy());
      emptyLut.destroy();
    },
  };
}

// Share a device across monitor layers; each renderer owns its textures.
let previewDevice: Promise<GPUDevice> | undefined;
async function getPreviewDevice(): Promise<GPUDevice> {
  previewDevice ??= (async () => {
    if (!navigator.gpu) throw new Error("Video effects require WebGPU on this computer.");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("No GPU is available for video effects.");
    const device = await adapter.requestDevice();
    void device.lost.then(() => { previewDevice = undefined; });
    return device;
  })().catch((reason) => { previewDevice = undefined; throw reason; });
  return previewDevice;
}

export async function createVideoEffectsPreview(canvas: HTMLCanvasElement) {
  const device = await getPreviewDevice();
  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Could not create the video effects preview.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });
  const processor = createVideoEffectsProcessor(device);
  const blit = pipeline(device, BLIT, format);
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  let failure: string | null = null;
  const onError = (event: Event) => { failure = (event as GPUUncapturedErrorEvent).error.message; };
  device.addEventListener("uncapturederror", onError);
  void device.lost.then((info) => { failure = info.message || "The GPU stopped responding."; });
  return {
    draw(source: HTMLVideoElement | HTMLImageElement, effects: GpuEffects) {
      if (failure) throw new Error(failure);
      const video = source instanceof HTMLVideoElement;
      const width = video ? source.videoWidth : source.naturalWidth;
      const height = video ? source.videoHeight : source.naturalHeight;
      if (!width || !height || (video ? source.readyState < 2 : !source.complete)) return;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const frame = new VideoFrame(source, { timestamp: 0 });
      try {
        const result = processor.render(frame, effects);
        const group = device.createBindGroup({ layout: blit.getBindGroupLayout(0), entries: [
          { binding: 0, resource: result.createView() }, { binding: 1, resource: sampler },
        ] });
        const encoder = device.createCommandEncoder();
        const render = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }] });
        render.setPipeline(blit); render.setBindGroup(0, group); render.draw(3); render.end();
        device.queue.submit([encoder.finish()]);
      } finally { frame.close(); }
    },
    dispose() { device.removeEventListener("uncapturederror", onError); processor.dispose(); context.unconfigure(); },
  };
}
