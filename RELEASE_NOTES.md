# Slopus 0.3.1

This alpha update adds Long Shot and Backdrop scenes, export upscaling, clip speed controls and latent upscaling, alongside improvements to generation, playback and memory use.

## What's new

- Image and video export now offer 1280 × 1280, 2276 × 1280, 1280 × 2276 and 1280 × 1600 presets for the supported aspect ratios.
- New image scenes default to None style mode, which adds no style instructions to the generated prompt.
- Generation diagnostics now separate VAE model opening, weight loading, decoding and cleanup times to help identify intermittent image-generation slowdowns.
- Added Long Shot scenes: generate alternating fresh clips and latent bridges in 1 → 3 → 2 → 5 → 4 order. Bridge controls set how much of the neighboring ending and beginning may change, with joined video and audio used in preview and export. Includes updated Windows/Linux runtimes and LAN worker support; update workers alongside the app.
- Video and image generation headers now show the effective step count from the selected generator's active LoRAs, including fixed sampling schedules.
- Added Backdrop scenes to generate subjects and action against a selected green, blue, black or white background. Chroma Key now offers matching backdrop modes and automatic border detection, with matte levels, background color removal, despill, shadow removal, edge softness, choke/grow and small-speck/hole cleanup in GPU preview and export.
- Timeline clips now offer Speed in Timing, from 25% to 400%. Speed changes preserve the source range, adjust duration and later clips on the same track, and apply to preview and export, including audio pitch.
- Open the agent from the Settings top bar in a resizable right-side panel to configure generators, weight paths and LoRAs, even without an open project.
- Scene Generation settings now offer Latent upscale: generate at half resolution and upscale to the selected output size, locally or on a LAN worker. Download its model or choose a local file in Other weights settings.

## Fixes and improvements

- Generate all now includes the final scene in an even-length Long Shot sequence, continuing from the preceding scene and preserving earlier joined video and audio.
- Long Shot timeline playback keeps the same video player running across adjacent scenes in a joined generation, avoiding a playback restart at bridge boundaries.
- Reduced memory retained between generations: release Slopfab samples and handles after consumption, discard completed queue snapshots, close encoders on errors, and clean up abandoned LAN generation results.
- Inspector instructions now appear as tooltips on field labels, keeping the right-side panels compact.
- Scene generation prompts now mark shot times as `[Shot 2] At 00:03.500,`.
- Still-image resolution and aspect ratio are saved separately from video project settings. Editing or selecting an image no longer changes the canvas used for video generation and continuation.
- Zoom the timeline video preview up to 400% with the zoom menu, buttons, or Ctrl+wheel, and scroll to inspect details. Choose Fit to see the whole frame again.
- Video scenes offer a separate audio step count. Audio follows the video step count by default, with optional overrides for local and worker generation.
- Character Sheet lets you enable Close up, Front view, Side view and Back view independently. Side view is off by default; generation and the combined image include only enabled views.
- Real-ESRGAN and SeedVR2 weights support local file paths in Other weights settings. When using a worker, SeedVR2 sends selected local files and downloads any missing components there.
- Scene continuation offers a Lock Overlap toggle for local and worker generation, constraining overlapping video and audio to the source scene.
- Image and video exports share a work queue with progress, cancellation, and retained results. SeedVR2 upscaling runs locally when Local is selected, or on the selected CUDA worker, which prepares its own models.
- Upscaler downloads share the generator and LoRA download queue, with progress in Work Queue and cancellation for waiting downloads.
- Work queue activity indicators keep moving in the top bar and open queue when Windows interface animations are disabled.
- Image and video export offer None, Real-ESRGAN and SeedVR2 upscaling through SlopFab. Download their models from the new Other weights section in Settings → Generator.
- Image export offers sizes closest to the selected image's actual aspect ratio, even when project or saved generation settings differ.
- The agent input clears after sending a message.
