# Pol Studio

Pol Studio is a local-first, agentic video editor foundation built with React, TypeScript, and Tauri 2.

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

## Project folders

Each project is a normal folder owned by the user:

```text
My project/
├── polstudio.project.json
├── assets/
├── generated/
├── exports/
└── cache/
```

`polstudio.project.json` is schema-versioned and contains the creative brief, render settings, asset metadata, and timeline structure. The Rust shell validates it before reads and writes; the web build uses validated local-storage records as a development fallback.

The web fallback seeds three deterministic showcase projects on first launch. Remove the `polstudio.web-projects.v1` local-storage entry to restore that initial demo library.
