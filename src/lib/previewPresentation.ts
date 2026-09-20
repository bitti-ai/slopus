import { clipFrameStyle, clipVisualSettings } from "./export";
import type { Compositor } from "./exportPipeline";
import type { TimelineClip } from "./project";

type PreviewMediaElement = HTMLVideoElement | HTMLImageElement;

/** Prepared decoders belong to clips; the displayed canvas belongs to the
 * monitor. Media arriving asynchronously requests a redraw of the current cut. */
export class PreviewMedia {
  private elements = new Map<string, PreviewMediaElement>();
  private listeners = new Set<() => void>();
  private events = ["loadeddata", "seeked", "load"];
  private changed = () => { this.listeners.forEach((listener) => listener()); };

  set(id: string, element: PreviewMediaElement | null) {
    const previous = this.elements.get(id);
    if (previous === element) return;
    if (previous) this.events.forEach((event) => previous.removeEventListener(event, this.changed));
    if (element) {
      this.elements.set(id, element);
      this.events.forEach((event) => element.addEventListener(event, this.changed));
    } else this.elements.delete(id);
  }

  get(id: string) { return this.elements.get(id); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** Capture every layer BEFORE clearing the display. If any decoder is still
 * loading/seeking, keep the complete previous picture. A real timeline gap
 * deliberately clears the canvas. No pixel readback or CPU frame copies. */
export function presentPreviewFrame(compositor: Compositor, media: PreviewMedia, layers: TimelineClip[], playheadMs: number): boolean {
  const pictures: { frame: VideoFrame; clip: TimelineClip }[] = [];
  try {
    for (const clip of layers) {
      const element = media.get(clip.id);
      if (!element) return false;
      const video = element instanceof HTMLVideoElement;
      if (video ? element.readyState < 2 || element.seeking || !element.videoWidth || !element.videoHeight
        : !element.complete || !element.naturalWidth || !element.naturalHeight) return false;
      pictures.push({ frame: new VideoFrame(element, { timestamp: Math.round(playheadMs * 1000) }), clip });
    }
    compositor.clear();
    for (const { frame, clip } of pictures.reverse()) {
      compositor.draw(frame, clipFrameStyle(clipVisualSettings(clip), playheadMs - clip.startMs));
    }
    return true;
  } finally {
    pictures.forEach(({ frame }) => frame.close());
  }
}
