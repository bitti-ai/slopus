# Slopus 0.3.0

This alpha update adds LAN generation workers, Linux support, expanded color grading, character sheets, and shareable generator templates, alongside improvements to references and scene continuation.

## What's new

- Character Sheet creates a selectable image-bar entry as soon as generation is queued. Selecting it while generation runs shows the template's existing settings panel with the submitted settings. Finished results open in the normal image editor.
- LAN workers: run the Slopus worker package on another Windows or Linux computer and pick it in the new **Settings → Workers** tab to generate there. Slopus finds workers on the local network automatically, or by address. Workers download generator weights from their download links themselves and use CUDA when available, with a Vulkan fallback; local-only files are sent from this computer, and finished videos, images and latents are saved in your project as usual.
- Slopus for Linux (x86_64): install the .deb or .rpm package, or run the AppImage, which updates itself. Local generation on Linux needs an NVIDIA GPU with CUDA 13.
- Every project now includes Video and Image tabs. Older video and image projects keep their saved content, and Export supports both output types.
- Renamed Colour correction to Basic Corrections and added temperature, tint, brightness, highlights, shadows, whites and blacks alongside exposure, contrast and saturation.
- Added Creative with eight built-in procedural looks and intensity, faded film, sharpen and vibrance controls; RGB and hue/saturation/luma curve editors; and shadow, midtone and highlight Color Wheels with individual lightness controls.
- Vignette now includes midpoint, roundness and feather, plus negative amounts for lighter edges. Grading settings are saved with the project and applied consistently in preview and export.
- Configure a character sheet from the Image toolbar's Template menu, with one reference-enabled prompt for clothing and other details, a resolution selection controlling sheet height (512–2048 px), and step count and seed controls, then select Execute. A square waist-up shot and three 9:16 full-body views are combined into one child image in the image bar. The front view provides a shared clothing reference for the other views; all four views share the selected step count and seed.
- Continue scenes from a selected scene's saved latents, with adjustable overlap and a choice of beginning or end. This replaces Previous scene in First & last frame.
- Share URL-based generator templates using Import and Export in Generator settings. Versioned `.slop` JSON bundles include GPU download variants, LoRAs and additional safetensors, preserve existing templates on import, and leave local paths out of shared files.
- The agent can inspect, create and edit generator templates, scan local weight folders to identify model components from filenames and safetensors metadata, and register LoRAs for preparation in Settings.
- The agent can capture and inspect timeline frames with layers, transitions and effects, without moving the playhead or interrupting playback and editing. Captures are sent as images to the selected agent model.
- The agent can generate a specific video scene with a chosen generator template, then automatically resume after encoding and saving to review the result or continue the task. Generation uses the existing local or LAN worker queue and reports failures and cancellation back to the agent.
- Sound references: add an MP3, M4A, WAV, FLAC or Ogg file to a reference, choose a 2 to 15 second range, and cite it in a shot as `<Audio N>`, for example as a voice timbre. Sound references need a Ref2VA generator and an image or video reference in the same scene, and also work on LAN workers.
- Video references now offer a Frames mode: select still frames from a clip and use them as image references.
- Export any reference with images, a video or a sound as a refmod `.safetensors` file from References. Exported refmods can be attached to other references and projects.
- First and last scene frames use the searchable reference picker with image thumbnails. Reference selectors and prompt chips share configurable filters for images, audio, video, text, and RefMods.
- Choose Make Primary on an image version to show it in the main image bar and use it when creating scenes or references from that family.
- Images imported through Timeline or References, including selected video reference frames, appear in the image bar and open for editing.
- Create a video scene with an image as its first frame, or create an image reference, directly from the Image tab's image bar context menu.
- Image canvas context menus now offer image actions, including Edit, Create Scene and Create Reference.
- Duplicate references from their context menu, including multiple selected references with their prompts, attachments, and media settings.
- Clothes and Accessories reference categories include common wearable items. Clothes offer optional color and fabric settings.
- Add an empty reference from the References toolbar and attach images from its preview header.
- Copying or cutting prompts preserves reference chips when pasted into other prompt fields.

## Fixes and improvements

- Work queue activity indicators keep moving in the top bar and open queue when Windows interface animations are disabled.
- Image and video export offer None, Real-ESRGAN and SeedVR2 upscaling through SlopFab. Download their models from the new Other weights section in Settings → Generator.
- Image export offers sizes closest to the selected image's actual aspect ratio, even when project or saved generation settings differ.
- Click a work queue job to open its image, scene, reference, generator download or export. Navigation works across projects and preserves unsaved project edits.
- Character Sheet offers Debug prompt when debug options are enabled, exposing the separate compiled prompt for each of its four views.
- Updated the bundled SlopFab runtime to API 1.18 for refmod export and support for version-5 refmod bundles.
- LAN workers select weight downloads using their own GPU type and VRAM, even when a different variant is already downloaded on the client.
- Continue preserves the full joined video and audio from Slopfab. Adjacent source and continuation scenes use that shared decode in preview and export, preserving context across the cut. Regenerate older Continue scenes to apply the fix.
- The timeline playhead follows playback without waiting for editor updates.
- Character sheet prompts focus on each view's essential framing and orientation, with concise instructions for consistent identity and clothing.
- Removing a reference from a scene's last prompt citation now removes it from generation inputs and “Used by.” References selected as frame or motion inputs remain active.
- Copy and paste effect settings between matching effects from their **…** menus, including bypass state and LUT data.
- Add voice reference chips directly in a shot's Speech field. Voice guidance stays separate from the words spoken.
- Loose Windows executables are automatically detected as portable without a marker file. Portable builds show available updates and open GitHub releases for manual updating; NSIS and MSI installations are recognized by their registered installation folder and can update in place.
- Agent chat uses message bubbles with formatted replies and avoids repeating completed responses.
- New empty images created while browsing child images stay in the same image family.
- Renamed the Look effect to Opacity and removed its Temperature control. Temperature adjustment is available in Basic Corrections.
- The Add effect menu lists effects alphabetically.
- The Image toolbar spans the workspace, with canvas tools and view controls grouped in the center.
- The Save button keeps its label while saving, preventing the top bar tabs from shifting.
- Reference chips now highlight when included in a prompt's text selection.
- The Video scene list scrollbar stays clear of Generate and Cancel, while scene header backgrounds extend to the edge.
- Timeline media thumbnails stay inside their preview area, keeping filenames clear in grid and list layouts.
- Export notification buttons appear below the output path so long filenames remain readable.
- Improved reference picker scrollbar visibility and initial keyboard focus in the release notes dialog.
