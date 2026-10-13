# Slopus 0.3.2

This alpha update adds Prompt video scenes, agent image drafts, Sol attention and sigma shift controls, and improves Zoom image editing, agent chat and generation reliability.

## What's new

- **Prompt video scenes.** New ordinary video scenes default to Prompt, with text and reference guidance but no start- or last-frame selectors. First & last frame remains available for frame conditioning.
- **Agent image drafts and generation.** Ask the agent to prepare multiple images in the image bar for later, edit a selected draft, or generate it with a chosen generator. Preparation is saved before rendering, and the agent resumes after generation with the saved result.
- **Sol attention in Settings.** Choose Sol attention under a generator's Performance settings for generation on CUDA GPUs. The selection is saved per generator and included in shared generator files.
- **Zoom image template (formerly Extend).** Restored image extension with an optional prompt and output sized to the drawn box's aspect ratio and selected pixel budget. Boxes inside the source regenerate the selected crop with refined detail at the target resolution. Positioned source conditioning, native refinement and edge blending improve the generated surroundings.
- **Video and audio sigma shifts.** Set separate shifts for video and audio, define generator template defaults, and configure per-stream LoRA overrides. Local and LAN worker generation use the same settings. Sigma shifts and the existing audio step override are grouped under Advanced options at the bottom of Generation in the right panel.

## Fixes and improvements

- Whole-image edits now reach every edge without feathering.
- Imported still images now have steps, seed and resolution controls. Resolution defaults to the source dimensions rounded down to multiples of 32, with additional sizes matching the source aspect ratio.
- Fixed CUDA transformer-loading memory failures with bounded upload buffers, more accurate memory budgeting and automatic retries with more CPU offloading, while preserving precision and output settings.
- Agent chat retains earlier replies, corrections and errors throughout the conversation. Raw JSON and command payloads stay hidden; readable replies and summaries are shown.
- Zoom reduces visible extension seams by preventing grey canvas padding from affecting source encoding and widening the edge blend. Small source areas retain an unblended interior, and source transparency is retained.
- Backdrop prompts describe a flat, constant color field in every shot, limit reference guidance to subject appearance, and use neutral studio styling when no look is specified.
- Scene type label tooltips now explain each scene type's behavior.
- Renamed Add reference to Reference browser and centered the agent send and stop buttons.
- Updated the bundled Windows and Linux SlopFab runtimes to 1.28.2 for Zoom refinement, seam fixes and transformer-loading memory recovery. Update LAN workers alongside the app.
