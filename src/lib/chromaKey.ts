import type { ClipChromaKey } from "./project";

export const BACKDROP_KEY_DEFAULTS = { screenGain: 100, screenBalance: 0, clipBlack: 3, clipWhite: 95,
  despill: 100, unmix: 100, softness: 0, choke: 0, removeShadows: false, despeckle: false, fillHoles: false } as const;
export const usesBackdropKey = (key?: ClipChromaKey | null): boolean => !!key && key.enabled !== false && !!key.backdrop && key.backdrop !== "color";
export function backdropKeyUniforms(key?: ClipChromaKey | null): number[] {
  const defaults = BACKDROP_KEY_DEFAULTS;
  return [
    usesBackdropKey(key) ? ["color", "green", "blue", "black", "white", "auto"].indexOf(key!.backdrop!) : 0,
    (key?.screenGain ?? defaults.screenGain) / 100, (key?.screenBalance ?? defaults.screenBalance) / 100, (key?.despill ?? defaults.despill) / 100,
    (key?.clipBlack ?? defaults.clipBlack) / 100, (key?.clipWhite ?? defaults.clipWhite) / 100, (key?.unmix ?? defaults.unmix) / 100, key?.removeShadows ? 1 : 0,
    key?.softness ?? 0, key?.choke ?? 0, key?.despeckle ? 1 : 0, key?.fillHoles ? 1 : 0,
  ];
}

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
