import { ChevronFirst, ChevronLast, Maximize, Minimize, Pause, Play, StepBack, StepForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  audioMixBytes,
  bitrateFor,
  buildExportPlan,
  defaultExportSettings,
  estimatedBytes,
  formatBytes,
  formatDuration,
  outputDimensions,
  OUTPUT_CODECS,
  QUALITY_PRESETS,
  suggestedFileName,
  type ExportSettings,
  type FrameRate,
  type OutputCodecId,
  type QualityId,
} from "../../lib/export";
import {
  chooseExportDestination,
  defaultExportDestination,
  detectExportSupport,
  exportDestinationExists,
  openExportFile,
  probeAllCodecs,
  probeCompositor,
  type CodecProbe,
  type CompositorProbe,
} from "../../lib/exportPipeline";
import {
  cancelExportJob,
  dismissExportOutcome,
  exportFraction,
  startExportJob,
  useExportJob,
} from "../../lib/exportJob";
import { askNative, messageNative, revealInExplorer } from "../../lib/nativeShell";
import { formatTimecode, frameAt, frameStartMs } from "../../lib/timeline";
import { ProgramMonitor } from "./ProgramMonitor";
import { ProjectStatus } from "./ProjectStatus";
import { PROJECT_RESOLUTIONS, type ProjectConfig, type Resolution } from "../../lib/project";
import { ComboBox, InfoBar, ProgressBar, PropRow, PropSection, Slider, Splitter, tooltipProps, usePaneSize } from "../ui";

/* The ladder a project can be created at, plus the project's own size when that
   is one of the names from before the ladder was rebuilt. Dropping the legacy
   rung outright would leave a 1080p project looking at a list that does not
   contain what the project IS, and the first touch of any other field would
   have quietly resized the export. */
const resolutionChoices = (current: Resolution): Resolution[] =>
  PROJECT_RESOLUTIONS.includes(current as (typeof PROJECT_RESOLUTIONS)[number])
    ? [...PROJECT_RESOLUTIONS]
    : [...PROJECT_RESOLUTIONS, current];
const FRAME_RATES: FrameRate[] = [24, 25, 30, 60];
const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** In fullscreen a moving pointer reveals the transport; once it rests, the
 *  picture gets the whole screen again. Windowed, the bar is always there. */
const PLAYER_CONTROLS_IDLE_MS = 1_800;

/** "1:12" or "1:02:05" — how long is left, for the progress line. */
const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
};

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const folderOf = (path: string) => path.slice(0, Math.max(0, path.length - fileName(path).length - 1));

interface Destination {
  path: string;
  /** Chosen in the Save dialog, which already asked about replacing a file. */
  fromDialog: boolean;
}

/* A docked form, the way Clipchamp and Premiere's export page are laid out:
   the picture on the stage at the left, a resizable settings pane on the right
   that opens straight on its first section, and the actions at the pane's
   foot. The run itself lives in lib/exportJob.ts, so leaving this screen no
   longer cancels it. */
export function ExportView({ config, folderPath, onClose }: {
  config: ProjectConfig;
  folderPath: string;
  /** Leaves the Export screen (the pane foot's Cancel while nothing is running). */
  onClose?: () => void;
}) {
  const [settings, setSettings] = useState<ExportSettings>(() => defaultExportSettings(config));
  const settingsPane = usePaneSize("export.settings", 340, { min: 280, max: 560 });
  const plan = useMemo(() => buildExportPlan(config, settings), [config, settings]);
  const bitrate = useMemo(
    () => bitrateFor(plan.width, plan.height, plan.frameRate, settings.quality),
    [plan.width, plan.height, plan.frameRate, settings.quality],
  );
  /* What this computer can actually do, asked once. Everything the view offers
     is gated on the answer rather than on what the code hopes is there. */
  const support = useMemo(detectExportSupport, []);
  const [probes, setProbes] = useState<CodecProbe[] | null>(null);
  /* Which compositor will ACTUALLY run, asked by requesting an adapter rather
     than by looking for `navigator.gpu`. Null until the answer comes back — the
     page says it is asking rather than guessing WebGPU and being wrong. */
  const [compositor, setCompositor] = useState<CompositorProbe | null>(null);

  const [previewTimeMs, setPreviewTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<number | null>(null);

  const [destination, setDestination] = useState<Destination | null>(null);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  const job = useExportJob();
  const ours = job.folderPath === folderPath;
  const running = job.progress !== null;
  const runningHere = running && ours;

  /* The playhead is the view's, and the monitor drives it while it plays —
     these are handed down rather than declared inline because the monitor's
     animation loop tears itself down and rebuilds when their identity changes.
     See ProgramMonitor. */
  const seek = useCallback((ms: number) => setPreviewTimeMs(ms), []);
  const changePlaying = useCallback((value: boolean) => setPlaying(value), []);
  const clearControlsTimer = useCallback(() => {
    if (controlsTimerRef.current === null) return;
    window.clearTimeout(controlsTimerRef.current);
    controlsTimerRef.current = null;
  }, []);
  const hideControlsAfterIdle = useCallback(() => {
    clearControlsTimer();
    controlsTimerRef.current = window.setTimeout(() => {
      controlsTimerRef.current = null;
      if (stageRef.current?.contains(document.activeElement)) return;
      setControlsVisible(false);
    }, PLAYER_CONTROLS_IDLE_MS);
  }, [clearControlsTimer]);
  const revealControls = useCallback(() => {
    setControlsVisible(true);
    hideControlsAfterIdle();
  }, [hideControlsAfterIdle]);

  useEffect(() => () => clearControlsTimer(), [clearControlsTimer]);

  useEffect(() => {
    let live = true;
    void probeCompositor().then((found) => {
      if (live) setCompositor(found);
    });
    return () => {
      live = false;
    };
  }, []);

  /* Where the file goes, before anything is pressed: the project's name in the
     folder the last export went to (or Videos). Rust builds that path itself;
     Browse… replaces it with whatever the Save dialog returns. */
  useEffect(() => {
    let live = true;
    void defaultExportDestination(suggestedFileName(config.name)).then(
      (found) => { if (live && found) setDestination((current) => current ?? { path: found.path, fromDialog: false }); },
      (reason) => { if (live) setDestinationError(describe(reason)); },
    );
    return () => { live = false; };
  }, [config.name]);

  // A scrub past the end of a shortened timeline would ask for a frame nothing
  // renders, so the playhead follows the content.
  useEffect(() => {
    setPreviewTimeMs((current) => Math.min(current, Math.max(0, plan.durationMs - 1)));
  }, [plan.durationMs]);

  useEffect(() => {
    if (!support.encoder || plan.frameCount === 0) {
      setProbes(null);
      return;
    }
    let live = true;
    setProbes(null);
    void probeAllCodecs(plan, bitrate)
      .then((found) => {
        if (live) setProbes(found);
      })
      .catch(() => {
        if (live) setProbes(null);
      });
    return () => {
      live = false;
    };
    /* Deliberately keyed on the plan's shape rather than on the plan: it is a
       new object on every settings change, and re-probing the encoder for a
       changed clip label would be a stutter for nothing. */
  }, [support.encoder, plan.width, plan.height, plan.frameRate, plan.frameCount, bitrate]);

  /* Fullscreen is the browser's to grant and the user's to leave — Escape and
     the window chrome both end it without asking this component — so the
     button reads the document rather than remembering what it did. */
  useEffect(() => {
    const sync = () => {
      const now = document.fullscreenElement === stageRef.current;
      setFullscreen(now);
      if (now) revealControls();
      else { clearControlsTimer(); setControlsVisible(false); }
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [revealControls, clearControlsTimer]);

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => undefined);
    else void stage.requestFullscreen?.().catch(() => undefined);
  };

  const frameMs = 1000 / plan.frameRate;
  const lastFrame = Math.max(0, plan.frameCount - 1);
  /* Every transport step lands on the first millisecond of a frame, so the
     clock under the picture names the frame the encoder will write there. */
  const seekToFrame = (frame: number) => {
    setPlaying(false);
    setPreviewTimeMs(frameStartMs(Math.max(0, Math.min(lastFrame, frame)), plan.frameRate));
  };
  const currentFrame = frameAt(previewTimeMs, plan.frameRate);

  const codecProbe = probes?.find((probe) => probe.id === settings.codec) ?? null;
  const blockers = [...plan.blockers];
  if (!support.desktop) {
    blockers.push(
      "This is the browser preview. There is no project folder to read media from and nowhere on disk to write a file, so exporting is only available in the Slopus desktop app.",
    );
  }
  if (!support.encoder || !support.decoder) {
    blockers.push("This webview has no WebCodecs VideoEncoder/VideoDecoder, so it cannot decode or encode video.");
  }
  if (codecProbe && !codecProbe.supported) {
    blockers.push(`This computer will not encode ${settings.codec.toUpperCase()} at ${plan.width}×${plan.height}: ${codecProbe.detail}`);
  }
  if (running && !ours) blockers.push("Another project is exporting. Wait for it to finish.");
  const canExport = blockers.length === 0 && !running;

  const browse = async (): Promise<Destination | null> => {
    setDestinationError(null);
    try {
      const chosen = await chooseExportDestination(suggestedFileName(config.name));
      if (!chosen) return null;
      const next = { path: chosen, fromDialog: true };
      setDestination(next);
      return next;
    } catch (reason) {
      setDestinationError(describe(reason));
      return null;
    }
  };

  const start = async () => {
    if (!canExport) return;
    dismissExportOutcome();
    const target = destination ?? await browse();
    if (!target) return; // The user closed the save dialog. Nothing to say.
    if (!target.fromDialog) {
      let exists = false;
      try { exists = await exportDestinationExists(target.path); } catch (reason) { setDestinationError(describe(reason)); return; }
      if (exists && !await askNative({
        title: "Replace file?",
        message: `${fileName(target.path)} already exists in ${folderOf(target.path)}. Replace it?`,
        kind: "warning",
        okLabel: "Replace",
        cancelLabel: "Cancel",
      })) return;
    }
    /* The dialog's own replace question covers one export; the next export to
       the same path is asked again, because by then the file is this one. */
    setDestination({ path: target.path, fromDialog: false });
    setPlaying(false);
    await startExportJob({ folderPath, config, settings, plan, bitrate, destination: target.path });
  };

  const openFile = (path: string) => {
    void openExportFile(path).catch((reason) => messageNative({ title: "Could not open the video", message: describe(reason), kind: "error" }));
  };
  const showInFolder = (path: string) => {
    void revealInExplorer(path).catch((reason) => messageNative({ title: "Could not show the file", message: describe(reason), kind: "error" }));
  };

  const summary: Array<[string, string, string?]> = [
    ["Duration", formatDuration(plan.durationMs), `${plan.frameCount} frames at ${plan.frameRate} fps`],
    ["Estimated size", formatBytes(estimatedBytes(bitrate, plan.durationMs))],
    [
      "Sound",
      plan.audio.length === 0
        ? "None"
        : support.audio
          ? `AAC · ${plan.audio.length} ${plan.audio.length === 1 ? "clip" : "clips"} mixed`
          : "None",
      plan.audio.length === 0
        ? plan.audioClipCount > 0
          ? "every audio clip falls outside the picture"
          : "no audio clips on the timeline"
        : support.audio
          ? /* The mix is built whole before the file is opened and held until
               the last frame, so its size is a real cost of this export and is
               stated with the rest of them rather than discovered as a crash. */
            `48 kHz stereo, gaps filled with silence · ${formatBytes(audioMixBytes(plan.durationMs))} of memory held while it renders`
          : "this webview has no AudioEncoder",
    ],
    [
      "Compositor",
      compositor ? (compositor.kind === "webgpu" ? "WebGPU" : "2D canvas") : "Checking…",
      compositor
        ? compositor.kind === "webgpu"
          ? "frames scaled without leaving the GPU"
          : compositor.detail
        : "requesting a GPU adapter",
    ],
  ];

  const progress = runningHere ? job.progress : null;
  const percent = Math.round(exportFraction(progress) * 100);
  const progressLine = progress
    ? [
      `${percent}%`,
      job.remainingMs !== null ? `${clock(job.remainingMs)} remaining` : null,
      progress.phase === "rendering" && progress.framesDone > 0
        ? `Encoding frame ${progress.framesDone} of ${progress.frameCount}`
        : progress.detail.replace(/\.$/, ""),
    ].filter(Boolean).join(" · ")
    : null;
  const outcome = ours ? job.outcome : null;
  const empty = plan.frameCount === 0;
  const transportDisabled = empty;

  return <div className="export-view" style={settingsPane.style}>
    <h1 className="sr-only">Export</h1>
    <div className="export-body">
      <section className="export-preview" aria-label="Video preview">
        {/* The same player the timeline uses, on the same cut: it decodes the
            real files and plays them with their sound. What the export will
            contain is what this plays — the picture is fitted inside the
            project's frame and the rest is the project's background. */}
        <div
          className={`export-stage${fullscreen ? " export-stage--fullscreen" : ""}${controlsVisible ? " export-stage--controls-visible" : ""}`}
          ref={stageRef}
          onPointerMove={fullscreen ? revealControls : undefined}
          onPointerDown={fullscreen ? revealControls : undefined}
          onFocusCapture={fullscreen ? () => { clearControlsTimer(); setControlsVisible(true); } : undefined}
          onBlurCapture={fullscreen ? (event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hideControlsAfterIdle();
          } : undefined}
        >
          {/* The frame IS the project's frame. Sized from the plan rather than
              from whatever is under the playhead: the export writes one frame
              size for the whole file, and this shows that size the whole time. */}
          <div className="export-picture" style={{ aspectRatio: `${plan.width} / ${plan.height}`, "--frame-aspect": plan.width / plan.height } as React.CSSProperties}>
            <ProgramMonitor
              config={config}
              folderPath={folderPath}
              playheadMs={previewTimeMs}
              playing={playing}
              onSeek={seek}
              onPlayingChange={changePlaying}
            />
          </div>
          {/* Windowed: a plain 36px bar under the picture. Fullscreen: the
              same bar over the picture's foot, hiding when the pointer rests. */}
          <div className="export-transport" role="group" aria-label="Video playback controls">
            <button type="button" className="export-transport__button" onClick={() => seekToFrame(0)} disabled={transportDisabled} aria-label="Go to start" {...tooltipProps("Go to start", "Home")}><ChevronFirst size={16} aria-hidden="true" /></button>
            <button type="button" className="export-transport__button" onClick={() => seekToFrame(currentFrame - 1)} disabled={transportDisabled} aria-label="Previous frame" {...tooltipProps("Previous frame", "Left")}><StepBack size={16} aria-hidden="true" /></button>
            <button
              type="button"
              className="export-transport__button"
              onClick={() => setPlaying((value) => !value)}
              disabled={runningHere || transportDisabled}
              aria-label={playing ? "Pause" : "Play"}
              {...tooltipProps(empty ? "Nothing on the timeline to play" : playing ? "Pause" : "Play", empty ? undefined : "Space")}
            >{playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}</button>
            <button type="button" className="export-transport__button" onClick={() => seekToFrame(currentFrame + 1)} disabled={transportDisabled} aria-label="Next frame" {...tooltipProps("Next frame", "Right")}><StepForward size={16} aria-hidden="true" /></button>
            <button type="button" className="export-transport__button" onClick={() => seekToFrame(lastFrame)} disabled={transportDisabled} aria-label="Go to end" {...tooltipProps("Go to end", "End")}><ChevronLast size={16} aria-hidden="true" /></button>
            <Slider
              className="export-transport__scrub"
              min={0}
              max={Math.max(0, plan.durationMs - 1)}
              step={Math.max(1, Math.round(frameMs))}
              value={previewTimeMs}
              disabled={transportDisabled}
              aria-label="Playhead"
              onChange={(value) => { setPlaying(false); setPreviewTimeMs(value); }}
            />
            <span className="export-transport__time">
              <span>{formatTimecode(previewTimeMs, plan.frameRate)}</span> / <span>{formatTimecode(plan.durationMs, plan.frameRate)}</span>
            </span>
            <button
              type="button"
              className="export-transport__button"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Exit full screen" : "Full screen"}
              {...tooltipProps(fullscreen ? "Exit full screen" : "Full screen", fullscreen ? "Esc" : undefined)}
            >{fullscreen ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}</button>
          </div>
        </div>
        {empty && <p className="export-stage__caption">Nothing on the timeline yet</p>}
      </section>

      <Splitter {...settingsPane.splitterProps} reverse aria-label="Resize export settings" aria-controls="export-settings" />

      {/* No title: the pane opens on its first section, like every inspector. */}
      <section id="export-settings" className="export-settings" aria-label="Export settings">
        <div className="export-settings__scroll">
          <PropSection title="Output" persistKey="export.output">
            <PropRow label={<span id="export-destination-label">Save to</span>}>
              <div className="export-destination">
                <span className="export-destination__path" {...tooltipProps(destination?.path)}>
                  {destination ? destination.path : support.desktop ? "Choose a file…" : "Available in the desktop app"}
                </span>
                <button
                  type="button"
                  className="secondary-button export-destination__browse"
                  disabled={runningHere || !support.desktop}
                  aria-describedby="export-destination-label"
                  onClick={() => void browse()}
                >Browse…</button>
              </div>
            </PropRow>

            <PropRow label="Resolution" htmlFor="export-resolution">
              <ComboBox
                id="export-resolution"
                value={settings.resolution}
                disabled={runningHere}
                onChange={(value) => setSettings({ ...settings, resolution: value as Resolution })}
                options={resolutionChoices(config.settings.resolution).map((resolution) => {
                  const size = outputDimensions(resolution, config.settings.aspectRatio);
                  return { value: resolution, label: `${size.width} × ${size.height}` };
                })}
              />
            </PropRow>

            <PropRow label="Frame rate" htmlFor="export-frame-rate">
              <ComboBox
                id="export-frame-rate"
                value={String(settings.frameRate)}
                disabled={runningHere}
                onChange={(value) => setSettings({ ...settings, frameRate: Number(value) as FrameRate })}
                options={FRAME_RATES.map((rate) => ({ value: String(rate), label: `${rate} fps` }))}
              />
            </PropRow>

            <PropRow label="Format" htmlFor="export-codec">
              <ComboBox
                id="export-codec"
                value={settings.codec}
                disabled={runningHere}
                onChange={(value) => setSettings({ ...settings, codec: value as OutputCodecId })}
                options={OUTPUT_CODECS.map((codec) => {
                  const probe = probes?.find((candidate) => candidate.id === codec.id);
                  const unsupported = probe ? !probe.supported : false;
                  return { value: codec.id, label: `MP4 · ${codec.label}${unsupported ? " (not supported here)" : ""}`, disabled: unsupported };
                })}
              />
            </PropRow>

            <PropRow label="Quality" htmlFor="export-quality">
              <ComboBox
                id="export-quality"
                value={settings.quality}
                disabled={runningHere}
                onChange={(value) => setSettings({ ...settings, quality: value as QualityId })}
                options={QUALITY_PRESETS.map((preset) => ({
                  value: preset.id,
                  label: `${preset.label} · ${(bitrateFor(plan.width, plan.height, plan.frameRate, preset.id) / 1_000_000).toFixed(1)} Mbit/s`,
                }))}
              />
            </PropRow>
          </PropSection>

          {/* Facts on the same --prop-label column as the rows above; a dl
              rather than PropRows because nothing here is a field. */}
          <PropSection title="Summary" persistKey="export.summary" summary={formatBytes(estimatedBytes(bitrate, plan.durationMs))}>
            <dl className="export-summary">
              {summary.map(([term, value, detail]) => <div key={term}>
                <dt>{term}</dt>
                <dd>{value}{detail && <small>{detail}</small>}</dd>
              </div>)}
            </dl>
          </PropSection>

          <div className="export-messages">
            {destinationError && <InfoBar severity="error" title="Save location" message={destinationError} onClose={() => setDestinationError(null)} />}
            {blockers.length > 0 && <InfoBar severity="error" title="Can’t export yet">
              <ul className="export-reasons">{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            </InfoBar>}
            {outcome?.kind === "saved" && outcome.audioProblems.length > 0 && <InfoBar severity="warning" title="Left out of the soundtrack">
              <ul className="export-reasons">{outcome.audioProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
            </InfoBar>}
            {/* These clips ARE in the file. Part of each one is silence because
                the sound behind it ran out. */}
            {outcome?.kind === "saved" && outcome.audioShortfalls.length > 0 && <InfoBar severity="warning" title="Sound ran out before the clip ended">
              <ul className="export-reasons">{outcome.audioShortfalls.map((shortfall) => <li key={shortfall}>{shortfall}</li>)}</ul>
            </InfoBar>}
          </div>
        </div>

        {/* The pane's foot, pinned under the scrolling sections: the run's
            progress or outcome, then Cancel / Export. */}
        <div className="export-settings__foot">
          <div className="export-settings__status" aria-live="polite">
            {progress && <div className="export-progress" role="status">
              <span className="export-progress__line">{progressLine}</span>
              <ProgressBar value={percent} aria-label="Export progress" />
            </div>}
            {!progress && outcome?.kind === "saved" && <InfoBar
              severity="success"
              title="Exported"
              message={`Exported to ${outcome.path}`}
              action={<>
                <button type="button" className="secondary-button" onClick={() => openFile(outcome.path)}>Open</button>
                <button type="button" className="secondary-button" onClick={() => showInFolder(outcome.path)}>Show in folder</button>
              </>}
              onClose={dismissExportOutcome}
            />}
            {!progress && outcome?.kind === "cancelled" && <InfoBar
              severity="informational"
              title="Export cancelled"
              message="Nothing was written."
              onClose={dismissExportOutcome}
            />}
            {!progress && outcome?.kind === "failed" && <InfoBar severity="error" title="Export failed" message={outcome.message} onClose={dismissExportOutcome} />}
          </div>
          <div className="export-settings__actions">
            {runningHere
              ? <button type="button" className="secondary-button" onClick={cancelExportJob} {...tooltipProps("Stop encoding. Nothing has been written yet.")}>Cancel</button>
              : onClose && <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>}
            <button
              type="button"
              className="primary-button"
              disabled={!canExport}
              onClick={() => void start()}
              {...tooltipProps(canExport ? undefined : runningHere ? "Export is running" : blockers[0])}
            >{runningHere ? "Exporting…" : "Export"}</button>
          </div>
        </div>
      </section>
    </div>
    {/* The encoder and compositor this export would run on, as this machine
        answered the probes above. Nothing is shown until they have answered. */}
    <ProjectStatus label="Export status">
      {codecProbe?.supported && <span className="project-status__fact" {...tooltipProps("The codec string this computer's WebCodecs encoder accepted")}>
        Encode <b>{OUTPUT_CODECS.find((codec) => codec.id === settings.codec)?.label ?? settings.codec}</b> · {codecProbe.codecString}
      </span>}
      {compositor && <span className="project-status__fact" {...tooltipProps(compositor.detail)}>
        {compositor.kind === "webgpu" ? <>GPU <b>{compositor.adapterName || "WebGPU"}</b></> : <>Compositor <b>2D canvas</b></>}
      </span>}
    </ProjectStatus>
  </div>;
}
