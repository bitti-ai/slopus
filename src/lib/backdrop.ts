export const BACKDROP_COLORS = { green: "#00ff00", blue: "#0000ff", black: "#000000", white: "#ffffff" } as const;
export type BackdropColor = keyof typeof BACKDROP_COLORS;
export const BACKDROP_OPTIONS = Object.keys(BACKDROP_COLORS).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

export function backdropDirection(color: BackdropColor): string {
  return `The video is an isolated-subject compositing plate against a uniform, solid ${color} (${BACKDROP_COLORS[color]}) backdrop. The background is a flat digital color field, edge to edge, with constant color and brightness throughout the video. ${backdropShotDirection(color)} Only the subject has shading and detail; lighting and color grading affect the subject alone. Keep the subject fully inside the frame with clean, distinct edges.${color === "green" || color === "blue" ? ` Keep ${color} spill off the subject.` : ""} No visible scenery, floor, horizon, gradients, texture, backdrop shadows or reflections.`;
}

export function backdropShotDirection(color: BackdropColor): string {
  return `Every area outside the subject's silhouette, including gaps between limbs and newly revealed areas during movement, remains the same solid ${color} (${BACKDROP_COLORS[color]}) in every frame.`;
}

export function backdropSummary(color: BackdropColor): string {
  return `An isolated-subject compositing plate on a uniform, solid ${color} (${BACKDROP_COLORS[color]}) background throughout.`;
}
