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
  <a href="#from-idea-to-export">From idea to export</a> &nbsp;&middot;&nbsp;
  <a href="#setup">Setup</a>
</p>

---

Slopus brings an AI assistant, a scene generator, reusable visual references, and a timeline editor together. Describe what you want to make, generate clips locally with SlopFab, and shape the result into a video you can export and share.

> **GPU recommendation:** A GPU with **24 GB of VRAM or more** is currently recommended for local video generation. We plan to reduce VRAM usage in future updates.

![Slopus application screenshot](marketing/screenshot1.png)

## Features

### Create through conversation

Connect Claude Code, Codex, OpenRouter, or a local model served through an OpenAI-compatible API. Ask your assistant to develop an idea into scenes and shots, build references, and refine the project through conversation.

### Plan scenes and generate clips

- **Scene and shot board:** Write shot prompts, set timing, and drag scenes and shots into order.
- **Creative controls:** Shape shots with camera and visual settings, attach references, or use an image as a scene's starting frame.
- **Local generation:** Render with SlopFab using model files on your computer. Adjust generation steps and seeds, and save different model setups as generator presets.
- **Work queue:** Follow generation progress and cancel queued or running jobs.

### Keep a reusable reference library

Define characters, animals, products, locations, and styles with written descriptions and image attachments. Start from searchable presets or create your own references, then reuse them across scenes to guide a consistent look. See which scenes use a reference and jump back into the generator to edit them.

### Edit picture and sound

- **Video and audio tracks:** Combine generated clips with imported media, arrange clips with snapping, trim their edges, and split at the playhead.
- **Visual timeline:** Use video thumbnails, audio waveforms, zoom, and scrubbing to find the right moment. Lock or mute tracks as you work.
- **Clip effects:** Scale, rotate, and reposition footage; adjust opacity and color temperature; remove a background color with chroma key.
- **Transitions and preview:** Add fades or directional wipes and review the composition in the program monitor.

### Export for your audience

Work in landscape, portrait, square, or 4:5 formats. Preview the edit, choose output resolution, frame rate, and quality, then export an MP4. H.264, VP9, and AV1 options depend on the encoders available on your computer; the export view checks support before rendering.

### Keep projects under your control

Projects live in local file system, with a `slopus.json` project file and files for generated media, references, and exports. Imported media can also be linked from elsewhere on your computer. Agent endpoints and API keys stay in this computer's settings, outside project files.

Choose a light, dark, or system theme, and check for app updates from Settings.

## From idea to export

1. **Create a project** create a project folder and choose its video format.
2. **Build your references** with descriptions and images for the subjects and look you want.
3. **Write scenes and shots** yourself or work with the assistant, then generate clips.
4. **Assemble the edit** on the timeline, add video or audio, and refine timing and effects.
5. **Preview and export** the finished video as an MP4.

## Setup

Local video generation requires separately installed model weights and GPU support. In **Settings → Video engine**, configure a generator's model paths and check that its status reads **Engine ready**. Configure OpenRouter or a local model endpoint in **Settings → Agents** to make it available in the assistant's agent list.

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
