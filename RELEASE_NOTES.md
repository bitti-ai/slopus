# Slopus 0.3.1

This alpha update adds SeedVR2 and Real-ESRGAN export upscaling, Long Shot and Backdrop scenes, latent upscaling, clip speed controls, and a Settings agent, alongside improvements to generation, playback and memory use.

## What's new

- **Extend image template restored.** Draw or resize the output box, choose a generation resolution, and optionally describe the new surroundings. Output follows the box's aspect ratio and selected pixel budget, resizing the source to fit. Positioned source conditioning keeps the scene anchored, while generated edges blend into the original with seam tone matching.
- **SeedVR2 upscaling for images and videos.** Restore exports at the selected output size using SeedVR2 3B FP16 and its VAE. Run on the local NVIDIA CUDA GPU or a selected CUDA LAN worker. Workers download missing standard weights or receive your selected local weight files.
- **Real-ESRGAN upscaling for images and videos.** Use RealESRGAN x4plus during export, with the result resized to your chosen output dimensions. CUDA and Vulkan are supported. Choose None to export without an upscaler.
- **Other weights settings.** Settings → Generator now includes downloads and optional local file paths for Real-ESRGAN, SeedVR2 and the MiniMax H3 latent upscaler. Upscaler downloads share the generator and LoRA download queue, with progress and cancellation in Work Queue.
- **Queued image and video exports.** Exports share a work queue with progress, cancellation and retained results, including exports using SeedVR2 on a worker.
- **Long Shot scenes.** Generate alternating fresh clips and latent bridges in 1 → 3 → 2 → 5 → 4 order. Bridge controls set how much of the previous ending and following beginning may change. Preview, playback and export use joined video and audio, and later bridges preserve earlier changes. Local and LAN worker generation are supported.
- **Backdrop scenes.** Generate subjects and action against a selected green, blue, black or white background.
- **Expanded Chroma Key.** Matching backdrop modes and automatic border detection add screen gain/balance, matte levels, background color removal, despill, shadow removal, edge softness, choke/grow and small-speck/hole cleanup in GPU preview and export.
- **Latent upscale for scene generation.** Generate at half resolution and upscale to the selected output size, locally or on a LAN worker. The toggle appears below Seed in Scene Generation settings, and its model is available in Other weights.
- **Clip speed controls.** Timeline clips now offer Speed in Timing, from 25% to 400%. Changes preserve the source range, adjust duration and later clips on the same track, and apply to preview and export, including audio pitch.
- **Timeline preview zoom.** Zoom up to 400% using the zoom menu, buttons or Ctrl+wheel, and scroll to inspect details. Choose Fit to see the whole frame again.
- **Agent in Settings.** Open a resizable agent panel from the Settings top bar to configure generators, weight paths and LoRAs, even without an open project.
- **Video and audio sigma shifts.** Set shifts and a separate audio step count under Advanced options at the bottom of Generation in the right panel, define generator template defaults, and configure per-stream LoRA overrides. Local and LAN worker generation use the same settings.
- **Separate audio generation steps.** Audio follows the video step count by default, with optional overrides for local and worker generation.
- **Continuation overlap locking.** Continue scenes offer Lock Overlap for local and worker generation, constraining overlapping video and audio to the source scene.
- **Selectable character sheet views.** Enable Close up, Front view, Side view and Back view independently. Side view is off by default; generation, combined images and debug prompts include only enabled views. When enabled, the front view provides a shared clothing reference for the other views.
- **1280 export presets.** Image and video export now offer 1280 × 1280, 2276 × 1280, 1280 × 2276 and 1280 × 1600 presets for the supported aspect ratios.

## Fixes and improvements

- Extend blends color locally along each edge and smoothly around corners, reducing visible rectangular transitions without spreading high-contrast details into halos.
- Generate all includes the final scene in an even-length Long Shot sequence, continuing from the preceding scene and preserving earlier joined video and audio. Four scenes generate in 1 → 3 → 2 → 4 order; adding another scene turns the final continuation into a bridge on its next generation.
- Long Shot timeline playback keeps the same video player running across adjacent scenes in a joined generation, avoiding a playback restart at bridge boundaries.
- Reduced memory retained between generations by releasing consumed SlopFab samples and handles, completed queue snapshots, encoder buffers on errors, and abandoned LAN generation results.
- Still-image resolution and aspect ratio are saved separately from video project settings. Editing or selecting an image no longer changes the canvas used for video generation and continuation.
- Image export offers sizes closest to the selected image's actual aspect ratio, even when project or saved generation settings differ.
- New image scenes default to None style mode, which adds no style instructions to the generated prompt.
- Video and image generation headers show the effective step count from the selected generator's active LoRAs, including fixed sampling schedules.
- Scene generation prompts mark shot times as `[Shot 2] At 00:03.500,`.
- Generation diagnostics separate VAE model opening, weight loading, decoding and cleanup times to help identify intermittent image-generation slowdowns.
- Inspector instructions appear as tooltips on field labels, and Generator and References toolbars align with their inspector headers.
- Renamed the continuation source edge Beginning to Start.
- The agent input clears after sending a message.
- Work queue activity indicators keep moving when Windows interface animations are disabled, and download labels are shorter.
- Updated the bundled Windows and Linux SlopFab runtimes for the new generation and upscaling features and decode diagnostics. Update LAN workers alongside the app.
