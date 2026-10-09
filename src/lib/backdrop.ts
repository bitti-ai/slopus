export const BACKDROP_COLORS = { green: "#00ff00", blue: "#0000ff", black: "#000000", white: "#ffffff" } as const;
export type BackdropColor = keyof typeof BACKDROP_COLORS;
export const BACKDROP_OPTIONS = Object.keys(BACKDROP_COLORS).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

export function backdropDirection(color: BackdropColor): string {
  return `Generate the described subject and action against a uniform, solid ${color} (${BACKDROP_COLORS[color]}) backdrop for background keying. Keep this exact backdrop color consistent across every frame and every shot, filling all space behind the subject. No scenery, floor, horizon, gradients, texture, backdrop shadows or reflections. Light the subject independently, with clear edges and no ${color} color spill. Keep the subject fully inside the frame. Reference images guide the subject's appearance only; replace their backgrounds with this solid backdrop.`;
}
