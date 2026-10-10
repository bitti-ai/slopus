# Slopfab compatibility

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
are not inset. Slopus tone-matches generated bands using opaque source seam
samples and composites the source with a smoothstep fade over those 16 pixels;
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
