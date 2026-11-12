# Slopus — 0.4.2

## 0.4.2 fixes

- Image resolution selection fixed for MiniMax H3.
- Character sheet generation support fixed for MiniMax H3.
- Zoom generation support fixed for MiniMax H3.

## 0.4.1

Changes since 0.4.0.

### What's new

- **Video references:** Create a reference from a generated Scene or Shot using its context menu. Scenes select the whole video; Shots retain the full source with their exact time range selected. Video references now support clips shorter than two seconds.
- **Song variations:** Duplicate a song into a draft with the same title, lyrics, style and settings. Use Generate's dropdown to queue up to 100 variations with different seeds.
- **MiniMax H3 Image:** Six-step image generation, image references, masked edits and Zoom on CUDA or Vulkan, with downloadable transformer variants and its dedicated image VAE. Shares the selected text encoder and tokenizer with MiniMax H3 video, reusing existing downloads.

### Fixes and improvements

- Updated the bundled Slopfab runtime to 0.2.0, including a higher MiniMax H3 Image canvas limit of 20 MP.
- MiniMax H3 Image resolution presets use four times the width and height. Switching image models keeps the same preset position; sizes above 20 MP are unavailable.
- Fixed Extend rejecting editing drafts that already have a saved source image.
- YuE2 now defaults to six flow steps with DPM++ 2M. The previous Midpoint solver remains available in music's Advanced settings, and saved generator templates using the old 32-step default upgrade once to six steps.
- On first launch after updating, each recent project gets a one-time cleanup of orphaned generated media, latents and caches. Other projects receive the cleanup when first opened; files still referenced by the project are preserved.
- Saving now deletes unused files from replaced video takes and removed video, image and music generations, including latents and derived caches. Files still used by timeline clips, references or other generations are preserved; saved deletions cannot be undone.
- Fixed the image editor's Generate dropdown arrow colors when generation is unavailable, while keeping available options accessible.
- Linux packages and the bundled generation runtime now target Ubuntu 22.04 compatibility; AppImages exclude CUDA driver stubs.
