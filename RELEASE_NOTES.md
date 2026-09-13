# Slopus 0.1.0

The first public alpha of Slopus: an AI media harness for planning, generating,
and editing media locally. This release focuses on video workflows.

## Included

- AI agents for planning projects, writing scenes, and arranging the timeline.
- Local SlopFab generation with CUDA and Vulkan support.
- Generator templates, weight downloads, and ordered LoRAs with configurable
  strengths and step overrides.
- Reusable references from prompts, images, videos, and refmod files.
- Built-in reference presets with background icon generation.
- Timeline editing, preview, and MP4 export using WebCodecs and WebGPU.
- Editable project resolution, aspect ratio, and target length.
- Signed application updates and a Work Queue that continues across projects.
- A `Slopus` user data folder with separate `logs` and `reference-icons` folders;
  existing settings and icons migrate at startup.

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
