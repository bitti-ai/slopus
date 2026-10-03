#!/usr/bin/env bash
# Builds the Linux desktop app and its packages: .deb, .rpm and AppImage.
#
#   bash scripts/package-linux-app.sh <version> <artifacts-dir>
#
# Runs on x86_64 Linux, including WSL, where package.cmd and release.cmd call
# it after their Windows build. The frontend in dist/ is platform independent,
# so it is reused rather than rebuilt (WSL usually has no Linux Node.js); the
# Tauri CLI comes from cargo. Cargo builds on the Linux filesystem, as in
# package-linux-worker.sh.
#
# With TAURI_SIGNING_PRIVATE_KEY set (a key, a Linux path or a Windows path)
# the AppImage is signed for the updater and its .sig is written beside it.
# Without one the packages are built unsigned and the AppImage cannot be
# offered as an update.
set -euo pipefail

if (($# != 2)); then
  printf 'Usage: bash %s <version> <artifacts-dir>\n' "$0" >&2
  exit 2
fi
version=$1
artifacts=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
fail() { printf 'package-linux-app: %s\n' "$*" >&2; exit 1; }

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf 'package-linux-app: run on x86_64 Linux (including WSL).\n' >&2
  exit 2
fi
# rustup installs into ~/.cargo; a non-login WSL shell has not sourced it.
if ! command -v cargo >/dev/null && [[ -f $HOME/.cargo/env ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
fi
command -v cargo >/dev/null || fail 'cargo was not found. Install Rust in this Linux environment:
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'

# Tauri's Linux build libraries, and the tools the bundler shells out to.
missing=()
for module in webkit2gtk-4.1 gtk+-3.0 librsvg-2.0 ayatana-appindicator3-0.1; do
  pkg-config --exists "$module" 2>/dev/null || missing+=("$module")
done
for tool in file patchelf; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
  fail "missing build dependencies: ${missing[*]}. On Ubuntu or Debian install them with:
  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential file patchelf"
fi

runtime="$root/lib/slopfab/libslopfab.so"
if [[ $(head -c 4 "$runtime" 2>/dev/null | od -An -c | tr -d ' ') != '177ELF' ]]; then
  fail "$runtime is missing or a Git LFS pointer. Run git lfs pull."
fi

cargo_version=$(sed -n '/^\[workspace.package\]/,/^\[/s/^version *= *"\(.*\)"/\1/p' "$root/src-tauri/Cargo.toml")
[[ $cargo_version == "$version" ]] || fail "version $version does not match src-tauri/Cargo.toml ($cargo_version)."

# The Windows build ran `npm run build` moments ago; refuse a missing frontend
# rather than embed an old one silently.
[[ -f $root/dist/index.html ]] || fail 'dist/ has no built frontend. Run npm run build first (package.cmd does).'
asset=$(find "$root/dist/assets" -maxdepth 1 -name '*.js' -printf '%f\n' 2>/dev/null | head -n 1)
[[ -n $asset ]] || fail 'dist/assets has no JavaScript bundle.'

# The same CLI version as package-lock.json, installed once per version.
cli_version=$(sed -n '/"node_modules\/@tauri-apps\/cli": {/,/}/s/.*"version": "\(.*\)".*/\1/p' "$root/package-lock.json" | head -n 1)
[[ -n $cli_version ]] || fail 'could not read the @tauri-apps/cli version from package-lock.json.'
tools="$HOME/.cache/slopus/tauri-cli-$cli_version"
if [[ ! -x $tools/bin/cargo-tauri ]]; then
  printf 'package-linux-app: installing tauri-cli %s (once)...\n' "$cli_version"
  cargo install tauri-cli --version "=$cli_version" --locked --root "$tools"
fi

config='{"build":{"beforeBuildCommand":""}}'
if [[ -n ${TAURI_SIGNING_PRIVATE_KEY:-} ]]; then
  # release.cmd passes the Windows path of the key file through WSLENV.
  if [[ $TAURI_SIGNING_PRIVATE_KEY =~ ^[A-Za-z]:[\\/] ]] && command -v wslpath >/dev/null; then
    TAURI_SIGNING_PRIVATE_KEY=$(wslpath -u "$TAURI_SIGNING_PRIVATE_KEY")
    export TAURI_SIGNING_PRIVATE_KEY
  fi
  signed=1
else
  config='{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'
  signed=0
fi

target_dir=${SLOPUS_LINUX_TARGET_DIR:-"$HOME/.cache/slopus/linux-app-target"}
bundle="$target_dir/release/bundle"
rm -rf -- "$bundle"
(
  cd -- "$root"
  # The AppImage tools are themselves AppImages; WSL has no FUSE to mount them.
  CARGO_TARGET_DIR=$target_dir APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=true \
    "$tools/bin/cargo-tauri" build --ci --bundles deb,rpm,appimage --config "$config"
)

binary="$target_dir/release/slopus"
grep -qF -- "${asset%.js}" "$binary" \
  || fail "the executable does not contain the built frontend ($asset). It would load the dev server."

pick() { find "$bundle/$1" -maxdepth 1 -type f -name "$2" -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-; }
deb=$(pick deb '*.deb')
rpm=$(pick rpm '*.rpm')
appimage=$(pick appimage '*.AppImage')
[[ -n $deb && -n $rpm && -n $appimage ]] || fail "expected a .deb, .rpm and AppImage under $bundle."

stem="Slopus-$version-linux-x64"
mkdir -p -- "$artifacts"
rm -f -- "$artifacts/$stem".{deb,rpm,AppImage,AppImage.sig}
cp -- "$deb" "$artifacts/$stem.deb"
cp -- "$rpm" "$artifacts/$stem.rpm"
cp -- "$appimage" "$artifacts/$stem.AppImage"
chmod 0755 "$artifacts/$stem.AppImage"
if ((signed)); then
  [[ -s $appimage.sig ]] || fail "the AppImage was not signed: $appimage.sig is missing."
  cp -- "$appimage.sig" "$artifacts/$stem.AppImage.sig"
fi
printf 'package-linux-app: wrote %s.{deb,rpm,AppImage}%s\n' "$artifacts/$stem" "$( ((signed)) && printf ' and the AppImage signature')"
