# PolStudio

PolStudio is a local-first, agentic video editor foundation built with React, TypeScript, and Tauri 2.

## Run it

```sh
npm install
npm run dev
```

For the native desktop shell, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and run:

```sh
npm run tauri dev
```

Tests and production validation:

```sh
npm test
npm run build
cd src-tauri && cargo test
```

## Application icons

`src-tauri/icons/` is generated, not hand-drawn. The mark is the film ticket from
the in-app logo -- blue plate, four perforations, and a single heavy white **P** --
and it is rasterised at every size by `scripts/make-icons.mjs`, which writes the
PNG/BMP/ICO/ICNS containers itself (no image toolchain required).

```sh
npm run icons                        # rewrite every file listed in bundle.icon
node scripts/make-icons.mjs --check  # decode the files back and print them as ASCII
```

Edit the geometry at the top of the script and re-run to re-tune the mark. Use
`--check` to confirm the letter is still legible at 16px; the previous icon said
"PolS" at every size and only a decode caught it.

## Project folders

Each project is a normal folder owned by the user:

```text
My project/
├── polstudio.json
├── assets/
├── generated/
├── exports/
└── cache/
```

`polstudio.json` is schema-versioned and contains the creative brief, render settings, asset metadata, and timeline structure. The Rust shell validates it before reads and writes; the web build uses validated local-storage records as a development fallback.

The web fallback seeds three deterministic showcase projects on first launch. Remove the `polstudio.web-projects.v1` local-storage entry to restore that initial demo library.

### Reference icons

`npm run reference-icons` renders every missing character, product, location, and style preset with MiniMax H3 at 30 steps. The generator reads the application catalogue directly, requests the model's minimum temporal span, and writes frame 0 directly as a high-quality 4:4:4 256×256 JPEG without creating an intermediate video or audio file. Character entries use controlled headshot lighting; product and location entries use a complete-subject view; style entries use a representative composition with lighting and rendering tailored to the named style.

SlopFab, Cargo, and FFmpeg must be installed. The script uses the development paths under `D:\Projects\slopfab` by default; `SLOPFAB_EXE`, `SLOPFAB_TRANSFORMER`, `SLOPFAB_TEXT_ENCODER`, `SLOPFAB_VIDEO_VAE`, `SLOPFAB_AUDIO_VAE`, `SLOPFAB_BACKEND`, `CARGO_EXE`, and `FFMPEG_EXE` can override them. Use `node scripts/generate-reference-icons.mjs --id=<preset-id> --force` to regenerate one entry.

The batch defaults to two GPU workers. Set `REFERENCE_ICON_WORKERS=1` or pass `--workers=1` on a lower-memory card. Use `--type=style` to generate or replace only style icons; `--shard=1/2` selects the first alternating half for a resumable recovery pass.
