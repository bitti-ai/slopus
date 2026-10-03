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

### Linux

Slopus runs on x86_64 Linux. Install `Slopus-<version>-linux-x64.deb` (Debian, Ubuntu) or `Slopus-<version>-linux-x64.rpm` (Fedora, openSUSE), or make `Slopus-<version>-linux-x64.AppImage` executable and run it; the AppImage updates itself. The app needs WebKitGTK 2.42 or later for video decoding, export and GPU effects. Local generation has the same requirements as the Linux worker below. See [docs/linux.md](docs/linux.md).

### Generating on another computer

Workers run on Windows or Linux. On a computer with a capable GPU on the same network, unpack the worker package and start it:

| Platform | Package | Start |
| --- | --- | --- |
| Windows x64 | `Slopus-<version>-windows-x64-worker.zip` (`slopus-worker.exe`, `slopfab.dll`) | `slopus-worker.exe --weights D:\Models` |
| Linux x86_64 | `Slopus-<version>-linux-x64-worker.tar.gz` (`slopus-worker`, `libslopfab.so`) | `./slopus-worker --weights ~/models` |

The Linux worker needs no desktop or UI libraries, but it does need an NVIDIA GPU with the NVIDIA driver and CUDA 13 cuBLAS (`libcublas.so.13`); it looks for cuBLAS in `/usr/local/cuda*` if the system linker does not find it. Allow the worker through the firewall (TCP 47321, and UDP 5353 for discovery).

In Slopus, open **Settings → Workers** and click **Use** next to the worker. Generators whose weights have download links become usable even if they are not downloaded on this computer; the worker downloads missing weights into its weights folders on first use. Run `slopus-worker --help` for options: `--port`, `--name`, `--token` (require an access token), `--data`, `--weights` (repeatable), `--backend` and `--no-mdns`. The worker uses CUDA when it is available and otherwise falls back to Vulkan, printing a warning if an NVIDIA GPU is present without a usable CUDA installation. On Windows it uses CUDA 13 if installed, otherwise CUDA 12; the Linux runtime uses CUDA 13. `--backend cuda13`, `--backend cuda12`, `--backend cuda` or `--backend vulkan` overrides the choice. Choose **This computer** to generate locally again.

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
