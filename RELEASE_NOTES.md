# Slopus 0.2.1

This alpha update adds DMAD LoRA support, resumable model downloads, and improvements to image generation, reference prompts, and the image bar.

## What's new

- First and last scene frames use the searchable reference picker with image thumbnails. Reference selectors and prompt chips share configurable filters for images, audio, video, text, and RefMods.
- Configure a character sheet from the Image toolbar's Template menu, with reference-enabled prompts for clothing and other details and a resolution selection controlling sheet height (512–2048 px), then select Execute. A square portrait and three 9:16 full-body views are combined into one child image in the image bar. The front view provides a shared clothing reference for the other views.
- Continue scenes from a selected scene's saved latents, with adjustable overlap and a choice of beginning or end. This replaces Previous scene in First & last frame.
- Export any reference with images, a video or a sound as a refmod `.safetensors` file from References. Exported refmods can be attached to other references and projects.
- Copying or cutting prompts preserves reference chips when pasted into other prompt fields.
- Choose Make Primary on an image version to show it in the main image bar and use it when creating scenes or references from that family.
- Images imported through Timeline or References, including selected video reference frames, appear in the image bar and open for editing.
- Duplicate references from their context menu, including multiple selected references with their prompts, attachments, and media settings.
- Create a video scene with an image as its first frame, or create an image reference, directly from the Image tab's image bar context menu.
- Every project now includes Video and Image tabs. Older video and image projects keep their saved content, and Export supports both output types.
- Clothes and Accessories reference categories include common wearable items. Clothes offer optional color and fabric settings.
- Video references now offer a Frames mode: select still frames from a clip and use them as image references.
- Interrupted weight and LoRA downloads retain their progress and can resume on retry, including after reopening the app.
- Reference smart chips in image prompts and video shot descriptions, with reference artwork in the picker.
- Queue still-image generation for individual images. Regenerated and edited images are grouped under their original in the image bar.
- Generated still images retain their used seed, shown as a read-only field with a copy button in Image generation.
- Higher image and video generation resolutions, plus standard image and video export sizes.
- Downloadable DMAD 4-Step LoRA for MiniMax H3, with its re-noising sampling recipe applied automatically. Its fixed four-step schedule overrides step counts and turns off MotionCache.
- Sound references: add an MP3, M4A, WAV, FLAC or Ogg file to a reference, choose a 2 to 15 second range, and cite it in a shot as `<Audio N>`, for example as a voice timbre. Sound references need a Ref2VA generator and an image or video reference in the same scene, and also work on LAN workers.
- Bundled release notes appear once per app version.
- Slopus for Linux (x86_64): install the .deb or .rpm package, or run the AppImage, which updates itself. Local generation on Linux needs an NVIDIA GPU with CUDA 13.
- LAN workers: run the Slopus worker package on another Windows or Linux computer and pick it in the new **Settings → Workers** tab to generate there. Slopus finds workers on the local network automatically, or by address. Workers download generator weights from their download links themselves and use CUDA when available, with a Vulkan fallback; local-only files are sent from this computer, and finished videos, images and latents are saved in your project as usual.

## Fixes and improvements

- Colour correction includes a Brightness control for preview and export.
- Continue preserves the full joined video and audio from Slopfab. Adjacent source and continuation scenes use that shared decode in preview and export, preserving context across the cut. Regenerate older Continue scenes to apply the fix.
- The timeline playhead follows playback without waiting for editor updates.
- Copy and paste effect settings between matching effects from their **…** menus, including bypass state and LUT data.
- Add voice reference chips directly in a shot's Speech field. Voice guidance stays separate from the words spoken.
- Removing a reference from a scene's last prompt citation now removes it from generation inputs and “Used by.” References selected as frame or motion inputs remain active.
- Reference chips now highlight when included in a prompt's text selection.
- The Video scene list scrollbar stays clear of Generate and Cancel, while scene header backgrounds extend to the edge.
- Timeline media thumbnails stay inside their preview area, keeping filenames clear in grid and list layouts.
- Portable builds show available updates and open GitHub releases for manual updating instead of running an installer.

- Simplified image edits and added references for individual edits. Still-image generation receives only the references mentioned in its prompt, with clear image and RefMod identifiers.
- Removed box coordinates and palettes from image prompts, and limited image controls to supported generator model types.
- Improved image family deletion so removing a variant preserves its original. Selected image boxes can also be deleted from the canvas.
- Long prompts scroll inside their fields. Smart chips align with surrounding text and no longer overlap on adjacent lines.
- Moved the Add reference scrollbar clear of reference cards, and made the image bar scrollbar appear while scrolling.
- Agent-generated shots use full language names, such as English.
- Removed the opening-frame helper caption and made the release-note introduction render as normal text.
- Updated the bundled SlopFab runtime to API 1.16 and adapted LoRA preparation to preserve companion-grid downloads for older adapters.
