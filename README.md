# Slopus

Slopus is a local-first, agentic video editor foundation built with React, TypeScript, and Tauri 2.

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

On Windows, `package.cmd` builds the current source into a runnable portable
folder and matching ZIP under `artifacts/`, without creating installers.
`release.cmd` runs the full packaging workflow: setup installer, MSI when
produced, portable folder, and ZIP. Both scripts install locked dependencies
and build the production app before collecting outputs.

## Application icons

`marketing/icon.png` is the source artwork for the application icon, browser
favicon, and Project Library logo. `scripts/make-icons.mjs` uses the installed
Tauri CLI to generate the desktop PNG, ICO, and ICNS files in `src-tauri/icons/`.

```sh
npm run icons                        # rewrite every file listed in bundle.icon
node scripts/make-icons.mjs --check  # verify packaged icons against the source artwork
```

Replace the square, transparent `marketing/icon.png` and run `npm run icons` to
update the packaged artwork. Intermediate platform assets are generated under
the ignored `artifacts/generated-icons/` folder.

## Project folders

Each project is a normal folder owned by the user:

```text
My project/
├── slopus.json
├── assets/
├── generated/
├── exports/
└── cache/
```

`slopus.json` is schema-versioned and contains the creative brief, render settings, asset metadata, and timeline structure. The Rust shell validates it before reads and writes; the web build uses validated local-storage records as a development fallback. Existing `polstudio.json`, `pols.json`, and `polstudio.project.json` projects still open and migrate to `slopus.json` on save.

The web fallback seeds three deterministic showcase projects on first launch. Remove the `slopus.web-projects.v1` local-storage entry to restore that initial demo library.

### Reference icons

Custom references with a prompt and no existing artwork automatically receive
256×256 JPG icons, generated at 768×768 with 20 steps through SlopFab's dedicated
still-image mode, then downscaled and encoded at JPEG quality 95. Category-specific
compositions include the user's prompt. All icon work appears in one Work Queue
entry, and waiting video generations run before the next icon. Generated icons
are saved under `references/icons/` in the project and are not sent to the video
engine as image attachments. Built-in presets are added as new references from
the Add a reference dialog.

Before an automatic icon batch starts, Slopus asks whether to start or cancel it.
Select **Don't ask again** to remember Start as automatic generation without prompts,
or Cancel as disabling automatic generation. **Settings → Video engine → Automatic
reference icon generation** turns automation on or off; confirmation can also be
re-enabled there. Turning automation off skips waiting automatic icons but lets an
icon already rendering finish. Manual icon generation remains available.

`npm run reference-icons` renders every missing character, product, location, and style preset with MiniMax H3 at 768×768 and 20 steps. Its DLL backend uses the dedicated still-image mode, downsamples each 3×3 pixel block to produce a 256×256 icon, and encodes it at JPEG quality 95 without creating an intermediate video or audio file. Character entries use controlled headshot lighting; product and location entries use a complete-subject view; style entries use a representative composition with lighting and rendering tailored to the named style.

SlopFab, Cargo, and FFmpeg must be installed. The script uses the development paths under `D:\Projects\slopfab` by default; `SLOPFAB_EXE`, `SLOPFAB_TRANSFORMER`, `SLOPFAB_TEXT_ENCODER`, `SLOPFAB_VIDEO_VAE`, `SLOPFAB_AUDIO_VAE`, `SLOPFAB_BACKEND`, `CARGO_EXE`, and `FFMPEG_EXE` can override them. Use `node scripts/generate-reference-icons.mjs --id=<preset-id> --force` to regenerate one entry.

The batch defaults to two GPU workers. Set `REFERENCE_ICON_WORKERS=1` or pass `--workers=1` on a lower-memory card. Use `--type=style` to generate or replace only style icons; `--shard=1/2` selects the first alternating half for a resumable recovery pass.
