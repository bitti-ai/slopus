# Slopus 0.3.2

This alpha update adds Prompt video scenes, agent image drafts, Sol attention and sigma shift controls, and improves Zoom image editing, agent chat and generation reliability.

## What's new

- **Image negative prompts.** MOSS exposes a Negative prompt field below the image root prompt, saved per model with drafts and generated images and applied during local or LAN generation. Fibo Turbo shows the field disabled because its single positive prediction does not support negative prompts. Visibility and support are controlled by model settings. Update LAN workers to protocol 15.

- **Fibo 2.0 image editing.** Added an Edit Turbo generator with transformer, Qwen3-VL encoder and Flux2 VAE downloads. Use whole-image, box or lasso edits, or cite up to four images in a new image prompt. Defaults to four steps on CUDA; unsupported video and H3-only controls are disabled.

- **Lasso image edits.** Draw a freehand area beside the existing box tool, give it a prompt in the right panel, and select or move it from the canvas or Scene tree. Saved outlines become antialiased Slopfab masks for local and LAN generation, preserving pixels outside the selection. Bundled runtimes now use API 1.34; LAN workers require the matching update.

- **FastH3 Omni.** Renamed First/Last Frame Fast and updated its transformer to the FastH3 Omni eight-step model. Existing bundled settings migrate automatically.

- **Generator model pages.** Open MiniMax H3, MOSS, Fibo 2.0 or Other from Generator settings. Each model has its own generators and LoRAs; Other contains the existing extra weights. New generators use the selected model.

- **Image generation count.** Open the arrow beside Generate to queue up to 100 images with different seeds. Count applies to one click, resets afterward and is not saved in the project.

- **Generation effects.** Add LCS color steering, tone, sharpness and color stabilization from the video Scene or image root inspector. Effects run during generation, with bypass, reset, step ranges and optional regions. VAE calibration is automatic, cached and cancellable. MOSS disables these controls through the shared model capabilities.

- **MOSS CFG control.** Set CFG before Seed in the image inspector, with a default of 3. Values are remembered per model in each image draft and carried into local and LAN generation. H3 hides the control.
- **MOSS image generation.** Generator settings group templates by model and include MOSS Image with its model weights and tokenizer downloads. MOSS is available for new images on CUDA; video, image editing, Zoom, and reference-based character sheets are disabled through shared model capabilities.
- **Prompt video scenes.** New ordinary video scenes default to Prompt, with text and reference guidance but no start- or last-frame selectors. First & last frame remains available for frame conditioning.
- **Agent image drafts and generation.** Ask the agent to prepare multiple images in the image bar for later, edit a selected draft, or generate it with a chosen generator. Preparation is saved before rendering, and the agent resumes after generation with the saved result.
- **Sol attention in Settings.** Choose Sol attention under a generator's Performance settings for generation on CUDA GPUs. The selection is saved per generator and included in shared generator files.
- **Zoom image template (formerly Extend).** Restored image extension with an optional prompt and output sized to the drawn box's aspect ratio and selected pixel budget. Boxes inside the source regenerate the selected crop with refined detail at the target resolution. Positioned source conditioning, native refinement and edge blending improve the generated surroundings.
- **Video and audio sigma shifts.** Set separate shifts for video and audio, define generator template defaults, and configure per-stream LoRA overrides. Local and LAN worker generation use the same settings. Sigma shifts and the existing audio step override are grouped under Advanced options at the bottom of Generation in the right panel.

## Fixes and improvements

- Renamed the Generator settings section to Generators. Refined the lasso icon and integrated the image Generate arrow into one split control. Count help now appears on the label tooltip. Model capabilities disable Object, Text, Group and Background creation for MiniMax H3 while keeping them available for MOSS and Fibo; existing image edits retain Edit Box and Lasso.

- First/Last Frame now uses Winnougan's FL2VA W4A8 fallback. Saved fallback selections migrate to the correct model; References retains its REF2VA fallback.

- FastH3 Omni always downloads its Omni transformer. Removed its inherited W4A8 fallback and migrate saved selections to Omni, reusing an existing Omni download when available.

- Renamed Draw edit to Edit Box with a box icon. Hold Ctrl when releasing a lasso stroke to combine overlapping areas, or Alt to subtract. Cursor indicators show the active operation; holes and split areas persist in saved projects and generation masks.

- Lasso selections can be moved but not scaled. Image edits keep the source visible during generation and display the edited result when complete.

- Generation effects reuse VAE fingerprints between jobs, removing repeated full-file calibration checks for unchanged VAEs. Changed or replaced VAEs are verified again; saved calibrations remain reusable after restarting.

- Renamed image roots on the still image creation page now retain their names when switching images and reopening projects.
- Image edits keep their prompts and settings separate from the original. Child results open as normal images ready for further edits; selecting images does not create editing copies.
- Image generation immediately selects a separate empty entry showing Queued or Generating. Progress stays on that entry, and the result replaces it when ready.
- Whole-image edits disable feathering at the native generation boundary, including requests with missing or previously saved feather settings.
- Imported still images now have steps, seed and resolution controls. Resolution defaults to the source dimensions rounded down to multiples of 32, with additional sizes matching the source aspect ratio.
- Fixed CUDA transformer-loading memory failures with bounded upload buffers, more accurate memory budgeting and automatic retries with more CPU offloading, while preserving precision and output settings.
- Agent chat retains earlier replies, corrections and errors throughout the conversation. Raw JSON and command payloads stay hidden; readable replies and summaries are shown.
- Zoom reduces visible extension seams by preventing grey canvas padding from affecting source encoding and widening the edge blend. Small source areas retain an unblended interior, and source transparency is retained.
- Backdrop prompts describe a flat, constant color field in every shot, limit reference guidance to subject appearance, and use neutral studio styling when no look is specified.
- Scene type label tooltips now explain each scene type's behavior.
- Renamed Add reference to Reference browser and centered the agent send and stop buttons.
- Updated the bundled Windows and Linux SlopFab runtimes to API 1.34 for Fibo, MOSS, native LCS and image masks. LAN worker protocol 14 carries Fibo image-only model configuration; update workers alongside the app.
