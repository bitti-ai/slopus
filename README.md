<p align="center">
  <img src="marketing/logo.png" alt="Slopus" width="560" />
</p>

<p align="center">
  <strong>Create images, videos and music in one desktop workspace.</strong><br />
  AI-assisted generation, editing and reusable references.
</p>

<p align="center">
  <strong>ALPHA</strong> &nbsp;&bull;&nbsp; Local generation &nbsp;&bull;&nbsp; Your data
</p>

<p align="center">
  <a href="#features">Features</a> &nbsp;&middot;&nbsp;
  <a href="#setup">Setup</a>
</p>

---

Slopus combines an AI assistant, local image, video and music generation, reusable references and a timeline editor. SlopFab powers generation without Python; WebCodecs and WebGPU handle media processing without bundled FFmpeg.

![Slopus application screenshot](marketing/screenshot1.png)

## Features

- **Agent.** Plan scenes, generate media, inspect frames and song inputs, and match Motions to music with Claude Code, Codex, OpenRouter or a local OpenAI-compatible model. Toggle the pane with Ctrl+Shift+A.
- **Video.** Organize Videos → Scenes → Shots, share prompts and timed references, split songs into scenes and play scenes together. Generate with [multiple scene types](docs/scene-types.md), keep four takes plus a Draft, choose the primary take and upscale 1.5x/2x/4x.
- **Images.** Generate with MiniMax H3, MOSS Image, Krea 2 Turbo/Raw or Fibo 2.0 Base/Edit Turbo, in batches of up to 100. Supported models offer whole-image, box, lasso and Zoom edits, plus character sheets. Bounded edits preserve the original resolution; drafts and versions retain earlier work.
- **Music.** Generate with YuE2 or MiniMax Music3, edit lyrics and style, organize songs in folders and play them in sequence. Reuse songs as references or timeline audio. Right-click a song to generate album artwork; select its generator under **Settings → Generators → Icons**.
- **References.** Reuse descriptions, images, trimmed video/audio clips and [H3 RefMods](docs/refmods.md) across scenes, with generated reference icons.
- **Generators.** Manage shared weights, LoRAs, attention, generation effects and compatible sampler/scheduler choices, including ER-SDE and Beta. Get VRAM download warnings and live H3 image/video previews. Share [generator templates](docs/generator-weights.md#sharing-generator-templates) as `.slop` bundles or run jobs on LAN workers.
- **Timeline.** Arrange video and audio with trimming, splitting, snapping, waveforms, transitions, chroma key and GPU effects.
- **Motions.** Ask the agent to create JavaScript animations, edit elements and parameters, and render them on the timeline or as reference videos.
- **Export.** Save MP4 video, JPG/PNG images, or music as WAV, MP3, lossless FLAC, AAC/M4A or Opus in WebM/Ogg. MP3/FLAC encoders are bundled; AAC/Opus depend on device support. Exports run in the background.
- **Project editing.** Timeline, Video, Image, Music, References and Export views share Save, Undo and Redo. Projects and media are stored locally; agent requests go to the selected provider. API keys stay outside project files.

## Setup

Install a Windows x64 or Linux x86_64 release. In **Settings → Generators**, choose a model and download or select weights until the generator reads **Ready**. Configure OpenRouter or a local endpoint in **Settings → Agents**.

Local generation needs a supported GPU; 16 GB or more VRAM is recommended, with requirements varying by model and settings. MOSS and Fibo require CUDA.

| Windows GPU | Backend |
| --- | --- |
| NVIDIA RTX 50 series | CUDA 13 |
| NVIDIA RTX 30/40 series | CUDA 12.8 |
| AMD/Intel, or NVIDIA without CUDA | Vulkan for supported models |

On Linux, install the `.deb` or `.rpm`, or make the AppImage executable and run it. AppImage supports in-app updates. Video and GPU features require WebKitGTK 2.42+; the bundled generation runtime also requires NVIDIA driver libraries and CUDA 13 cuBLAS, even with Vulkan. See the [Linux guide](docs/linux.md).

### LAN workers

Unpack a matching worker release on a GPU-equipped computer:

| Platform | Package | Start |
| --- | --- | --- |
| Windows x64 | `Slopus-<version>-windows-x64-worker.zip` | `slopus-worker.exe --weights D:\Models` |
| Linux x86_64 | `Slopus-<version>-linux-x64-worker.tar.gz` | `./slopus-worker --weights ~/models` |

Allow TCP 47321 and UDP 5353 through the firewall. In **Settings → Workers**, click **Use** beside a discovered worker or add its address. Missing weights download when links are available. Select **This computer** to return to local generation.

Linux workers need the runtime libraries listed above. Run `slopus-worker --help` for backend, access-token and port options.

## Built with

Tauri 2, Rust, React, TypeScript, WebCodecs, WebGPU, `mp4box.js`, `mp4-muxer` and SlopFab.

## Model licensing

MiniMax H3 model weights are licensed separately under the **MiniMax H3 COMMUNITY LICENSE AGREEMENT**.

Fibo 2.0 is released under CC BY-NC 4.0 for non-commercial use. Commercial use is subject to an agreement with BRIA.

[YuE2](https://huggingface.co/Comfy-Org/YuE2) uses CC BY-NC 4.0; [MiniMax Music3](https://huggingface.co/Comfy-Org/MiniMax-Music-3) uses Apache 2.0.
