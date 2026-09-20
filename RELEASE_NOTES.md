# Slopus 0.1.1

This alpha update adds video effects, improved video references, more generator
controls, and a simpler settings workflow.

## What's new

- GPU video effects in preview and export: sharpening, Gaussian blur, color
  correction, vignette, and imported `.cube` LUTs.
- Video references accept longer source files with a 2-15 second selection.
  A dedicated trim popup previews the active trim edge and supports optional
  soundtrack conditioning and decoder fallback.
- Project-wide Looks with scene overrides, plus a timeline that grows
  automatically as clips are added, moved, or extended.
- Scene continuation from saved latents, new Singularity and Animate generator
  templates, and Turbo and LightX2V Turbo LoRA downloads.
- Per-LoRA strength multipliers, a MotionCache toggle, generator creation in a
  popup, and template selection for reference icon generation.
- Full-screen Settings and simpler project and reference controls.

## Fixes and improvements

- Updated the bundled SlopFab runtime and aligned generation planning and
  progress with model metadata.
- Added LoRA timestep-grid preparation during downloads and local imports,
  with a Prepare action for existing adapters.
- Improved discovery of existing model weights, custom weight folder support,
  and availability reporting when template LoRAs are missing.
- Expanded regression coverage across project persistence, generation,
  references, rendering, and release publishing.

## Known limitations

Animate integration is experimental. Animate output is capped at 345 frames.

The new video effects require WebGPU. Full model inference and CUDA/Vulkan render
performance have not been revalidated for this release.

## Getting started

Use the Windows x64 setup installer, or extract the portable ZIP and run
`Slopus.exe`. Keep `slopfab.dll` beside the portable executable. The installer
sets up Microsoft Edge WebView2 if needed; portable copies require it already
installed. Model weights are downloaded separately in Settings → Generators.

A GPU with **24 GB of VRAM or more is recommended**. We plan to reduce VRAM
requirements in future updates. CUDA requires a compatible NVIDIA setup;
Vulkan is also supported. AI agent providers may require separate setup and
authentication.

This is alpha software. Image, 3D, music, and speech generation as standalone
project types are planned for future versions.
