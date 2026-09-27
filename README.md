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

- **Two project types.** A project is a folder with a `slopus.json` file. Video projects have **Timeline**, **Generator**, **References** and **Export** tabs; Image projects have **Editor**, **References** and **Export**.
- **Agent.** Claude Code, Codex, OpenRouter, or a local OpenAI-compatible model in a docked pane (Ctrl+Shift+A). It can plan scenes, build references, and edit video and image projects (see the [image command guide](src-tauri/assets/agent-image.md)).
- **Scene generator.** A board of scenes and shot tiles. Scene types: First & last frame, Animate, Pose, Character replace, Extend and Bridge. Attach references and start frames, and set steps, seeds and generator presets. Runs in the **Work queue**, where jobs can be cancelled.
- **References.** Characters, animals, products, locations and styles with descriptions and images. Start from searchable presets, browse as Icons or Details, and see which scenes use each one.
- **Timeline.** Video and audio tracks with thumbnails, waveforms, snapping, trimming, splitting, zoom and keyboard shortcuts. Transform, opacity, chroma key, fades and wipes, plus GPU effects (sharpen, blur, color correction, vignette, `.cube` LUTs) that can be bypassed.
- **Image editor.** Build a hierarchy of objects, text and groups with placement boxes, then generate with MiniMax H3. Use **Image root** to open a PNG or JPEG (or **Edit** a result) and apply edits in hierarchy order with bounding-box inpainting. Results and drafts stay in the image bar.
- **Export.** Video: MP4 in H.264, VP9 or AV1 (as your encoders allow) at a chosen resolution, frame rate and quality; exports keep running in the background. Images: pick one from the image bar and save it as JPG or PNG at a chosen size and quality.
- **Undo everywhere.** Save, Undo and Redo sit in the title bar; Ctrl+Z and Ctrl+Y cover edits from any view, the agent and project settings.
- **Your data.** Projects and media stay on disk. API keys stay in this computer's settings, outside project files.

## Setup

Local video generation requires separately installed model weights and GPU support. In **Settings → Generator**, configure a generator's model paths and check that its status reads **Ready**. Configure OpenRouter or a local model endpoint in **Settings → Agents** to make it available in the assistant's agent list.

The project's GPU setup recommendations are:

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
