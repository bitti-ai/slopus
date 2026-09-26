import { useSyncExternalStore } from "react";
import { previewEngine } from "../../lib/previewEngine";
import { tooltipProps } from "../ui";

/** The program monitor's engine, in the status bar: the GPU it composites on
 *  and, while playing, the rate pictures reach the screen. Only what the
 *  preview has actually measured is shown; a fact it does not have is left
 *  out rather than guessed. Re-renders at most once a second. */
export function PreviewEngineStatus() {
  const { gpu, playback } = useSyncExternalStore(previewEngine.subscribe, previewEngine.getSnapshot);
  return <>
    {gpu?.kind === "webgpu" && <span className="project-status__fact" {...tooltipProps("The GPU the program monitor composites on (WebGPU)")}>
      GPU <b>{gpu.name || "WebGPU"}</b>
    </span>}
    {gpu?.kind === "none" && <span className="project-status__fact" {...tooltipProps(gpu.reason)}>
      GPU <b>unavailable</b>
    </span>}
    {playback && <span className="project-status__fact" {...tooltipProps("Pictures the monitor showed in the last second, and redraws since Play that kept the previous picture because a decoder was still loading or seeking")}>
      Playback <b>{playback.fps.toFixed(1)}</b> fps · <b>{playback.dropped}</b> dropped
    </span>}
  </>;
}
