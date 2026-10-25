/** Timeline/Export transport and native previews yield background Music playback. */
export const PREVIEW_PLAYBACK_STARTED = "slopus:preview-playback-started";

export function notifyPreviewPlayback() {
  window.dispatchEvent(new Event(PREVIEW_PLAYBACK_STARTED));
}
