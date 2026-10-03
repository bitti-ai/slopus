#!/usr/bin/env bash
# Slopus's linuxdeploy GStreamer plugin, used in place of the one the Tauri
# CLI downloads (package-linux-app.sh puts it in Tauri's local tools folder).
#
# The upstream plugin copies every GStreamer plugin on the build machine into
# the AppImage. On a typical Ubuntu that includes gst-libav, which drags in
# FFmpeg, GPL encoders such as x265, ONNX Runtime and TensorFlow Lite. Slopus
# ships no FFmpeg (AGENTS.md), so this copies an allowlist instead: what
# WebKitGTK needs for media playback, Web Audio and WebCodecs, with hardware
# H.264/HEVC/AV1 through VA-API and NVIDIA's driver (va, nvcodec) and
# royalty-free VP8/VP9/AV1/Opus software codecs.
#
# It also removes NVIDIA cuBLAS, which linuxdeploy finds through
# libslopfab.so's dependencies. The CUDA libraries belong to the user's CUDA
# installation, as for the .deb, the .rpm and the Linux worker; bundled they
# are over 500 MB and tied to the build machine's toolkit.
#
# Plugin API 0, as upstream: linuxdeploy runs it with --appdir and $LINUXDEPLOY.
set -euo pipefail

ALLOWED_PLUGINS=(
  # Core, pipelines and type detection
  coreelements app playback typefindfunctions autodetect gio pbtypes encoding
  # Audio
  audioconvert audioresample audiorate audioparsers volume interleave audiomixer
  wavparse flac opus opusparse vorbis ogg mpg123 id3demux apetag pulseaudio
  # Video
  videoconvertscale videorate videofilter videoparsersbad codecalpha
  codectimestamper opengl alpha
  # Containers
  isomp4 matroska
  # Codecs: hardware through the system driver, royalty-free in software
  va nvcodec vpx aom dav1d svtav1
)

# linuxdeploy finds these through libslopfab.so; the user's CUDA provides them.
EXCLUDED_LIBRARIES=(libcublas.so* libcublasLt.so*)

appdir=""
while (($#)); do
  case $1 in
    --plugin-api-version) echo 0; exit 0 ;;
    --appdir) appdir=$2; shift 2 ;;
    --help) printf 'Usage: %s --appdir <AppDir>\n' "$0"; exit 0 ;;
    *) printf 'Invalid argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ -n $appdir ]] || { printf 'Usage: %s --appdir <AppDir>\n' "$0" >&2; exit 1; }
[[ -n ${LINUXDEPLOY:-} ]] || { echo 'Error: $LINUXDEPLOY not set' >&2; exit 3; }
command -v patchelf >/dev/null || { echo 'Error: patchelf not found' >&2; exit 2; }

arch_dir=/usr/lib/$(uname -m)-linux-gnu
plugins_dir=${GSTREAMER_PLUGINS_DIR:-$arch_dir/gstreamer-1.0}
helpers_dir=${GSTREAMER_HELPERS_DIR:-$arch_dir/gstreamer1.0/gstreamer-1.0}
[[ -d $plugins_dir ]] || { echo "Error: could not find plugins directory: $plugins_dir" >&2; exit 1; }

plugins_target="$appdir/usr/lib/gstreamer-1.0"
helpers_target="$appdir/usr/lib/gstreamer1.0/gstreamer-1.0"
mkdir -p "$plugins_target" "$helpers_target" "$appdir/apprun-hooks"

for name in "${ALLOWED_PLUGINS[@]}"; do
  plugin="$plugins_dir/libgst$name.so"
  if [[ -f $plugin ]]; then
    cp "$plugin" "$plugins_target/"
  else
    echo "Note: GStreamer plugin $name is not installed; skipping it."
  fi
done
for helper in gst-plugin-scanner gst-ptp-helper; do
  [[ -f $helpers_dir/$helper ]] && cp "$helpers_dir/$helper" "$helpers_target/"
done

# Deploy the plugins' own dependencies, then point them at the AppImage's libs.
"$LINUXDEPLOY" --appdir "$appdir"
for file in "$plugins_target"/*; do
  patchelf --set-rpath '$ORIGIN/..:$ORIGIN' "$file"
done
for file in "$helpers_target"/*; do
  patchelf --set-rpath '$ORIGIN/../..' "$file"
done

for pattern in "${EXCLUDED_LIBRARIES[@]}"; do
  find "$appdir/usr/lib" -maxdepth 1 -name "$pattern" -print -delete
done

cat > "$appdir/apprun-hooks/linuxdeploy-plugin-gstreamer.sh" <<'EOF'
#! /bin/bash

export GST_REGISTRY_REUSE_PLUGIN_SCANNER="no"
export GST_PLUGIN_SYSTEM_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"
export GST_PLUGIN_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"

export GST_PLUGIN_SCANNER_1_0="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
export GST_PTP_HELPER_1_0="${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-ptp-helper"
EOF
