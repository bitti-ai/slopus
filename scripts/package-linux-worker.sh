#!/usr/bin/env bash
# Builds the Linux LAN worker and packs it with the Linux SlopFab runtime.
#
#   bash scripts/package-linux-worker.sh <version> <output.tar.gz>
#
# Runs on Linux, including WSL, where package.cmd and release.cmd call it. The
# worker crate depends only on slopus-core, so no UI libraries are needed to
# build or run it. Cargo builds on the Linux filesystem: a Windows checkout
# mounted under /mnt cannot hold ELF permissions and is slow to compile on.
set -euo pipefail

if (($# != 2)); then
  printf 'Usage: bash %s <version> <output.tar.gz>\n' "$0" >&2
  exit 2
fi
version=$1
output=$2
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf 'package-linux-worker: run on x86_64 Linux (including WSL).\n' >&2
  exit 2
fi
# rustup installs into ~/.cargo; a non-login WSL shell has not sourced it.
if ! command -v cargo >/dev/null && [[ -f $HOME/.cargo/env ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null; then
  printf 'package-linux-worker: cargo was not found. Install Rust in this Linux environment:\n' >&2
  printf '  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal\n' >&2
  exit 1
fi

runtime="$root/lib/slopfab/libslopfab.so"
if [[ $(head -c 4 "$runtime" 2>/dev/null | od -An -c | tr -d ' ') != '177ELF' ]]; then
  printf 'package-linux-worker: %s is missing or a Git LFS pointer. Run git lfs pull.\n' "$runtime" >&2
  exit 1
fi

target_dir=${SLOPUS_LINUX_TARGET_DIR:-"$HOME/.cache/slopus/linux-worker-target"}
CARGO_TARGET_DIR=$target_dir cargo build --release --locked \
  --manifest-path "$root/src-tauri/Cargo.toml" -p slopus-worker

# A Windows checkout has CRLF line endings; keep the \r out of the comparison.
cargo_version=$(sed -n '/^\[workspace.package\]/,/^\[/s/^version *= *"\(.*\)"/\1/p' "$root/src-tauri/Cargo.toml" | tr -d '\r')
if [[ $cargo_version != "$version" ]]; then
  printf 'package-linux-worker: version %s does not match src-tauri/Cargo.toml (%s).\n' "$version" "$cargo_version" >&2
  exit 1
fi

stage=$(mktemp -d /tmp/slopus-linux-worker.XXXXXXXX)
trap 'rm -rf -- "$stage"' EXIT
name="Slopus-$version-linux-x64-worker"
package="$stage/$name"
mkdir -p "$package"
install -m 0755 "$target_dir/release/slopus-worker" "$package/slopus-worker"
install -m 0755 "$runtime" "$package/libslopfab.so"
cat > "$package/README.txt" <<EOF
Slopus worker $version (linux-x64)

Run ./slopus-worker to let Slopus generate on this computer over the local network.
Slopus finds it automatically; choose it in Settings, Workers. Open TCP port 47321
(or the --port you choose) and UDP port 5353 (mDNS) in the firewall.
Keep libslopfab.so beside slopus-worker.

REQUIREMENTS
  x86_64 Linux with glibc, an NVIDIA GPU, the NVIDIA driver (libcuda.so.1) and
  CUDA 13 cuBLAS (libcublas.so.13). The worker finds cuBLAS in /usr/local/cuda*
  if the system linker does not. The Vulkan backend (--backend vulkan) also needs
  the NVIDIA driver and cuBLAS, because the runtime links them. FFmpeg 8 shared
  libraries enable video references.

WEIGHTS
  Weights with download links are downloaded here on first use. Add folders that
  already hold Slopus downloads with --weights. Other model files are sent from Slopus.

Run ./slopus-worker --help for options such as --port, --token, --weights and --backend.
EOF
mkdir -p -- "$(dirname -- "$output")"
tar -C "$stage" --owner=0 --group=0 -czf "$stage/$name.tar.gz" "$name"
cp -- "$stage/$name.tar.gz" "$output"
printf 'package-linux-worker: wrote %s\n' "$output"
