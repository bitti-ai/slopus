# Slopus 0.3.0

This alpha update adds Linux support, LAN generation workers, expanded color grading, character sheets, and shareable generator templates, alongside improvements to references and scene continuation.

## What's new

- The agent can inspect, create and edit generator templates, scan local weight folders to identify model components from filenames and safetensors metadata, and register LoRAs for preparation in Settings.
- Extend an image from the Image toolbar's Template menu. Draw, move or resize a bounding box to generate beyond any edge, with optional prompts and references, steps and seed controls. Original pixels inside the box stay unchanged, and the result is saved as a child image in lossless PNG format.
- Share URL-based generator templates using Import and Export in Generator settings. Versioned `.slop` JSON bundles include GPU download variants, LoRAs and additional safetensors, preserve existing templates on import, and leave local paths out of shared files.
- Renamed Colour correction to Basic Corrections and added temperature, tint, brightness, highlights, shadows, whites and blacks alongside exposure, contrast and saturation.
- Added Creative with eight built-in procedural looks and intensity, faded film, sharpen and vibrance controls; RGB and hue/saturation/luma curve editors; and shadow, midtone and highlight Color Wheels with individual lightness controls.
- Vignette now includes midpoint, roundness and feather, plus negative amounts for lighter edges. Grading settings are saved with the project and applied consistently in preview and export.
- First and last scene frames use the searchable reference picker with image thumbnails. Reference selectors and prompt chips share configurable filters for images, audio, video, text, and RefMods.
- Configure a character sheet from the Image toolbar's Template menu, with one reference-enabled prompt for clothing and other details, a resolution selection controlling sheet height (512–2048 px), and step count and seed controls, then select Execute. A square waist-up shot and three 9:16 full-body views are combined into one child image in the image bar. The front view provides a shared clothing reference for the other views; all four views share the selected step count and seed.
- Continue scenes from a selected scene's saved latents, with adjustable overlap and a choice of beginning or end. This replaces Previous scene in First & last frame.
- Export any reference with images, a video or a sound as a refmod `.safetensors` file from References. Exported refmods can be attached to other references and projects.
- Copying or cutting prompts preserves reference chips when pasted into other prompt fields.
- Choose Make Primary on an image version to show it in the main image bar and use it when creating scenes or references from that family.
- Images imported through Timeline or References, including selected video reference frames, appear in the image bar and open for editing.
- Duplicate references from their context menu, including multiple selected references with their prompts, attachments, and media settings.
- Create a video scene with an image as its first frame, or create an image reference, directly from the Image tab's image bar context menu.
- Image canvas context menus now offer image actions, including Edit, Create Scene and Create Reference.
- Every project now includes Video and Image tabs. Older video and image projects keep their saved content, and Export supports both output types.
- Clothes and Accessories reference categories include common wearable items. Clothes offer optional color and fabric settings.
- Video references now offer a Frames mode: select still frames from a clip and use them as image references.
- Add an empty reference from the References toolbar and attach images from its preview header.
- Sound references: add an MP3, M4A, WAV, FLAC or Ogg file to a reference, choose a 2 to 15 second range, and cite it in a shot as `<Audio N>`, for example as a voice timbre. Sound references need a Ref2VA generator and an image or video reference in the same scene, and also work on LAN workers.
- Slopus for Linux (x86_64): install the .deb or .rpm package, or run the AppImage, which updates itself. Local generation on Linux needs an NVIDIA GPU with CUDA 13.
- LAN workers: run the Slopus worker package on another Windows or Linux computer and pick it in the new **Settings → Workers** tab to generate there. Slopus finds workers on the local network automatically, or by address. Workers download generator weights from their download links themselves and use CUDA when available, with a Vulkan fallback; local-only files are sent from this computer, and finished videos, images and latents are saved in your project as usual.

## Fixes and improvements

- Character sheets give side and back views explicit orientation instructions, keeping reference identity and clothing without copying the front-facing pose.
- The Add effect menu lists effects alphabetically.
- Renamed the Look effect to Opacity and removed its Temperature control. Temperature adjustment is available in Basic Corrections.
- New empty images created while browsing child images stay in the same image family.
- The Save button keeps its label while saving, preventing the top bar tabs from shifting.
- The Image toolbar spans the workspace, with canvas tools and view controls grouped in the center.
- Agent chat uses message bubbles with formatted replies and avoids repeating completed responses.
- Export notification buttons appear below the output path so long filenames remain readable.
- Continue preserves the full joined video and audio from Slopfab. Adjacent source and continuation scenes use that shared decode in preview and export, preserving context across the cut. Regenerate older Continue scenes to apply the fix.
- The timeline playhead follows playback without waiting for editor updates.
- Copy and paste effect settings between matching effects from their **…** menus, including bypass state and LUT data.
- Add voice reference chips directly in a shot's Speech field. Voice guidance stays separate from the words spoken.
- Removing a reference from a scene's last prompt citation now removes it from generation inputs and “Used by.” References selected as frame or motion inputs remain active.
- Reference chips now highlight when included in a prompt's text selection.
- The Video scene list scrollbar stays clear of Generate and Cancel, while scene header backgrounds extend to the edge.
- Timeline media thumbnails stay inside their preview area, keeping filenames clear in grid and list layouts.
- Portable builds show available updates and open GitHub releases for manual updating instead of running an installer.
- Improved reference picker scrollbar visibility and initial keyboard focus in the release notes dialog.
- Updated the bundled SlopFab runtime to API 1.18 for refmod export and support for version-5 refmod bundles.
