# Slopus 0.2.1

This alpha update adds DMAD LoRA support, resumable model downloads, and improvements to image generation, reference prompts, and the image bar.

## What's new

- Clothes and Accessories reference categories include common wearable items. Clothes offer optional color and fabric settings.
- Video references now offer a Frames mode: select still frames from a clip and use them as image references.
- Interrupted weight and LoRA downloads retain their progress and can resume on retry, including after reopening the app.
- Reference smart chips in image prompts and video shot descriptions, with reference artwork in the picker.
- Queue still-image generation for individual images. Regenerated and edited images are grouped under their original in the image bar.
- Generated still images retain their used seed, shown as a read-only field with a copy button in Image generation.
- Higher image and video generation resolutions, plus standard image and video export sizes.
- Downloadable DMAD 4-Step LoRA for MiniMax H3, with its re-noising sampling recipe applied automatically. Its fixed four-step schedule overrides step counts and turns off MotionCache.
- Bundled release notes appear once per app version.
- LAN workers: run the Slopus worker package on another Windows or Linux computer and pick it in the new **Settings → Workers** tab to generate there. Slopus finds workers on the local network automatically, or by address. Workers download generator weights from their download links themselves and use CUDA when available, with a Vulkan fallback; local-only files are sent from this computer, and finished videos, images and latents are saved in your project as usual.

## Fixes and improvements

- Portable builds show available updates and open GitHub releases for manual updating instead of running an installer.

- Simplified image edits and added references for individual edits. Still-image generation receives only the references mentioned in its prompt, with clear image and RefMod identifiers.
- Removed box coordinates and palettes from image prompts, and limited image controls to supported generator model types.
- Improved image family deletion so removing a variant preserves its original. Selected image boxes can also be deleted from the canvas.
- Long prompts scroll inside their fields. Smart chips align with surrounding text and no longer overlap on adjacent lines.
- Moved the Add reference scrollbar clear of reference cards, and made the image bar scrollbar appear while scrolling.
- Agent-generated shots use full language names, such as English.
- Removed the opening-frame helper caption and made the release-note introduction render as normal text.
- Updated the bundled SlopFab runtime to API 1.16 and adapted LoRA preparation to preserve companion-grid downloads for older adapters.
