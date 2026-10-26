# Slopus — Unreleased

Changes since 0.3.2.

## What's new

- **Single Shot.** Generate a short ending first, then anchor a continuous shot to it. Supports references in both prompts and optional continuation from any generated scene.
- **Music.** YuE2 and MiniMax Music3 generation with folders, drag-and-drop organization, grid/list views, background playback, references and timeline audio. Playback appears in the Music tab and pauses when Timeline, Video or Export playback starts. YuE2 selects BF16 above 8 GiB VRAM, otherwise INT8.
- **Motions.** Create JavaScript animations with the agent, edit elements and parameters, and export them on the timeline or as reference videos.
- **Scene history.** Keep up to four takes and an editable Draft, restore take settings, choose the primary timeline video, and duplicate scenes.
- **Agent frame inspection.** Agents can view timeline frames, scenes, takes, references, generated images and Motions at a requested time.
- **Agent music tools.** Generate songs, retrieve lyrics and settings, estimate tempo and energy, and sync Motions to music or trimmed audio clips.
- **MOSS Image.** Generate images on CUDA with per-model CFG and negative prompts.
- **Fibo 2.0.** Added Base and Edit Turbo generators for CUDA, with text-to-image generation, image references, local edits and Zoom where supported.
- **Lasso edits.** Draw and move freehand selections; use Ctrl to combine areas or Alt to subtract them.
- **Image batches.** Queue up to 100 images with different seeds from the Generate dropdown.
- **Generation effects.** Added LCS color steering, tone, sharpness and color stabilization, with step ranges and optional regions on supported models.
- **Generator controls.** Group generators and LoRAs by model, group generator dropdown choices, and enable editing per template.
- **Inspector controls.** Added sliders and editable values with consistent widths and practical ranges (up to 100 steps), plus compact, centered action buttons.

## Fixes and improvements

- Updated First/Last Frame Fast to the eight-step FastH3 Omni model and corrected Omni and First/Last Frame weight fallbacks.
- Image edits preserve source images, prompts and settings; queued results get separate entries, and whole-image edits disable feathering.
- Imported images now expose steps, seed and resolution; new images use generator step defaults, and renamed image roots retain their names.
- Generation effects reuse VAE fingerprint checks to avoid repeated calibration work.
- Updated SlopFab to API 1.40 with music performance improvements; LAN protocol 19. Update workers alongside the app.
