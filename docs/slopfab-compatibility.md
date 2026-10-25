# Slopfab compatibility

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
LCS color steering, tone, experimental sharpness, and self/smooth color
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

LAN worker protocol 11 carries the portable controls and prevents older
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

## MOSS image generation (API 1.30+)

The bundled Windows and Linux libraries expose SlopFab API 1.38.0, including
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

## API 1.26: Long Shot latent bridges

Consecutive **Long Shot** scenes alternate fresh anchors and bridges. Generate
all queues 1, 3, 2, 5, 4, 7, 6. A bridge requires completed neighbors with saved
latents. With an even number of scenes, the final scene continues from the
previous anchor using the latest compatible joined archive. Four scenes run
in 1, 3, 2, 4 order. Adding a following Long Shot scene turns that continuation
into a bridge on its next generation.
The two margin controls replace the previous anchor's ending and the following
anchor's beginning in multiples of 17 frames (default 17, zero allowed).
Each anchor must also provide 22 preserved context frames. Use the same canvas,
VAE models and latent upscale setting throughout the run. Cite original subject
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

## API 1.24: scene latent upscaling

Scene Generation settings offer an optional **Latent upscale** toggle. Slopus
passes a half-size diffusion canvas (rounded up to complete 32-pixel patches)
and calls `slopfab_request_set_latent_upscaler` with scale 2 and temporal chunking.
Slopfab upscales the video latents before VAE decoding on CUDA or Vulkan; audio
and frame counts are unchanged. WebCodecs encodes to the exact selected output
size when patch alignment makes the decoded frames slightly larger. Planning
reports the selected output size while latent dimensions describe diffusion.

The MiniMax H3 3D conv v1 FP16 checkpoint is downloadable under
Settings > Generator > Other weights > Latent upscale, with an optional local
file override. Weights remain machine-local. LAN protocol 8 transfers local
files or has the worker download the standard checkpoint; older workers must
be updated so they cannot silently ignore the toggle. Older runtimes reject
an enabled toggle with an API 1.24 requirement; disabled scenes remain supported.

Saved latents retain the diffusion resolution. Continuations must use a source
archive with matching diffusion dimensions, so use the same upscale setting
and project resolution throughout a continuation chain. The toggle is captured
in generation history and in queued requests. Progress identifies the latent
upscaling stage, and existing cancellation and WebCodecs/MP4 saving apply.

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
