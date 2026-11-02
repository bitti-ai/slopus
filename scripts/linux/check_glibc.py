#!/usr/bin/env python3
"""Reject Linux release artifacts requiring a glibc newer than Ubuntu 22.04."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

BASELINE = (2, 35)


def requirements(output):
    # Definitions describe exported versions, not requirements. Include weak
    # version needs too: the loader can warn about these before main() runs.
    needed = False
    for line in output.splitlines():
        if line.startswith("Version "):
            needed = line.startswith("Version needs section")
        if needed:
            yield from re.findall(r"Name: (GLIBC_\S+)", line)


def unsupported(version):
    suffix = version.removeprefix("GLIBC_")
    if not re.fullmatch(r"\d+(?:\.\d+)+", suffix):
        # GLIBC_ABI_DT_RELR (2.36) and private/unknown ABIs are not portable.
        return True
    parts = tuple(map(int, suffix.split(".")))
    return parts > BASELINE + (0,) * max(0, len(parts) - len(BASELINE))


def check_host():
    value = os.confstr("CS_GNU_LIBC_VERSION")
    if not value or unsupported("GLIBC_" + value.split()[-1]):
        raise ValueError(
            f"build host uses {value}; release builds require glibc <= 2.35. "
            "Use Ubuntu 22.04 (WSL Ubuntu-22.04 or the Linux build container) "
            "and a fresh build directory."
        )
    print(f"glibc: build host {value} meets the 2.35 baseline")


def check_paths(paths):
    count = 0
    failures = []
    for argument in paths:
        root = Path(argument)
        if not root.exists():
            raise ValueError(f"missing artifact: {root}")
        candidates = sorted(root.rglob("*")) if root.is_dir() else [root]
        root_count = 0
        for path in candidates:
            if not path.is_file():
                continue
            with path.open("rb") as stream:
                if stream.read(4) != b"\x7fELF":
                    continue
            result = subprocess.run(
                ["readelf", "--wide", "--version-info", str(path)],
                check=True, text=True, capture_output=True,
                env={**os.environ, "LC_ALL": "C"},
            )
            root_count += 1
            bad = sorted({v for v in requirements(result.stdout) if unsupported(v)})
            if bad:
                failures.append(f"{path}: {', '.join(bad)}")
        if not root_count:
            raise ValueError(f"no ELF files found in {root}")
        count += root_count
    if failures:
        raise ValueError("requires newer/unsupported glibc (maximum 2.35):\n" + "\n".join(failures))
    print(f"glibc: checked {count} ELF files; all requirements <= 2.35")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-host", action="store_true")
    parser.add_argument("paths", nargs="*")
    args = parser.parse_args()
    if not args.check_host and not args.paths:
        parser.error("provide --check-host or artifact files/directories")
    try:
        if args.check_host:
            check_host()
        if args.paths:
            check_paths(args.paths)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"glibc: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
