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

- **Two project types.** Video projects have **Timeline**, **Generator**, **References** and **Export** tabs; Image projects have **Editor**, **References** and **Export**.
- **Agent.** Claude Code, Codex, OpenRouter, or a local OpenAI-compatible model in a docked pane (Ctrl+Shift+A). It can plan scenes, build references, and edit video and image projects.
- **Scene generator.** A board of scenes and shot tiles. Scene types: First & last frame, Animate, Pose, Character replace, Extend and Bridge. Attach references and start frames, and set steps, seeds and generator presets. Runs in the **Work queue**, where jobs can be cancelled.
- **Shot controls.** Set shot timing, visual action, spoken lines and language, with camera and performance settings plus scene-wide look, sound and music. Insert reusable references as smart chips in shot descriptions.
- **References.** Characters, animals, products, locations and styles with descriptions, images and generated icons. Start from searchable presets, browse as Icons or Details, and see which scenes use each one. Attach video references, preview and trim their clip ranges, and choose whether to include their soundtracks.
- **RefMods.** Attach pre-encoded H3 reference `.safetensors` files to reusable references, with independent **Strength** and **Copies** controls. Use them with Ref2VA generators for video, still images, image edits and reference icons.
- **LoRAs.** Add local adapters or download built-in options such as TaoMate 3-Step, Turbo and LightX2V Turbo. Combine multiple LoRAs in a generator template, reorder them, adjust their strengths, and set optional step-count overrides.
- **LAN workers.** Run `slopus-worker` on another computer and choose it in **Settings → Workers** to generate there. Workers are found on the local network automatically (mDNS) or added by address. Weights with download links download on the worker; local-only weights, references and source images are sent from this computer. Results are saved to the project as if they were generated locally.
- **Generator templates.** Download model weights from Settings with progress, cancellation and retry, or use your own local files. Save model and attention settings per template, and optionally enable **MotionCache** to reuse denoising work in supported generation modes.
- **Timeline.** Video and audio tracks with thumbnails, waveforms, snapping, trimming, splitting, zoom and keyboard shortcuts. Transform, opacity, chroma key, fades and wipes, plus GPU effects (sharpen, blur, color correction, vignette, `.cube` LUTs) that can be bypassed.
- **Image editor.** Build a hierarchy of objects, text and groups with placement boxes, then generate with MiniMax H3. Use **Image root** to open a PNG or JPEG (or **Edit** a result) and apply edits in hierarchy order with bounding-box inpainting. Results and drafts stay in the image bar.
- **Export.** Video: MP4 in H.264, VP9 or AV1 (as your encoders allow) at a chosen resolution, frame rate and quality; exports keep running in the background. Images: pick one from the image bar and save it as JPG or PNG at a chosen size and quality.
- **Undo everywhere.** Save, Undo and Redo sit in the title bar; Ctrl+Z and Ctrl+Y cover edits from any view, the agent and project settings.
- **Your data.** Projects and media stay on disk. API keys stay in this computer's settings, outside project files.

## Setup

Local video generation requires separately installed model weights and GPU support. In **Settings → Generator**, configure a generator's model paths and check that its status reads **Ready**. Configure OpenRouter or a local model endpoint in **Settings → Agents** to make it available in the assistant's agent list.

### Generating on another computer

Unpack the Slopus worker package (`Slopus-<version>-windows-x64-worker.zip`, containing `slopus-worker.exe` and `slopfab.dll`) on a computer with a capable GPU on the same network and run:

```
slopus-worker.exe --weights D:\Models
```

Allow it through Windows Firewall when asked. In Slopus, open **Settings → Workers** and click **Use** next to the worker. Generators whose weights have download links become usable even if they are not downloaded on this computer; the worker downloads missing weights into its weights folders on first use. Run `slopus-worker.exe --help` for options: `--port`, `--name`, `--token` (require an access token), `--data`, `--weights` (repeatable), `--vulkan` and `--no-mdns`. Choose **This computer** to generate locally again.

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
