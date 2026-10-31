# Slopfab compatibility

## Bundled runtime (API 1.48.0)

Windows and Linux runtimes use SlopFab commit `54362786a76e7530f7216dfeca130835a8f298f3`
from `D:\Projects\slopfab`, with CUDA and Vulkan enabled and FFmpeg disabled.
This update keeps Keystone and delayed Capstone context inside sampling: the
original front latent is restored before output, and Capstone adds one clean
video latent only during model calls. It does not replace generated end frames
or add hidden tail frames. Single Shot with Context video uses the two-minute
anchored experiment's fully locked 22-frame overlap. The complete previous
video/audio archive is retained; no previously generated tail is replaced.
TAEH3 now also decodes single-frame MiniMax image previews on CUDA and Vulkan.
Video previews autoplay and loop inside the existing shot card player; image
previews update the image canvas and thumbnail. Both use the generation previews
setting and require the optional TAEH3 weights. Saved-latent upscaling remains supported.

LAN protocol is 31 so workers use the same fully locked overlap, portable LCS Drift calibration, Keystone conditioning, image crop
merging, Single Shot Tone and overlap behavior. Single Shot automatically shortens its preferred four-update
Capstone delay when the resolved video schedule is shorter, without changing the
LoRA recipe. Restart Slopus and update workers to load the new runtime.

Both platform builds pass C API and embedded-tokenizer checks. Slopus core tests
pass against the Windows DLL. Single-frame TAEH3 decoding matches the upstream
causal first-frame reference exactly on CUDA and Vulkan. Linux retains the Fibo text-renderer linker
workaround documented below.

## Single Shot

The bundled runtime includes the Keystone conditioning correction from SlopFab
`89e1cca`. With Context video selected, the original context's first latent slice
now guides both the locked target overlap and its visual conditioning at the
same position. Previously the guide retained the advancing video's slice,
contradicting the original anchor and weakening its influence early in sampling.
The correction applies to CUDA and Vulkan and is intended to reduce appearance
degradation across continuations. It requires no new C API calls. Context-video
generation snapshots record the corrected guide so older takes can be regenerated;
existing saved media and latents are not modified.

Validation for this update includes SlopFab's host continuation tests, C API and
embedded-tokenizer checks on Windows and Linux, and Slopus core and frontend
tests. The bundled Windows DLL also passes the real-weight Keystone smoke test
on CUDA and Vulkan, using Slopus's portable arithmetic policy for Vulkan. These
small synthetic-prompt runs verify early anchor influence, source preservation
and retained/file parity; they are not a visual quality benchmark.

With Context video selected, Single Shot continues from Previous video's saved
latents while using the sequence's first video as its persistent Keystone and
Capstone source. It runs one generation pass. The last 22 frames of Previous
video form the overlap and all remain locked. Native joining discards the
sampled overlap and appends only newly generated frames, preserving the complete
previous video/audio prefix and restoring the real front latent after Keystone
sampling. Previous video must contain at least 22 frames and both sources need
matching latent geometry.
Scene duration continues to mean newly added timeline frames; the sampling window
includes the 22-frame overlap. Cumulative audio boundaries avoid rounding drift.

### Two-minute experiment audit

Compared against SlopFab commit `94fcedc`, `docs/lcs_drift_4way.md`,
`tools/lcs_long_run.py`, and the recorded
`output/lcs-drift-120s-anchors/manifest.json` / `validation.json` in
`D:/Projects/slopfab`. The successful anchors-only arm starts from 73 frames,
adds 42 extensions of 68 frames, and exports the first 2,880 frames of the
2,929-frame joined archive at 24 fps.

The prior Slopus integration used SlopFab's separate Long Context recipe:
39-frame overlap, 22 held frames and 17 regenerated frames. That was **not** the
recipe used in this experiment. New context-video requests instead attach the
previous archive with overlap 22, explicitly lock video/audio, set regenerated
frames to zero, and attach the unchanged original archive with Capstone enabled.
No ending-first pass, repeated-source middle initialization or MotionCache is
used. Updated fingerprints distinguish these requests from existing takes;
existing saved media is not rewritten. Protocol 31 rejects older workers that
would override this overlap with the former recipe.

The experiment used Singularity Ref2VA v1.3 INT8, the original cached prompt
embedding, 384x384, CUDA, Flash2, 25 Euler grid points (24 updates), no LoRA or
LCS in its anchors-only arm, and seeds 424243–424284. Those remain generator /
scene choices in Slopus, not forced Single Shot defaults. Capstone uses four
video updates of delay when the schedule permits; the existing short-schedule
compatibility path reduces it when there are fewer than five video updates.
Such short schedules do not reproduce the experiment's delay.

The bundled runtime's anchoring implementation is unchanged between its pinned
commit and the experiment; the intervening production changes add optional LCS
output stability controls, which the anchors-only arm does not use. No runtime
binary replacement is needed for this correction.

The regression check independently constructs the experiment's native request
and compares its complete plan description with Slopus planning and execution
configuration on CUDA and Vulkan, at the first, second and 42nd handoffs. It
checks 22-frame locking, delay four, 24 evaluations, no overlap replacement,
unchanged source files, and the 2,929-frame endpoint. Small spatial fixtures
keep this check independent of model weights; it verifies request parity, not
a repeated two-minute visual quality benchmark.

Without Context video, Single Shot has one reference-aware prompt, an optional
ending prompt and an optional previous scene of any type with saved video latents. Its full clip's
ending context guides the new beginning. An empty ending prompt uses the main prompt.
Both stages share the same ordered reference bindings, generator settings and
seed. Generate all orders starting scenes before their dependents and rejects
cycles. Queued prompts remain captured while source latents resolve after the
starting scene finishes.

The worker prepares a 22-frame ending in a temporary latent archive. With a
starting scene, the ending pass continues from its final 22 frames of video and
audio latents with locked overlap, then crops the generated tail to 22 frames.
This conditions both passes on the source instead of forcing a transition to an
independently generated ending. Without a starting scene, the ending is generated
directly. The worker releases its decoded buffers, then attaches the ending with
`slopfab_request_set_end_anchor_file`. The full generation uses the requested
scene duration minus those 22 frames as its lead-in or gap. An optional starting
archive contributes its ending context; both boundaries are locked. MotionCache
is disabled for the anchored pass. The native frame stride still determines the
final duration; Single Shot requires at least two seconds.

Only the final joined output and latents enter scene history. Timeline ranges
identify each scene's own portion, retaining the shared decode at joins.
Temporary endings are removed on success, failure and cancellation. Starting
scenes must use compatible original latent resolutions. Protocol 24 also requires
workers to support saved-latent upscale requests.

For ending-first Single Shot (without Context video), Tone is omitted from the
temporary ending. The full pass sends `tone_after_denoise` with its native LCS
settings: contrast, brightness, saturation and temperature are applied once to
the assembled new main clip and ending, before saving latents and decoding.
Previously retained source frames are excluded. Region masks apply to both
parts identically. Step limits affect the remaining sampling effects; they do
not limit this final Tone adjustment. Sampling previews omit the final Tone pass.
Context-video Single Shot and other generation types retain their existing
sampling effects. Existing takes require regeneration; this change does not
remove effects already baked into previous/context source archives.

Single Shot disables `slopfab_request_set_continuation_source_init` in both
passes: repeating the final source latent slice across the new interval can
freeze the middle. Only the starting and ending contexts are fixed; new video
and audio start from fresh noise. The former Continuation strength control is
removed. Saved values remain readable in drafts/takes but do not affect new
requests; native planning and execution also ignore queued source-noise values
for Single Shot. Old generation fingerprints differ, allowing regeneration.

Checks cover prompt/reference compilation, persistence, dependency ordering,
queue snapshots, cancellation, temporary cleanup and native anchored planning.

## Music (API 1.38)

Bundled Windows and Linux runtimes support YuE2 and MiniMax Music3 on CUDA and
Vulkan, with FFmpeg disabled. LAN protocol 18 carries music settings and
audio-only results. Update workers alongside the app.

Music requests use `slopfab_request_set_music_settings` with style in the prompt,
model-specific controls and portable Vulkan arithmetic. They bypass H3 video
settings. Stereo samples are saved as 24-bit PCM WAV in `media/generated` and
appear in Music and timeline media. Song settings persist in `musicSongs`.

## Generation effects (API 1.31)

Scene and image root inspectors provide **Effects > Add effect** for native
LCS color steering, tone, experimental LCS Drift and sharpness, and self/smooth color
stabilization. Cards support bypass, reset and removal. A shared inclusive
step interval (zero-based) and optional percentage rectangle apply to all
active cards; the rectangle can be inverted. Neutral and bypassed controls
are omitted from generation requests and video render fingerprints.

Effects are saved with scenes, image drafts and generation snapshots. The
native core validates ranges and model capabilities before generation. The
shared model catalog enables LCS for MiniMax H3 and disables it for MOSS and Fibo.
These are sampling effects, separate from timeline postprocessing. They use
SlopFab's native implementation of the approach described by
[ComfyUI-LCS](https://github.com/facok/ComfyUI-LCS), without running ComfyUI.

The first active request calibrates its VAE automatically using 64 colors at
256 pixels. Calibration runs on the generation worker, reports progress and
honors cancellation. Completed archives are cached under `lcs` beside the
host's diagnostic log, keyed by full VAE SHA-256, calibration format and
parameters. Full-file fingerprints are cached in both Slopus and SlopFab for
the app/worker session. Each reuse checks file identity, size, modification and
filesystem change times, so edits and replacements trigger fresh verification.
The first use after a restart verifies the VAE again but reuses its saved
calibration. Cached checks do not show calibration progress. Slopus retains the
LCS library cache between isolated jobs while still releasing idle GPU model
buffers. Corrupt archives are regenerated. Planning never calibrates or
runs inference. The generation request snapshots the archive before sampling;
region masks use fractional coverage of the resolved latent patch grid.

LAN worker protocol 31 carries the portable controls and fitted drift archive and prevents older
workers from silently dropping them. Each worker calibrates and caches its
own VAE. Update workers alongside the desktop app. A runtime missing the LCS
exports reports an explicit upgrade error.

The original LCS integration used SlopFab commit `274ce2e` (API 1.31.0)
with FFmpeg disabled. Windows and Linux C API and embedded-tokenizer checks
pass, including the previously failing malformed LCS settings checks. Slopus
checks cover UI authoring, project persistence, request snapshots, worker
serialization, mask validation, calibration cancellation and callback panic
containment through the bundled DLL. Full generation and visual LCS quality
with model weights were not evaluated in this integration.

### LCS Drift

The LCS Drift card exposes independent highlight strength (0–1), highlight
threshold (0–2), learned drift strength (0–1), and maximum correction (0–10 raw
VAE units). It defaults to highlight strength 0.5 and threshold 0.8; learned
correction defaults to zero. Highlight compression uses the automatic VAE
calibration and needs no imported file. Both effects run during sampling,
including Single Shot, and honor the shared step range and region mask.

Learned correction requires **Import drift calibration**: a SlopFab v1 LCS
`.safetensors` archive fitted from early and late latent generations, containing
`drift_direction` and `drift_reference`. SlopFab's `tools/lcs_drift.py fit` produces
this archive. Slopus validates its size, tensor shapes, finite values, unit
direction and color orthogonality, then embeds the complete small archive as
base64 in the scene. It survives save/load, Take snapshots and worker transfer;
there is no dependency on the importing machine's file path. Importing does not
enable learned correction until its strength is increased. Removing the file
resets learned strength to zero. Bypassed and neutral effects do no work.

For active learned correction, the worker attaches the imported calibration
instead of the automatic cache. SlopFab validates its full contents and checks
the VAE SHA-256 before sampling. All active LCS cards use that archive, so include
its sharpness calibration if also using Sharpness. The correction is specific
to the fitted scene/checkpoint and VAE; its quality is experimental, and Slopus
does not automatically fit a direction or choose an optimal step interval.
The upstream drift experiment documents the fitting workflow and measured limits.

The updated Windows and Linux bundles pass 23,119 native LCS checks each, plus
C API and tokenizer tests. Slopus tests exercise controls, portable archive
validation, persistence, fingerprints, worker serialization and native attachment.

## Local edits on larger images

When an image editor's selected resolution is smaller than its source, rectangle
and lasso bounding boxes are limited to that resolution in original-image pixels.
The saved image retains its original dimensions. Each edit uses a target-sized
crop around its selection; the native sequence merges its result into the
original canvas before preparing the next crop. Pixels outside the rectangle or
lasso, including holes and transparency, remain unchanged. Rectangle feathering
blends inward once, even when the selection fills the crop. Edited results use PNG.

The optional `imageEdit.regionSize` carries the target width and height to local
generation and LAN workers. `canvasWidth`, `canvasHeight`, edit boxes and lasso
points continue to describe the original image. Planning and execution prepare
the same crop. Original files are never resized or overwritten for these jobs.
Protocol 28 prevents older workers from silently processing the full canvas.

Whole-image prompts still affect the full image: they run at the selected target
resolution and are resized back into the original canvas before local edits.
Crop previews are withheld so they cannot replace the full-image editor preview.

## Krea 2 image generation

Bundled Windows and Linux runtimes include Krea 2 on CUDA and Vulkan. Krea uses
the `krea2` model family, Flash attention, embedded Qwen tokenizer, text encoder
and image VAE slots. Vulkan requests explicitly select portable arithmetic.
The app exposes text-to-image controls and rejects editing, image references,
video, audio and H3-only conditioning before submitting requests.

Turbo uses 8 steps and CFG 0. Raw carries `kreaVariant: "raw"` in the template
and provider settings, defaults to 52 steps and CFG 3.5, and computes
`exp(0.5 + (image_tokens - 256) * 0.65 / (6400 - 256))`, where
`image_tokens = (width / 16) * (height / 16)`, unless an image sigma shift is
supplied. Krea guidance calls pass no unconditional skip layers; MOSS retains
its layer-22 setting. Krea prompts use plain image descriptions.

Validation covers native request planning for both recipes on CUDA and Vulkan,
frontend routing and controls, download limits, template migration and portable
recipe serialization. Full model inference was not run for this integration.

## MOSS image generation (API 1.30+)

The bundled Windows and Linux libraries expose SlopFab API 1.40.0, including
the MOSS model-family setter introduced in 1.30. Both builds disable FFmpeg.
MOSS uses CUDA/Flash attention, the image VAE slot, and a separate Qwen3.5
tokenizer file. It returns one RGB frame through the existing image save path.
Older workers report an explicit runtime-upgrade error for MOSS requests.

The shared model catalog declares CFG support and its default per model
(`cfg: null` for H3, `cfg: { "default": 3 }` for MOSS). The image inspector
shows CFG before Seed only for supported models. Image drafts and snapshots
store separate values in `cfgScales`, keyed by model ID; switching models
preserves these values. The queued request carries the selected `guidanceScale`,
including an explicitly captured default. Native validation rejects unsupported
models, negative/non-finite values and values outside the float32 range.

Slopus calls API 1.30's `slopfab_request_set_image_guidance` for planning and
generation, passing the image's saved negative prompt and preserving skip layer 22. CFG 1
uses only the positive branch. Worker protocol 11 prevents an older worker
from ignoring CFG. Tests verify the value in the bundled runtime's plan,
project persistence, queue isolation and saved output settings.

No full MOSS inference with model weights was run for this integration.

## Zoom boundary correction (1.28.2)

The earlier Windows and Linux runtimes used SlopFab commit `8fe7da0` (1.28.2),
built with `SLOPFAB_WITH_FFMPEG=OFF`. Outpaint VAE preparation extends source
edge pixels into the unknown canvas before encoding. Previously, grey padding
entered the VAE receptive field and contaminated locked source-edge latents
and positioned anchors with a rectangular boundary. Only the encoding input
changes: the semantic source reference, source rectangle, latent mask and
final composite still use their original geometry. Both CUDA and Vulkan use
this shared preparation path. Ordinary image edits are unchanged.

Zoom requests a 33-pixel Gaussian kernel, blending up to 32 pixels inside
source edges facing generated space (previously 8). For small intersections,
the kernel shrinks to retain an unblended interior at least 32 pixels wide.
Canvas edges without generated space do not fade. The save path retains the
native RGB result and restores source alpha. Crop regeneration is unchanged.

This is a runtime fix with no new C API or worker protocol. Restart Slopus
and update LAN workers to load the replacement library. Regression coverage
checks that unknown canvas pixels cannot affect outpaint encoding, source
pixels remain intact, and small intersections retain an unblended interior.
A real CUDA comparison at 416 x 416, 30 steps and seed 17 was visually checked;
both runs preserved their source interiors exactly and used 174 evaluations.
Slopus's GPU generation/save smoke test also passed with the bundled runtime;
the saved PNG retained the native blend exactly. Inpaint regression tests and
C API/tokenizer tests passed on Windows and Linux, along with the frontend
build, focused Zoom tests and 61 Slopus runtime integration tests.

## CUDA transformer loading memory recovery

Large transformer checkpoints now upload through a bounded staging ring
(two 32 MiB pinned buffers) instead of pinning the entire mapped file. Only
checkpoints at most 64 MiB retain whole-mapping registration. On Windows,
pinning a 20 GB checkpoint alongside the device arena reproduced an OOM at
the conversion/upload boundary despite ample free VRAM. Bounded staging
loaded the same checkpoint and completed repeated forward passes successfully.

SlopFab 1.28.1 prepares the FP16 weight-conversion kernel before querying
free VRAM, and reserves its upload scratch alongside activation headroom. This
avoids budgeting weights against memory that CUDA's lazy kernel loading still
needs. NVIDIA documents this allocation behavior in its
[lazy loading guide](https://docs.nvidia.com/cuda/archive/13.1.0/cuda-programming-guide/04-special-topics/lazy-loading.html).

If an automatic transformer load still receives `cudaErrorMemoryAllocation`,
it synchronizes uploads, releases the partial model, clears the handled CUDA
error and replans with a strictly smaller weight residency. The budget includes
both transfer slots, so each retry actually reduces device memory. Retries are
bounded by the block count and stop when the fixed weights and transfer slots
cannot fit. Explicit offload counts and unrelated errors are not retried.
Precision, references, resolution and sampling settings are preserved.

The Windows and Linux bundles use SlopFab commit `513ba29` (1.28.1), built with
`SLOPFAB_WITH_FFMPEG=OFF`. This fix changes no C API or worker protocol. Rebuild
and restart Slopus and update LAN workers to load the replacement library.
Regression coverage injects allocation failures to check cleanup, smaller
residency, error propagation and exhaustion; CUDA tests compare resident and
offloaded model output, including LoRAs and MotionCache.

Validation: Windows transformer synthetic tests completed 254 checks without
failures (11 deferred CPU-reference checks and one hardware skip). The real
20 GB FP8 checkpoint completed 26 checks without failures; the optional full
49-step run was skipped. Linux recovery, upload and offload comparisons passed,
but its broader transformer suite reported a row-chunk numerical-tolerance
failure in `transformer_row_chunks_match_full_rows` on CUDA 13.3. C API and
embedded-tokenizer tests passed on both platforms. Slopus runtime integration
tests passed with one ignored test.

## API 1.27: decode diagnostics

Successful native generations write an INFO-level `generation.video_decode`
entry to `slopus.log`, with the job ID, runtime version, backend, still-image
flag, output dimensions/frame count and total decode seconds. The `timings`
object contains `secondsPrepare`, `secondsUpscale`, `secondsModelOpen`,
`secondsWeightLoad`, `secondsCompute` and `secondsCleanup`.

Model open covers the file mapping and normalization statistics; weight load
covers decoder/device creation and loading the VAE. Compute includes workspace
allocations, transfers, kernels and tile assembly. Cleanup is the remainder,
including decoder destruction, temporary buffers, mapping teardown and minor
instrumentation overhead. These wall times sum to the total; the measurement
adds no GPU synchronization. Timings are per decode, so multi-edit images log
one entry for each edit under the same job ID. LAN generations log on the worker.

Slopus optionally loads `slopfab_generation_video_decode_timings`, leaving the
existing output ABI unchanged. Older runtimes retain aggregate timing, and a
diagnostic getter failure logs a warning without discarding generated media.
Both bundled runtimes include the new getter. Restart/rebuild the running app
to load the new library and logging code.

## API 1.26: legacy Long Shot latent bridges

Long Shot is no longer offered for new scenes; use Bridge instead. This support
remains for saved projects and their generated media.

Consecutive **Long Shot** scenes alternate fresh anchors and bridges. Generate
all queues 1, 3, 2, 5, 4, 7, 6. A bridge requires completed neighbors with saved
latents. With an even number of scenes, the final scene continues from the
previous anchor using the latest compatible joined archive. Four scenes run
in 1, 3, 2, 4 order. Adding a following Long Shot scene turns that continuation
into a bridge on its next generation.
The two margin controls replace the previous anchor's ending and the following
anchor's beginning in multiples of 17 frames (default 17, zero allowed).
Each anchor must also provide 22 preserved context frames. Use the same canvas,
VAE models and original latent resolution throughout the run. Cite original subject
references in every scene that needs them.

Slopus calls `slopfab_request_set_latent_bridge_files`. The requested gap rounds
up to `17*k+12` frames; output is the full left archive, gap and right archive.
MotionCache is disabled for bridge requests. The next bridge uses the previous
joined archive as its left input, preserving earlier changes to shared anchors.
Scene ranges keep editing coordinates and duration local to each scene while
preview, timeline playback and export use the latest compatible joined decode,
including audio. Regenerating an anchor invalidates joined playback derived
from its old latents. Original anchor archives are never overwritten.

Windows and Linux bundles include API 1.26 builds with FFmpeg disabled. LAN
protocol 9 transfers both archives and preserves margin/context settings;
update the desktop and worker together. Older local runtimes report an API
requirement when a bridge is requested. Planning tests exercise both bundles
with synthetic latent archives, without running model inference.

## API 1.25: generation sample lifetime

Finished generation cleanup calls `slopfab_generation_release_samples` before
`slopfab_generation_destroy`. Sample release is optional when loading older
runtimes; destruction always runs, including if sample release fails. Cleanup
waits for active native work to stop and excludes sample readers. Slopus saves
continuation latents to project files and does not need to retain the native
handle after consuming its output.

Image finalizers consume the single RGBA frame and destroy its native source
before encoding or writing the image. Video output remains available until
WebCodecs has consumed its frames and audio. Cancelled, failed, evicted and
abandoned results use the same ownership cleanup. Requests are destroyed as
soon as generation starts because Slopfab snapshots them in the start call.

Lifecycle tests use an instrumented C ABI fixture to check release/destruction
order, request and callback lifetimes, repeated runs, failures, cancellation
and the older-runtime fallback. A separate test checks that the bundled
runtime exports the new entry point; these tests do not run model inference.

## API 1.43: saved scene latent upscaling

The Scene Generate dropdown offers **Upscale 1.5x**, **Upscale 2x** and
**Upscale 4x** for the selected Take. Escape or clicking outside dismisses it.
Each action queues `slopfab_latent_upscale_decode_file_start`, saves the enlarged
archive with `slopfab_generation_save_latents`, and encodes the decoded video/audio
with WebCodecs into a new Take. No prompt conditioning or diffusion runs. Canvas
dimensions round to the nearest 32 pixels; audio latents and frame counts stay unchanged.

Download the MiniMax H3 latent upscaler under **Settings > Generators > Other
weights**. The action needs that checkpoint and the video/audio VAEs. Protocol 22
transfers those weights and the saved archive to workers, without transformer,
text encoder, tokenizer or LoRAs. Workers need API 1.43 or later.

Each enlarged Take retains its own archive for further upscaling and an
`originalLatentRelativePath` for continuations and bridges. Making it primary
changes the playable video while keeping the scene's reference latents original.
Joined scene ranges and original archives survive history pruning, cancellation
and errors. The former generation-time Latent upscale toggle is removed; legacy
values remain readable but new scene generation ignores them.

## API 1.22: export upscaling

The bundled Windows and Linux runtimes come from SlopFab commit `d4f423f`,
built with `SLOPFAB_WITH_FFMPEG=OFF`. `slopfab_realesrgan_upscale` exposes
Real-ESRGAN x4plus as a streaming RGB callback API; SeedVR2 uses
`slopfab_seedvr2_upscale`. Models stay loaded for the export. The host retains
the frame count, timestamps, audio, WebCodecs encoder and MP4 muxer.

Image and video exports offer None, Real-ESRGAN and SeedVR2. The chosen export
resolution is the final size: Real-ESRGAN produces 4x frames followed by final
resampling, while SeedVR2 restores frames at the chosen output size. SeedVR2
uses five-frame temporal segments for video and a single frame for images,
and currently requires NVIDIA CUDA. Real-ESRGAN supports CUDA and Vulkan.
Image export preserves the source alpha channel, resized to the output size.

Native upscaling uses bounded input/output queues and raw RGBA IPC. These C
APIs require host pixel buffers, so selecting an upscaler adds GPU readback
and upload during export. None keeps the existing GPU export path; preview
and scrubbing do not run the upscaler. Cancellation releases the stream and
discards partial output. Model access is serialized against local generation.

Settings → Generator → Other weights contains the Real-ESRGAN model and the
SeedVR2 3B INT8 model plus its FP16 VAE. Files use the existing native download
cache and progress/cancellation commands; paths remain machine-local.

## API 1.20: single-pass image outpainting

The restored image Extend template uses the existing API with a 16-pixel
inset on each source edge facing generated space. This frees the VAE boundary
row while keeping the source interior pinned. Canvas edges without new space
are not inset. Slopus tone-matches generated bands using locally smoothed opaque
source seam samples. Corrections follow the finite edges and round their corners,
avoiding the rectangular tone shifts of a whole-edge average. High-contrast
residuals are excluded and corrections bounded to avoid spreading displaced
details into halos. It composites the source with a smoothstep fade over those 16 pixels;
the interior and original alpha remain exact. The prompt is optional and uses
the runtime's `Source scene` context without zoom-out instructions or duplicate
reference pictures. This adapts the edge handling in
[ComfyUI-H3VideoOutpaint](https://github.com/TwoAbove/ComfyUI-H3VideoOutpaint)
to single-image generation, including a positioned keyframe of the pinned
source patches. SlopFab 1.27.1 reuses the source VAE rows at their target spatial
coordinates and time on CUDA and Vulkan. This gives the denoiser a spatial
anchor as well as source latent locking and Qwen visual context, without
resizing a second copy of the scene. Video windowing is not needed for stills.

The drawn box sets the aspect ratio. The selected image resolution and aspect
preset set the pixel budget, rounded down to the 32-pixel grid and bounded by
the maximum generation dimensions. The source scales into that output, so a
larger selection reduces its footprint unless the resolution also increases.
Preparation, preview, generation and final PNG use the same mapped geometry.
The Windows and Linux bundles include SlopFab commit `e3ab3be` (1.27.1) with FFmpeg disabled; update LAN
workers alongside the app. The request format and worker protocol are unchanged.

The bundled Windows and Linux runtimes come from SlopFab commit `b7486be`,
built with `SLOPFAB_WITH_FFMPEG=OFF`. The additive
`slopfab_request_set_image_edit_invert_mask` setter makes an image-edit box
identify the preserved original instead of a region to replace.

Extend sends one inverted mask for the placed source rectangle. CUDA and
Vulkan restore original latent context at every denoising step while generating
the entire surround together. Fully contained 16-pixel latent cells are locked;
unaligned boundary cells can generate the seam. Pixel compositing preserves the
exact original rectangle, and Slopus's PNG finalizer retains its original alpha.
The original crop is also shown to Qwen as `Source scene`, supplying visual
meaning without a second, independently resized DiT reference anchor. User
references retain their picture numbering. Source-dependent prompt embeddings
are recomputed to prevent stale conditioning when the image changes.

This replaces sequential, overlapping border edits, which could rewrite the
source context and leave unrelated borders when the original was pasted back.
Selections with too little original context are rejected before generation.

LAN protocol 3 carries the inverted mask. Older workers must be updated because
they would otherwise ignore inversion and repaint the original rectangle.
An older local runtime reports the required API version; ordinary edits remain
supported. Tests cover inverted latent masks, per-step source preservation,
pixel compositing, request validation, serialization, preview and execution on
both backends, and the older-runtime error.

## API 1.18: refmod export

The bundled runtime comes from SlopFab commit `9d45da8`, built with
`SLOPFAB_WITH_FFMPEG=OFF`. API 1.18 adds `slopfab_export_refmod`, which encodes
a request's raw image, video and audio references into a refmod file using only
the VAEs. API 1.17 added version-5 refmod bundles, which `add_refmod` loads.

Slopus calls the export from the work queue for **Export refmod** in References
(see [refmods](refmods.md)). It reuses the existing reference image paths,
prepared video handles and sound PCM, so video and audio are still decoded with
mp4box.js/WebCodecs. Both backends are supported, locally or through the
worker's `/v1/refmods` route. Older runtimes keep working and report that API
1.18 is needed; an older worker asks to be updated.

Tests cover the missing-media, missing-VAE and older-runtime errors, the worker
round trip against a stub, queue ordering and the References UI. An ignored
test (`SLOPUS_E2E_WEIGHTS`) encodes an image, a clip and a sound with real VAEs
and reloads the resulting bundle; it was run once locally. Generation quality
with exported refmods was not evaluated.

## API 1.16: DMAD

The bundled runtime comes from SlopFab commit `017d2b6`, built with
`SLOPFAB_WITH_FFMPEG=OFF`. The DMAD 4-Step LoRA preset downloads the full-critic
adapter and sends its recipe through `slopfab_request_set_sampling_settings`:
re-noising, video/audio sigma shifts 12/2, and base sigmas `[1, .75, .5, .25, 0]`.
The fixed grid takes precedence over scene and other LoRA step counts, and
Slopus disables MotionCache for this recipe. Preview and execution use the
same settings on CUDA and Vulkan. Older runtimes report that API 1.16 is needed.

The recipe is saved with the machine-local LoRA library, independent of the
downloaded filename. Local imports can select **DMAD 4-Step** under **Sampling
recipe**. Disabled and zero-strength adapters do not select the recipe.
The released adapter needs no companion timestep grid; Slopus checks the
adapter header and skips grid preparation for attention/MLP-only adapters.
The new runtime's preparation API requires its reserved argument to be zero.
For legacy AdaLN adapters, Slopus now handles the optional companion download,
using the same pinned revision, size and SHA-256 as the old runtime, then calls
local-only preparation. Custom grid metadata still requires local assets.

The [DMAD model card](https://huggingface.co/ZhengmingYu/DMAD/blob/main/README.md)
describes training on T2VA at 1344x768, 124 frames and 24 fps. SlopFab also
supports applying it to FL2VA; upstream quality results do not establish quality
for this base-model swap or quantized weights. Slopus preserves the project's
chosen dimensions and duration.

Regression tests cover recipe persistence, download discovery, inactive LoRAs,
fixed-grid precedence, and native preview/execution request construction on both
backends. Release checks probe the download URL without fetching the full file.
Full model inference was not rerun for this integration.

## API 1.14: Extend and Bridge

The bundled runtime now builds from SlopFab commit `103687a` with
`SLOPFAB_WITH_FFMPEG=OFF`. API 1.14 adds
`slopfab_request_set_video_transition`: Extend uses the source video's final
22 frames as a VAE-encoded temporal guide, and Bridge adds the end video's
opening 22 frames after the target timeline. Both return only the new segment.
The existing C ABI structures are unchanged. Older DLLs continue to support
ordinary generation and give a specific upgrade error for these scene types.

Slopus supplies source handles in start/end order, omits unrelated frame
anchors and refmods, and generates audio from the text prompt. Source boundary
encodings use SlopFab's existing media cache. The app still demuxes and decodes
videos with mp4box.js/WebCodecs and encodes/muxes output through WebCodecs.

Validation covers source-boundary selection, temporal guide positions, cache
identity, the C API, Rust planning on CUDA/Vulkan, project persistence, UI
selection, and submitted prompts/payloads. Native core/C API suites, Rust
integration tests, frontend tests and the production build pass. Full model
inference and visual seam quality were not evaluated; the GPU was busy with
another workload. The previous locally modified DLL is preserved under
`.git/runtime-backups/` by its SHA-256 filename.

## API 1.13

Reviewed on 2026-09-20 against Slopfab commit `9b61787` and the local
`lib/slopfab/slopfab.dll`, which reports C API `1.13.0`.

## ABI and runtime

The refactor preserves the existing C function signatures and the layouts of
`slopfab_plan`, `slopfab_progress` and `slopfab_output`. Slopus's Rust bindings,
callbacks, reference handles and output ownership remain compatible.

The new session and JSON sampling/conditioning setters are additive. Slopus
can continue using the default session through its serialized generation
queue. `slopfab_reused_models_clear` still clears that default session when
the queue drains. Explicit session bindings are optional for future cache
isolation; they are not required for this update.

The C API continues to return pixels and PCM. Slopus still uses WebCodecs and
MP4 muxing; no FFmpeg dependency is introduced.

## Integration corrections

- Preview and execution requests now supply the same configured model paths.
  The planner reads SafeTensors metadata for model capabilities, geometry,
  sampling grids and conditioning policy. Omitting the transformer during
  preview could report different steps or accept a request execution rejects.
- Generation progress uses the resolved model evaluation count. A fixed grid
  from model or LoRA metadata can override the scene's explicit step count.
- The planning boundary message acknowledges metadata reads. Planning does
  not execute inference, but it is no longer accurate to say it opens no files.
- DLL integration tests use valid SafeTensors fixtures and the new Animate
  recipe diagnostics. Added coverage verifies model-driven sampling, early
  conditioning rejection and fixed-grid/MotionCache incompatibility on both
  CUDA and Vulkan requests. Missing model files still allow generic planning.

Scene and LoRA step overrides remain explicit requests, so the change to
Slopfab's inherited step defaults does not change Slopus's configured counts.
Slopus also supplies an explicit canvas; the CLI's new canvas defaults do not
change project resolution. Unsupported metadata combinations now surface
during planning instead of being deferred until generation.

## LoRA asset preparation

Inference no longer downloads a missing AdaLN timestep grid or rewrites the
adapter to embed it. This affects adapters that need rebasing onto an H3 table
model and do not already have an embedded grid. Slopus calls C API 1.13's
`slopfab_prepare_lora_grid` after downloading a LoRA
and before saving a newly imported local adapter. The LoRA library's **Prepare**
action handles existing files. Current H3 profiles use grid width 2688.

Downloaded and repaired adapters permit the pinned legacy grid download. Local
imports have a **Download missing timestep grid** checkbox; disabling it uses
local assets only. Preparation may embed the grid in the selected file, using
Slopfab's atomic replacement. Slopus updates its download completion record
with the resulting file size and keeps failed preparations unavailable until
retried successfully. Existing adapters without a preparation status remain
usable and can be prepared explicitly when needed.

The native operation runs on a blocking worker and excludes model readers,
generation and removal while replacing the file. The UI shows a preparation
state instead of a fabricated byte percentage. The synchronous API cannot be
cancelled, so the cancel action is unavailable during preparation. An older DLL
can still load, but attempting preparation reports that API 1.13 is required.

For legacy H3 adapters, place `h3_silu_temb_grid.safetensors` beside the adapter,
or use Slopfab's explicit preparation command before selecting it in Slopus:

```powershell
slopfab.exe prepare-lora --adapter "D:\weights\adapter.safetensors" --width 2688 --download
```

That command explicitly downloads the pinned legacy grid and embeds it in the
adapter. Omit `--download` to use local assets only. Custom `slopfab.lora_grid`
metadata requires its declared local asset and matching identity/width; the
legacy downloader cannot supply arbitrary grids. Already embedded adapters
need no migration. The CLI is an alternative for manual/offline setup; normal
Slopus downloads and imports use the DLL directly.

## Validation limits

Slopus Slopfab integration tests cover the updated DLL, including
planning for both backends, Animate, MotionCache, video reference ownership,
continuation and still images. Preparation tests use small local fixtures to
check embedding, idempotence, missing assets, busy model files, older DLLs and
download-record updates. These tests do not run a full model inference;
CUDA/Vulkan numerical output and render performance were not revalidated here.

## Fibo 2.0 (API 1.34)

The bundled Windows and Linux libraries are updated to Slopfab commit `0a902eb`
(API 1.36.0), built with FFmpeg disabled. LAN protocol 17 requires updated workers.

The `fibo2` model uses the Edit Turbo transformer, Qwen3-VL 4B text encoder and
Flux2 VAE. The tokenizer is embedded, and no audio VAE is needed. The generator
uses CUDA with Flash attention and four steps by default.

Generate from text alone, use a source image with whole-image, box or lasso
edits, or cite up to four image references in a prompt. Source edits pass the source only through the
image-edit API, without duplicating it as a reference. Plain instructions and
optional structured edit JSON pass through without H3 prompt sections. Lasso
outlines use the same native masks as H3, including compound contours.

Shared model capabilities disable video, extra references
on source edits, character sheets, LoRAs/refmods, MotionCache, CFG, LCS and
H3 sampling overrides. Native request validation enforces the same constraints
for local and LAN jobs.

Validation includes native whole-image/mask planning on both bundled libraries
and a Windows CUDA four-step masked generation with the real Fibo weights,
checking finite RGB output, exact unselected pixels and cancellation.

The Linux build needs to retain Fibo's `render_text` object from the generation
archive, which is referenced by the CUDA archive later in the link. This bundle
was relinked with `-Wl,-z,defs` and
`-Wl,-u,_ZN7slopfab4fibo11render_textERKNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEE`.
Without that retention, the upstream static archive order leaves an unresolved
symbol in the shared library. Linux plain instructions work; optional structured
`text_render` glyph images still require Windows in this Slopfab version.

## Negative prompts

The image root stores `negativePrompts` by model ID. MOSS sends the selected
text with CFG through `slopfab_request_set_image_guidance`; CFG 1 bypasses the
negative branch. Drafts and generation snapshots retain the authored text.
Worker protocol 15 prevents older workers from silently discarding it.

The shared catalog's `negativePrompt` flag enables authoring and generation.
An optional `negativePromptDisabledReason` displays a disabled field with help;
Fibo Turbo uses this because it has no negative prediction branch. H3 hides the
field. Requests with nonempty negative prompts for unsupported models are
rejected at the native boundary.

Fibo text-to-image is enabled in Slopus and the bundled runtime. The runtime
accepts zero reference images, formats image-free prompts as valid JSON and
skips vision feature injection when there are no image tokens. Verification
includes a real Windows CUDA four-step text-only generation, finite RGB output,
cancellation, and Linux text-only planning. LAN protocol 16 requires workers
with the same source-free Fibo support.

## Fibo Base and Zoom

The Fibo 2.0 Base template uses `fibo2_dev_int8_convrot.safetensors` with the same
Qwen3-VL encoder and Flux2 VAE as Edit Turbo. The per-template `editingModel`
setting defaults off for Base and MOSS and on for Edit Turbo. Legacy templates
inherit their model family's editing capability. Settings, portable `.slop`
files, agent commands and generation requests preserve this flag; both the UI
and native validation prevent editing when it is off. Family capabilities still
limit unsupported operations, including MOSS editing.

Fibo Edit Turbo Zoom generates borders using an explicit even-odd mask: the
output canvas minus the preserved source rectangle. It uses plain Fibo prompts,
without H3 inverted-mask conditioning, Langevin controls or duplicate image
references. Crop-only Zoom uses whole-image refinement at strength 0.65.
The existing runtime (API 1.36.0) supports these masks without a library update.
LAN protocol 17 enforces template editing capabilities on workers.

Validation covers migration, sharing, editing controls, queued requests and
native planning, plus a real four-step CUDA border-mask generation that checks
finite output, exact preserved center pixels and cancellation.
