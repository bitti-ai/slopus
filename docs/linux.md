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
into `~/.cache/slopus/glibc235/tauri-cli-<version>` on first use. Cargo builds in
`~/.cache/slopus/glibc235/linux-app-target`, on the Linux filesystem. These paths
are separate from caches built against newer distributions.

## glibc baseline

Linux packages target **glibc 2.35**, the Ubuntu 22.04 baseline. The Windows
packaging commands select WSL `Ubuntu-22.04`; install it with
`wsl --install -d Ubuntu-22.04`. `SLOPUS_WSL_DISTRO` can select another WSL
distribution with glibc <=2.35. Native packaging rejects newer build hosts.
This follows [Tauri's AppImage guidance](https://tauri.app/distribute/appimage/):
the app and its GTK/WebKit/GStreamer dependencies must be built on the oldest
supported base system, since AppImage uses the host's glibc.

Rebuild `lib/slopfab/libslopfab.so` on that baseline too, using slopfab's
`tools/linux-build.Dockerfile` (CUDA 13) or Ubuntu 22.04 with CUDA 13, and copy
`dist/linux/libslopfab.so` here before packaging. The old runtime built on
Ubuntu 26.04 requires glibc 2.43 and is rejected before Cargo starts.
Changing version strings or replacing only the app executable does not fix
incompatible bundled libraries.

One-time WSL setup on Ubuntu 22.04 (install Rust as for the Linux worker):

```sh
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libxdo-dev libssl-dev build-essential file patchelf squashfs-tools \
  python3 binutils pkg-config gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad
```

An isolated build is also available through Docker in Linux/WSL. Build the
frontend first with `npm ci && npm run build`, then, after replacing slopfab:

```sh
docker build -t slopus-linux-glibc235 -f scripts/linux/build.Dockerfile scripts/linux
docker run --rm -v "$PWD:/src" -v slopus-linux-glibc235:/root/.cache \
  slopus-linux-glibc235 bash scripts/package-linux-app.sh 0.4.0 artifacts
docker run --rm -v "$PWD:/src" -v slopus-linux-glibc235:/root/.cache \
  slopus-linux-glibc235 bash scripts/package-linux-worker.sh 0.4.0 artifacts/Slopus-0.4.0-linux-x64-worker.tar.gz
```

Use the checkout's version in both commands. For signed builds pass
`-e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; if the key
is a file, mount it read-only and set the variable to its path inside the
container. The toolkit libraries are available for dependency discovery but
are excluded from the package as before.

Before publishing, `scripts/linux/check_glibc.py` checks the AppImage runtime
and **every ELF file in the extracted image**, including weak requirements,
and rejects anything above 2.35. It also checks worker artifacts. Run its
regressions with `python3 -m unittest discover -s scripts/linux -p test_check_glibc.py`.
GPU drivers and webview capabilities remain separate requirements; the older
distribution's WebKitGTK/GStreamer capabilities need functional validation.

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
Before packaging, the plugin makes the AppDir readable and traversable by all
users and explicitly enables execution of its launchers. The package script
uses umask 022 for linuxdeploy's final wrapper and checks permissions again in
the extracted AppImage, catching restrictive cached launchers such as mode 0770.
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
