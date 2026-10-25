import { clipSourceTimeMs } from "./clipTiming";
import { clipFrameStyle, clipVisualSettings } from "./export";
import type { Compositor } from "./exportPipeline";
import type { TimelineClip } from "./project";

type PreviewMediaElement = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

/** Prepared decoders belong to players; the displayed canvas belongs to the
 * monitor. Media arriving asynchronously requests a redraw of the current cut. */
export class PreviewMedia {
  private elements = new Map<string, PreviewMediaElement>();
  private motionTimes = new Map<string, number>();
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
    } else { this.elements.delete(id); this.motionTimes.delete(id); }
  }

  setMotionTime(id: string, time: number) { this.motionTimes.set(id, time); }
  motionTime(id: string) { return this.motionTimes.get(id); }

  invalidate() { this.changed(); }

  get(id: string) { return this.elements.get(id); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** Capture every layer BEFORE clearing the display. If any decoder is still
 * loading/seeking, keep the complete previous picture. A real timeline gap
 * deliberately clears the canvas. No pixel readback or CPU frame copies. */
export function presentPreviewFrame(compositor: Compositor, media: PreviewMedia, layers: TimelineClip[], playheadMs: number, playerKeys?: ReadonlyMap<string, string>): boolean {
  const pictures: { frame: VideoFrame; clip: TimelineClip }[] = [];
  try {
    for (const clip of layers) {
      const key = playerKeys?.get(clip.id) ?? clip.id;
      const element = media.get(key);
      if (!element) return false;
      const canvas = element instanceof HTMLCanvasElement;
      const video = element instanceof HTMLVideoElement;
      if (canvas && media.motionTime(key) !== undefined && Math.abs(media.motionTime(key)! - clipSourceTimeMs(clip, playheadMs) / 1000) > 0.1) return false;
      if (canvas ? !element.width || !element.height : video ? element.readyState < 2 || element.seeking || !element.videoWidth || !element.videoHeight
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
