# Slopus — Unreleased

Changes since 0.3.2.

## What's new

- **Sampler and scheduler controls.** Generator templates offer compatible sampling choices, including ER-SDE and Beta. Model default preserves existing recipes; choices are saved, shared in template exports and sent to workers.

- **Krea 2 images.** Added Turbo and Raw generators with CFG, negative prompts and image sigma shift controls. Turbo defaults to 8 steps; Raw uses 52 steps, CFG 3.5 and a resolution-dependent shift. Both generate new images without editing or image references, on updated CUDA and Vulkan runtimes.

- **MiniMax Music3 precision.** Added FP16 transformer downloads for GPUs with at least 5 GB VRAM and FP32 for at least 10 GB, alongside the 3 GB INT8 variant.

- **Download memory warnings.** MiniMax generators and shared weights now have minimum VRAM limits. Downloads warn when no variant of a needed weight fits the detected GPU, with Cancel and Download anyway options. Existing downloads and custom limits are preserved.

- **Single Shot continuity.** With Context video, use the Clown Context overlap recipe: hold the first 22 frames of Previous video's 39-frame tail, regenerate the final 17, and replace the overlap in joined video and audio. Keystone and Capstone remain sampling context; original source files stay intact. Requires updated workers.

- **LoRA controls.** Enable MiniMax H3 LoRAs globally, drag the library to set application order, and add scene overrides in Generation. Global adapters remain active and appear read only in scenes. Step counts and sampling recipes follow the effective stack, with conflicting recipes blocked.

- **Generation previews.** MiniMax H3 video previews autoplay and loop inside shot cards with the usual play/pause and pop-out controls. Low-resolution image previews update the image canvas and thumbnail during generation. Download TAEH3 from Other weights and enable generation previews in Settings; previews work locally or on updated workers, while final output uses the generator's selected VAE.

- **Pika H3 Flex.** Added FL2VA and Ref2VA LoRA downloads with Pika's fixed six-step re-noising recipe and video/audio sigma shifts of 12/3.

- **MiniMax H3 dependencies.** Added named Video and Audio VAE templates, including Sol H3 VAE, and a shared default Text Encoder. Generators link to VAEs and automatically download missing dependencies; existing custom paths and downloads are preserved.

- **Scene upscaling.** Generate's dropdown offers 1.5x, 2x and 4x latent upscaling as new Takes. Upscaled Takes can be enlarged again; scene references always use original latents.

- **Video library.** Organize Videos → Scenes → Shots in folders, play scenes sequentially on cards or in a popout, and apply shared prompts and timed music/video references. Split a complete song into scenes; timeline clips remain individual scenes.
- **Music export.** Preview and export WAV, MP3, lossless FLAC, AAC/M4A or Opus/WebM/Ogg, with bitrate controls and background export. MP3/FLAC use bundled Mediabunny encoders.
- **Single Shot.** Select the sequence's first video as Context video and continue from Previous video using its original latent anchors, with capstone locking after up to four video updates. Short LoRA schedules automatically use an earlier lock without changing their sampling recipe. Without context, generate a short ending first and anchor the full shot to it.
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

- Local image edits on larger originals use the selected resolution as the maximum rectangle or lasso size. Each crop is merged back into the original-sized image, preserving pixels outside the selected area. Requires updated workers.
- Krea 2 and other generators without LoRA support no longer inherit adapters from the default generator when their own adapter list is omitted.
- Single Shot without Context video applies Tone once across the assembled main clip and ending, avoiding separate grading of its temporary ending. Retained Previous video frames are preserved. Requires updated workers.
- Shot speech language keeps the existing choices and also accepts custom language names.
- Empty shot cards use their Video's resolution and aspect ratio while waiting for a preview or generated video.
- Non-primary scene takes can be removed during generation without interrupting the running job.
- Videos can override project Look, aspect ratio and resolution; scenes inherit their Video's settings.
- First & Last Frame prompts follow MiniMax's I2VA, L2VA and FL2VA formats, with ending anchors timed to the final shot.
- Fixed AppImage launcher permissions for users other than the package builder.

- Retired Long Shot from scene choices; use Bridge to connect videos. Existing Long Shot scenes remain compatible.

- Video cards match Shot sizing and show the opening playback frame. Click to select settings; double-click or choose Edit Scenes to open scenes. Playback shares Timeline's prepared players, and returning to Video restores the open video.
- Video card and popout playback preserve full rendered scene ranges and keep decoders running through background updates.
- Application Back returns from scenes to Video and from image versions to their parent bar.
- The mouse Back button follows the global Back action, including Settings and nested views.
- Editing generated music creates a separate draft; cards distinguish drafts from playable songs.
- Single Shot uses previous latents only as its starting anchor, fresh noise for the middle and a generated ending anchor, avoiding repeated source imagery.
- Dependent scenes can queue behind active sources; cancelling any linked generation cancels the whole pending group.
- Updated First/Last Frame Fast to the eight-step FastH3 Omni model and corrected Omni and First/Last Frame weight fallbacks.
- Image edits preserve source images, prompts and settings; queued results get separate entries, and whole-image edits disable feathering.
- Imported images now expose steps, seed and resolution; new images use generator step defaults, and renamed image roots retain their names.
- Generation effects reuse VAE fingerprint checks across app and worker restarts, avoiding repeated reads of unchanged VAE files while still detecting edits and replacements.
- Updated SlopFab to API 1.40 with music performance improvements; LAN protocol 19. Update workers alongside the app.
