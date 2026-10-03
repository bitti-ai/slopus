<p align="center">
  <img src="marketing/logo.png" alt="Slopus" width="560" />
</p>

<p align="center">
  <strong>Turn an idea into scenes, clips, and a finished video.</strong><br />
  AI-assisted media creation and editing in one desktop workspace.
</p>

<p align="center">
  <strong>ALPHA</strong> &nbsp;&bull;&nbsp; Local generation &nbsp;&bull;&nbsp; Your data
</p>

<p align="center">
  <a href="#features">Features</a> &nbsp;&middot;&nbsp;
  <a href="#setup">Setup</a>
</p>

---

Slopus brings an AI assistant, a scene generator, reusable references, a timeline editor, and a still image editor together. Generate locally with SlopFab (no Python, no FFmpeg) and export finished videos and images.

> **GPU recommendation:** **24 GB of VRAM or more** is currently recommended for local generation. We plan to reduce this in future updates.

![Slopus application screenshot](marketing/screenshot1.png)

## Features

- **One workspace.** Every project has **Timeline**, **Video**, **Image**, **References** and **Export** tabs.
- **Agent.** Plan scenes, create references and edit projects with Claude Code, Codex, OpenRouter or a local OpenAI-compatible model. Open the agent pane with Ctrl+Shift+A.
- **Scene generator.** Generate scenes with First & last frame, Animate, Pose, Character replace, Extend or Bridge. Set steps, seeds and presets; manage jobs in the **Work queue**.
- **Shot controls.** Set timing, action, dialogue, language, camera and performance. Add scene-wide look, sound and music, and cite references with smart chips.
- **References.** Reuse descriptions, images and video clips across scenes. Start from searchable presets, see where references are used, and trim clips with optional sound.
- **RefMods.** Use pre-encoded H3 `.safetensors` references with Ref2VA generators for video, images, edits and icons. Set **Strength** and **Copies** per attachment.
- **LoRAs.** Combine local or downloadable adapters in generator templates, with ordering, strength and step-count controls.
- **LAN workers.** Generate on another Windows or Linux computer. Workers download available weights, receive local files as needed, and return results to your project.
- **Generator templates.** Download weights or use local files. Save model and attention settings per template, with optional **MotionCache** for supported modes.
- **Timeline.** Video and audio tracks with thumbnails, waveforms, snapping, trimming, splitting, zoom and keyboard shortcuts. Transform, opacity, chroma key, fades and wipes, plus GPU effects (sharpen, blur, color correction, vignette, `.cube` LUTs) that can be bypassed.
- **Image editor.** Generate images from prompts, objects and text, or open an image and describe whole-image or local edits. Keep originals, drafts and versions in the image bar.
- **Export.** Video: MP4 in H.264, VP9 or AV1 (as your encoders allow) at a chosen resolution, frame rate and quality; exports keep running in the background. Images: pick one from the image bar and save it as JPG or PNG at a chosen size and quality.
- **Undo everywhere.** Save, Undo and Redo sit in the title bar; Ctrl+Z and Ctrl+Y cover edits from any view, the agent and project settings.
- **Your data.** Projects and media stay on disk. API keys stay in this computer's settings, outside project files.

## Setup

In **Settings → Generator**, download or select model weights and check that the generator reads **Ready**. Local generation requires a supported GPU. Configure OpenRouter or a local model endpoint in **Settings → Agents**.

### Linux

Install the x86_64 `.deb` or `.rpm` package, or make the AppImage executable and run it. The AppImage supports in-app updates.

Requires WebKitGTK 2.42+ for video and GPU features. The bundled generation runtime requires NVIDIA driver libraries and CUDA 13 cuBLAS, even when using Vulkan. See the [Linux guide](docs/linux.md) for details.

### Generating on another computer

Unpack a worker package on a GPU-equipped computer on your network:

| Platform | Package | Start |
| --- | --- | --- |
| Windows x64 | `Slopus-<version>-windows-x64-worker.zip` | `slopus-worker.exe --weights D:\Models` |
| Linux x86_64 | `Slopus-<version>-linux-x64-worker.tar.gz` | `./slopus-worker --weights ~/models` |

1. Start the worker and allow TCP 47321 and UDP 5353 through the firewall.
2. In **Settings → Workers**, click **Use** beside the discovered worker, or add it by address. Missing weights download on first use when download links are available.
3. Select **This computer** to switch back to local generation.

Windows workers prefer CUDA 13, then CUDA 12, with Vulkan as a fallback. Linux workers also support `--backend vulkan`, but the bundled runtime still needs the libraries above. No desktop libraries are required. Run `slopus-worker --help` for backend, access-token and port options.

Windows GPU setup:

| GPU | Generation backend |
| --- | --- |
| NVIDIA GeForce RTX 50 series (Blackwell) | CUDA 13 |
| NVIDIA GeForce RTX 30 or RTX 40 series | CUDA 12.8 |
| AMD/Intel | Vulkan |
| NVIDIA without CUDA installed | Vulkan fallback |

## Built with

Slopus uses Tauri 2, Rust, React, and TypeScript. WebCodecs and WebGPU power media processing and rendering, with MP4 export through `mp4-muxer`. SlopFab powers local AI generation.

## Model licensing

Powered by MiniMax H3.

MiniMax H3 model weights are licensed separately under their own **MiniMax H3 COMMUNITY LICENSE AGREEMENT**.
