import { CircleCheck, Download, Maximize, Minimize, Pause, Play, SkipBack, SkipForward, TriangleAlert, X } from "lucide-react";
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
  detectExportSupport,
  ExportCancelled,
  probeAllCodecs,
  probeCompositor,
  runExport,
  writeExportFile,
  type CodecProbe,
  type CompositorProbe,
  type ExportProgress,
} from "../../lib/exportPipeline";
import { ProgramMonitor } from "./ProgramMonitor";
import { PROJECT_RESOLUTIONS, type ProjectConfig, type Resolution } from "../../lib/project";

/* The ladder a project can be created at, plus the project's own size when that
   is one of the names from before the ladder was rebuilt. Dropping the legacy
   rung outright would leave a 1080p project looking at a select that does not
   contain what the project IS, and the first touch of any other field would
   have quietly resized the export. */
const resolutionChoices = (current: Resolution): Resolution[] =>
  PROJECT_RESOLUTIONS.includes(current as (typeof PROJECT_RESOLUTIONS)[number])
    ? [...PROJECT_RESOLUTIONS]
    : [...PROJECT_RESOLUTIONS, current];
const FRAME_RATES: FrameRate[] = [24, 25, 30, 60];
const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** How long the Saved notification stays up before it takes itself away. */
const SAVED_NOTICE_MS = 4_000;

/* What the finished run left OUT of the soundtrack. Everything else an export
   used to report on the page — path, size, codec, compositor — is gone: the
   confirmation is a notification that says Saved and then leaves. These two
   lists are not a confirmation, they are the failure worth shouting about, so
   they stay until the next run replaces them. */
interface LeftOut {
  audioProblems: string[];
  audioShortfalls: string[];
}

export function ExportView({ config, folderPath }: { config: ProjectConfig; folderPath: string }) {
  const [settings, setSettings] = useState<ExportSettings>(() => defaultExportSettings(config));
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
  const stageRef = useRef<HTMLDivElement>(null);

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  /* The finished run says one word, in the middle of the header, and stops
     saying it. A panel that sat in the corner until the next export could not
     tell "just saved" from "saved twenty minutes ago". */
  const [saved, setSaved] = useState(false);
  const [leftOut, setLeftOut] = useState<LeftOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const cancelRef = useRef(false);
  const running = progress !== null;

  /* The playhead is the view's, and the monitor drives it while it plays —
     these are handed down rather than declared inline because the monitor's
     animation loop tears itself down and rebuilds when their identity changes.
     See ProgramMonitor. */
  const seek = useCallback((ms: number) => setPreviewTimeMs(ms), []);
  const changePlaying = useCallback((value: boolean) => setPlaying(value), []);

  /* Switching tabs unmounts this view, and an export that kept running would
     finish and write a file with nothing on screen to say so. Leaving stops it
     instead — nothing has been written yet at any point before the end. */
  useEffect(() => () => {
    cancelRef.current = true;
  }, []);

  useEffect(() => {
    let live = true;
    void probeCompositor().then((found) => {
      if (live) setCompositor(found);
    });
    return () => {
      live = false;
    };
  }, []);

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
    const sync = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  /* The notification takes itself away. Re-armed on every run, and cleared on
     the way out so a saved export that is left behind does not fire into an
     unmounted view. */
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const toggleFullscreen = () => {
    const stage = stageRef.current;
    if (!stage) return;
    if (document.fullscreenElement === stage) void document.exitFullscreen().catch(() => undefined);
    else void stage.requestFullscreen?.().catch(() => undefined);
  };

  const step = (deltaMs: number) => {
    setPlaying(false);
    setPreviewTimeMs((current) => Math.round(Math.max(0, Math.min(Math.max(0, plan.durationMs - 1), current + deltaMs))));
  };

  const codecProbe = probes?.find((probe) => probe.id === settings.codec) ?? null;
  const blockers = [...plan.blockers];
  if (!support.desktop) {
    blockers.push(
      "This is the browser preview. There is no project folder to read media from and nowhere on disk to write a file, so exporting is only available in the PolStudio desktop app.",
    );
  }
  if (!support.encoder || !support.decoder) {
    blockers.push("This webview has no WebCodecs VideoEncoder/VideoDecoder, so it cannot decode or encode video.");
  }
  if (codecProbe && !codecProbe.supported) {
    blockers.push(`This computer will not encode ${settings.codec.toUpperCase()} at ${plan.width}×${plan.height}: ${codecProbe.detail}`);
  }
  const canExport = blockers.length === 0 && !running;

  const start = async () => {
    setError(null);
    setSaved(false);
    setLeftOut(null);
    setCancelled(false);
    let destination: string | null = null;
    try {
      destination = await chooseExportDestination(suggestedFileName(config.name));
    } catch (reason) {
      setError(describe(reason));
      return;
    }
    if (!destination) return; // The user closed the save dialog. Nothing to say.
    cancelRef.current = false;
    setProgress({ phase: "preparing", framesDone: 0, frameCount: plan.frameCount, detail: "Starting…" });
    try {
      const outcome = await runExport({
        folderPath,
        config,
        settings,
        plan,
        bitrate,
        onProgress: setProgress,
        cancelled: () => cancelRef.current,
      });
      setProgress({
        phase: "writing",
        framesDone: plan.frameCount,
        frameCount: plan.frameCount,
        detail: `Writing ${formatBytes(outcome.bytes.byteLength)} to ${destination}…`,
      });
      await writeExportFile(destination, outcome.bytes);
      setLeftOut({ audioProblems: outcome.audioProblems, audioShortfalls: outcome.audioShortfalls });
      setSaved(true);
    } catch (reason) {
      if (reason instanceof ExportCancelled) setCancelled(true);
      else setError(describe(reason));
    } finally {
      setProgress(null);
    }
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
      compositor ? (compositor.kind === "webgpu" ? "WebGPU" : "2D canvas") : "asking this computer…",
      compositor
        ? compositor.kind === "webgpu"
          ? "frames scaled without leaving the GPU"
          : compositor.detail
        : "requesting a GPU adapter",
    ],
  ];

  return <div className="export-view">
    {/* The action lives beside the title, where every other screen in
        PolStudio puts its main button (see the References header). It used to
        sit at the bottom of the right-hand column, below everything the page
        had to say — which is a long way to scroll to press the one control the
        screen exists for. */}
    <header className="export-heading">
      <h1>Export</h1>
      {/* A notification, not a panel: it appears between the title and the
          button that produced it, says the one thing there is to say, and goes.
          The middle column is always there whether or not it holds anything, so
          nothing on either side of it moves when it arrives or leaves. */}
      <div className="export-toast-slot" aria-live="polite">
        {saved && <p className="export-toast">
          <CircleCheck size={16} aria-hidden="true" /> Saved
        </p>}
      </div>
      <div className="export-heading__actions">
        {running && <button
          className="secondary-button"
          type="button"
          onClick={() => { cancelRef.current = true; }}
          title="Stop encoding. Nothing has been written to disk yet."
        ><X size={16} aria-hidden="true" /> Cancel</button>}
        <button
          className="primary-button"
          type="button"
          disabled={!canExport}
          onClick={() => void start()}
          title={canExport ? "Choose where to save, then render the timeline" : blockers[0] ?? "Export is running"}
        >
          <Download size={16} aria-hidden="true" /> {running ? "Exporting…" : "Export video"}
        </button>
      </div>
    </header>

    <div className="export-layout">
      <section className="export-preview" aria-labelledby="export-preview-heading">
        <h2 id="export-preview-heading">Video</h2>
        {/* The same player the timeline uses, on the same cut: it decodes the
            real files and plays them with their sound, rather than decoding one
            still frame per scrub. What the export will contain is what this
            plays — the picture is fitted inside the project's frame and the
            rest is the project's background, exactly as the encoder does it. */}
        {/* The stage IS the project's frame. Sized from the plan rather than
            from whatever is under the playhead, or a portrait still on the
            timeline would make the preview tall and the next video clip would
            shrink it back — the export writes one frame size for the whole
            file, and this shows that size the whole time. */}
        <div
          className="export-stage"
          ref={stageRef}
          style={{ aspectRatio: `${plan.width} / ${plan.height}`, "--frame-aspect": plan.width / plan.height } as React.CSSProperties}
        >
          <ProgramMonitor
            config={config}
            folderPath={folderPath}
            playheadMs={previewTimeMs}
            playing={playing}
            onSeek={seek}
            onPlayingChange={changePlaying}
          />
        </div>
        <div className="export-transport">
          <button
            type="button"
            onClick={() => step(-1000)}
            disabled={plan.frameCount === 0}
            aria-label="Back one second"
            title="Back one second"
          ><SkipBack size={16} aria-hidden="true" /></button>
          <button
            type="button"
            className="export-transport__play"
            onClick={() => setPlaying((value) => !value)}
            disabled={plan.frameCount === 0}
            aria-label={playing ? "Pause" : "Play"}
            title={plan.frameCount === 0 ? "There is nothing on the timeline to play" : playing ? "Pause" : "Play"}
          >{playing ? <Pause size={16} fill="currentColor" aria-hidden="true" /> : <Play size={16} fill="currentColor" aria-hidden="true" />}</button>
          <button
            type="button"
            onClick={() => step(1000)}
            disabled={plan.frameCount === 0}
            aria-label="Forward one second"
            title="Forward one second"
          ><SkipForward size={16} aria-hidden="true" /></button>
          <input
            id="export-scrub"
            type="range"
            min={0}
            max={Math.max(0, plan.durationMs - 1)}
            step={Math.max(1, Math.round(1000 / plan.frameRate))}
            value={previewTimeMs}
            disabled={plan.frameCount === 0}
            aria-label="Playhead"
            onChange={(event) => { setPlaying(false); setPreviewTimeMs(Number(event.target.value)); }}
          />
          <output htmlFor="export-scrub">{formatDuration(previewTimeMs)}</output>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? "Leave fullscreen" : "Watch fullscreen"}
            title={fullscreen ? "Leave fullscreen" : "Watch fullscreen"}
          >{fullscreen ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}</button>
        </div>
        {/* The one thing left to say under the picture: that there is no
            picture. The frame-by-frame caption that used to live here named a
            clip and an offset nobody was reading. */}
        {plan.frameCount === 0 && <p className="export-stage__caption">There is nothing on the timeline yet.</p>}
      </section>

      <section className="export-settings" aria-labelledby="export-settings-heading">
        <h2 id="export-settings-heading">Settings</h2>

        <div className="export-fields">
          <label htmlFor="export-resolution">
            <span>Resolution</span>
            <select
              id="export-resolution"
              value={settings.resolution}
              disabled={running}
              onChange={(event) => setSettings({ ...settings, resolution: event.target.value as Resolution })}
            >
              {resolutionChoices(config.settings.resolution).map((resolution) => {
                const size = outputDimensions(resolution, config.settings.aspectRatio);
                return <option key={resolution} value={resolution}>{size.width} × {size.height}</option>;
              })}
            </select>
          </label>

          <label htmlFor="export-frame-rate">
            <span>Frame rate</span>
            <select
              id="export-frame-rate"
              value={settings.frameRate}
              disabled={running}
              onChange={(event) => setSettings({ ...settings, frameRate: Number(event.target.value) as FrameRate })}
            >
              {FRAME_RATES.map((rate) => <option key={rate} value={rate}>{rate} fps</option>)}
            </select>
          </label>

          <label htmlFor="export-codec">
            <span>Container &amp; codec</span>
            <select
              id="export-codec"
              value={settings.codec}
              disabled={running}
              onChange={(event) => setSettings({ ...settings, codec: event.target.value as OutputCodecId })}
            >
              {OUTPUT_CODECS.map((codec) => {
                const probe = probes?.find((candidate) => candidate.id === codec.id);
                const unsupported = probe ? !probe.supported : false;
                return <option key={codec.id} value={codec.id} disabled={unsupported} title={probe?.detail ?? codec.detail}>
                  .mp4 · {codec.label}{unsupported ? " — not supported here" : ""}
                </option>;
              })}
            </select>
          </label>

          <label htmlFor="export-quality">
            <span>Quality</span>
            <select
              id="export-quality"
              value={settings.quality}
              disabled={running}
              onChange={(event) => setSettings({ ...settings, quality: event.target.value as QualityId })}
            >
              {QUALITY_PRESETS.map((preset) => <option key={preset.id} value={preset.id} title={preset.detail}>
                {preset.label} · {(bitrateFor(plan.width, plan.height, plan.frameRate, preset.id) / 1_000_000).toFixed(1)} Mbit/s
              </option>)}
            </select>
          </label>

        </div>

        <h2>What this export will be</h2>
        <dl className="export-summary">
          {summary.map(([term, value, detail]) => <div key={term}>
            <dt>{term}</dt>
            <dd>{value}{detail && <small>{detail}</small>}</dd>
          </div>)}
        </dl>

        {blockers.length > 0 && <div className="export-notice export-notice--bad" role="alert">
          <h3><TriangleAlert size={16} aria-hidden="true" /> Not possible yet</h3>
          <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        </div>}

        {progress && <div className="export-progress" role="status">
          <div className="progress-track">
            <i style={{ width: `${progress.frameCount === 0 ? 0 : Math.round((progress.framesDone / progress.frameCount) * 100)}%` }} />
          </div>
          <p>{progress.detail} <small>{progress.framesDone} / {progress.frameCount} frames</small></p>
          <p><small>Nothing is written until the encode finishes. Leaving this tab cancels the run.</small></p>
        </div>}

        {cancelled && <p className="export-outcome" role="status">
          Export cancelled. Nothing was written — the file is only saved once the whole encode finishes.
        </p>}

        {error && <div className="export-notice export-notice--bad" role="alert">
          <h3><TriangleAlert size={16} aria-hidden="true" /> The export failed</h3>
          {/* Verbatim. A rewritten error is an error nobody can act on. */}
          <p>{error}</p>
        </div>}

        {/* The export itself is confirmed by the notification in the header and
            nowhere else. What stays on the page is only what went WRONG with the
            sound — a soundtrack that vanished without a word is not something to
            fade out after four seconds. */}
        {leftOut && leftOut.audioProblems.length > 0 && <div className="export-notice" role="alert">
          <h3><TriangleAlert size={16} aria-hidden="true" /> Left out of the soundtrack</h3>
          <ul>{leftOut.audioProblems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        </div>}

        {/* These clips ARE in the file. Part of each one is silence because the
            sound behind it ran out, which is exactly as inaudible as a missing
            clip and was previously reported nowhere. */}
        {leftOut && leftOut.audioShortfalls.length > 0 && <div className="export-notice" role="alert">
          <h3><TriangleAlert size={16} aria-hidden="true" /> Ran out of sound before the clip ended</h3>
          <ul>{leftOut.audioShortfalls.map((shortfall) => <li key={shortfall}>{shortfall}</li>)}</ul>
        </div>}
      </section>
    </div>
  </div>;
}
