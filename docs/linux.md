# Linux desktop app

Slopus builds for x86_64 Linux from the same sources as the Windows app. The
Rust side was already portable (the LAN worker runs on Linux); what differs is
the webview, where the runtime is installed, and the packaging.

## Packages

`release.cmd` and `package.cmd` build the Linux app in WSL after the Windows
build, through `scripts/package-linux-app.sh`:

| Artifact | Install | Updates |
| --- | --- | --- |
| `Slopus-<version>-linux-x64.deb` | `sudo apt install ./Slopus-<version>-linux-x64.deb` | Settings offers the releases page |
| `Slopus-<version>-linux-x64.rpm` | `sudo dnf install ./Slopus-<version>-linux-x64.rpm` | Settings offers the releases page |
| `Slopus-<version>-linux-x64.AppImage` | `chmod +x` and run | In-app updater (signed, `linux-x86_64` in `latest.json`) |

The script reuses the frontend that the Windows build has just written to
`dist/` (it is platform independent, and WSL usually has no Linux Node.js), and
runs the Tauri CLI version pinned in `package-lock.json`, installed with cargo
into `~/.cache/slopus/tauri-cli-<version>` on first use. Cargo builds in
`~/.cache/slopus/linux-app-target`, on the Linux filesystem.

One-time WSL setup on Ubuntu (Rust as for the Linux worker):

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev build-essential file patchelf
```

`release.cmd` passes `TAURI_SIGNING_PRIVATE_KEY` (and its password) into WSL
through `WSLENV`; a Windows key path is translated with `wslpath`. Without a key,
`package.cmd` builds the same packages unsigned.

## Runtime layout

Platform resources live in `src-tauri/tauri.windows.conf.json` and
`src-tauri/tauri.linux.conf.json`, which Tauri merges over `tauri.conf.json`.
On Linux `libslopfab.so` is installed in Tauri's resource folder,
`/usr/lib/Slopus/` (inside the AppImage too). `default_dll_path` looks beside the
executable first, as on Windows and in development builds, and then in
`../lib/Slopus/`.

Generation has the same requirements as the Linux worker: an NVIDIA GPU with its
driver and CUDA 13 cuBLAS (`libcublas.so.13`), found in `/usr/local/cuda*` when
the system linker does not.

## WebKitGTK

Tauri uses WebKitGTK on Linux. Unlike WebView2, it ships WebCodecs and WebGPU
behind runtime feature flags. `src-tauri/src/linux_webview.rs` turns them on
(`WebCodecsVideoEnabled`, `WebCodecsAudioEnabled`, `WebCodecsAV1Enabled`,
`WebGPUEnabled`) with GPU compositing and WebGL, and reloads the page once so
the first document has them. The feature API needs WebKitGTK 2.42 or later; it is
looked up at run time, so older versions still start and the diagnostic log
names the missing features.

WebKitGTK decodes and encodes through GStreamer. The .deb and .rpm depend on the
base, good and bad plugin sets; `gstreamer1.0-libav` is recommended for H.264
on systems without a hardware VA-API decoder. The AppImage bundles GStreamer.

## Desktop integration

- The window stays frameless with the in-page title bar. Caption buttons are
  drawn as SVG, since the Segoe icon fonts exist only on Windows.
- "Show in Files" selects the item through the `org.freedesktop.FileManager1`
  D-Bus interface, and falls back to opening the folder with `xdg-open`.
- The Cut / Copy / Paste / Select all text menu runs WebKit's editing commands
  instead of replaying keystrokes.
- Mica, the Windows accent colour and rounded DWM corners are Windows only; the
  app uses its own palette and an opaque ground.
