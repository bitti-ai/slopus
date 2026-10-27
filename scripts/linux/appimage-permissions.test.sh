#!/usr/bin/env bash
# Run on Linux; run as root to also exercise launch as the unrelated nobody user.
# Set SLOPUS_TEST_APPIMAGE_PLUGIN to linuxdeploy-plugin-appimage.AppImage to
# additionally verify a real packaged image without building the desktop app.
set -euo pipefail
umask 077
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
fixture=$(mktemp -d /tmp/slopus-appimage-permissions.XXXXXXXX)
trap 'rm -rf -- "$fixture"' EXIT
appdir="$fixture/Test AppDir"
mkdir -p "$appdir/usr/bin" "$appdir/usr/share" "$fixture/bin" "$fixture/plugins" "$fixture/helpers"
chmod 0755 "$fixture"
printf 'readable resource\n' > "$appdir/usr/share/message"
cat > "$appdir/usr/bin/slopus" <<'EOF'
#!/bin/sh
cat "$(dirname "$0")/../share/message"
EOF
cat > "$appdir/AppRun" <<'EOF'
#!/bin/sh
exec "$(dirname "$0")/AppRun.wrapped" "$@"
EOF
cat > "$appdir/AppRun.wrapped" <<'EOF'
#!/bin/sh
exec "$(dirname "$0")/usr/bin/slopus" "$@"
EOF
cat > "$appdir/slopus.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Slopus permission test
Exec=slopus
Icon=slopus
Categories=AudioVideo;
EOF
printf '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>\n' > "$appdir/slopus.svg"
# Simulate a root-owned 0770 cached launcher, private dirs, and a launcher
# missing execute bits entirely. Data must become readable, not executable.
chmod -R 0770 "$appdir"
chmod 0640 "$appdir/slopus.desktop" "$appdir/slopus.svg"
chmod 0640 "$appdir/usr/share/message"
chmod 0600 "$appdir/AppRun"
printf 'plugin fixture\n' > "$fixture/plugins/libgstcoreelements.so"
printf '#!/bin/sh\nexit 0\n' > "$fixture/helpers/gst-plugin-scanner"
printf '#!/bin/sh\nexit 0\n' > "$fixture/helpers/gst-ptp-helper"
chmod 0700 "$fixture/helpers/"*
# Isolate dependency discovery and ELF patching; exercise the real deployment
# plugin, including its permission fix at the end of staging.
printf '#!/bin/sh\nexit 0\n' > "$fixture/bin/linuxdeploy"
printf '#!/bin/sh\nexit 0\n' > "$fixture/bin/patchelf"
chmod 0755 "$fixture/bin/"*
PATH="$fixture/bin:$PATH" LINUXDEPLOY="$fixture/bin/linuxdeploy" \
  GSTREAMER_PLUGINS_DIR="$fixture/plugins" GSTREAMER_HELPERS_DIR="$fixture/helpers" \
  bash "$root/scripts/linux/linuxdeploy-plugin-gstreamer.sh" --appdir "$appdir" > "$fixture/plugin.log"
bad=$(find "$appdir" \( \( -type d ! -perm -0005 \) -o \( -type f \( ! -perm -0004 -o \( -perm /0111 ! -perm -0001 \) \) \) \) -print)
[[ -z $bad ]] || { printf 'Inaccessible files: %s\n' "$bad" >&2; exit 1; }
for launcher in AppRun AppRun.wrapped usr/bin/slopus; do
  [[ -n $(find "$appdir/$launcher" -maxdepth 0 -perm -0005 -print) ]]
done
[[ ! -x $appdir/usr/share/message ]]
if [[ $(id -u) == 0 ]]; then
  [[ $(runuser -u nobody -- "$appdir/AppRun") == 'readable resource' ]]
  echo 'PASS: root-owned AppDir launches and reads resources as nobody'
else
  [[ $("$appdir/AppRun") == 'readable resource' ]]
  echo 'PASS: AppDir mode bits allow unrelated users to read and execute'
fi

if [[ -n ${SLOPUS_TEST_APPIMAGE_PLUGIN:-} ]]; then
  image="$fixture/permissions.AppImage"
  APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 OUTPUT="$image" \
    "$SLOPUS_TEST_APPIMAGE_PLUGIN" --appdir "$appdir" > "$fixture/packaging.log" 2>&1 \
    || { cat "$fixture/packaging.log" >&2; exit 1; }
  chmod a+rx "$image"
  mkdir "$fixture/extracted"
  chmod 0755 "$fixture/extracted"
  extracted="$fixture/extracted/squashfs-root"
  unsquashfs -no-progress -offset "$("$image" --appimage-offset)" -d "$extracted" "$image" >/dev/null
  if [[ $(id -u) == 0 ]]; then
    [[ $(runuser -u nobody -- "$extracted/AppRun") == 'readable resource' ]]
    echo 'PASS: packaged AppImage launches as nobody after extraction'
  else
    [[ $("$extracted/AppRun") == 'readable resource' ]]
    echo 'PASS: packaged AppImage launches after extraction'
  fi
fi
