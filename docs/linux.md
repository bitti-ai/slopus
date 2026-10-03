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

The bundled `libslopfab.so` directly links NVIDIA's driver library
(`libcuda.so.1`) and CUDA 13 cuBLAS (`libcublas.so.13`). Both must be installed
for the runtime to load, even when generation uses Vulkan. The Linux worker
supports `--backend vulkan`; this selects Vulkan for computation but does not
remove those library dependencies. Slopus also searches `/usr/local/cuda*` for
cuBLAS when the system linker cannot find it.

## WebKitGTK

Tauri uses WebKitGTK on Linux. Unlike WebView2, it ships WebGPU switched off
(WebKitGTK 2.52 has WebCodecs on, but older releases do not), so
`src-tauri/src/linux_webview.rs` turns on the `WebCodecsVideo`,
`WebCodecsAudio`, `WebCodecsAV1` and `WebGPU` feature flags, with GPU
compositing and WebGL, and reloads the page once so the first document has
them. The feature API needs WebKitGTK 2.42 or later; it is looked up at run
time, so older versions still start. The diagnostic log records the result
(`app webview`, listing every GPU and codec flag when one is missing), and the
frontend's `webview ready` entry records whether `VideoDecoder`,
`VideoEncoder`, `AudioDecoder` and `navigator.gpu` exist.

WebKitGTK decodes and encodes through GStreamer. The .deb and .rpm depend on the
system's base, good and bad plugin sets (which include VA-API and NVIDIA
hardware codecs) and recommend `gstreamer1.0-libav`, which the user's
distribution provides.

The AppImage bundles GStreamer, but only an allowlist of plugins:
`scripts/linux/linuxdeploy-plugin-gstreamer.sh` replaces the plugin the Tauri
CLI would download, which copies every plugin on the build machine, FFmpeg
(gst-libav) and GPL encoders included. Hardware H.264/HEVC/AV1 goes through
VA-API and NVIDIA's driver (`va`, `nvcodec`); VP8/VP9/AV1/Opus have software
codecs. The same plugin removes NVIDIA cuBLAS, which linuxdeploy would otherwise
copy in (over 500 MB) through `libslopfab.so`. After building,
`package-linux-app.sh` fails if FFmpeg, x264/x265 or cuBLAS is in the AppImage.
AAC audio needs a decoder the AppImage does not ship; the .deb and .rpm use the
system's.

## Desktop integration

- The window stays frameless with the in-page title bar. Caption buttons are
  drawn as SVG, since the Segoe icon fonts exist only on Windows.
- "Show in Files" selects the item through the `org.freedesktop.FileManager1`
  D-Bus interface, and falls back to opening the folder with `xdg-open`.
- The Cut / Copy / Paste / Select all text menu runs WebKit's editing commands
  instead of replaying keystrokes.
- Mica, the Windows accent colour and rounded DWM corners are Windows only; the
  app uses its own palette and an opaque ground.
