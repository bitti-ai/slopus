import type { ClipChromaKey } from "./project";

export function keyColor(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

// RGB distance normalized to 0–1. A narrow feather avoids jagged compressed
// edges. These constants/formula are shared by the preview and export shaders.
export const KEY_FEATHER = 0.02;
export const RGB_DISTANCE_SCALE = Math.sqrt(3);
export function keyAlpha(distance: number, tolerance: number): number {
  const edge = Math.max(0, Math.min(1, (distance - tolerance / 100) / KEY_FEATHER));
  return edge * edge * (3 - 2 * edge);
}

/** CPU fallback only; the normal video path performs this on the GPU. */
export function applyChromaKey(pixels: Uint8ClampedArray, key: ClipChromaKey): void {
  const [r, g, b] = keyColor(key.color);
  for (let index = 0; index < pixels.length; index += 4) {
    const distance = Math.hypot(pixels[index] / 255 - r, pixels[index + 1] / 255 - g, pixels[index + 2] / 255 - b) / RGB_DISTANCE_SCALE;
    pixels[index + 3] *= keyAlpha(distance, key.tolerance);
  }
}
