#!/usr/bin/env python3
"""Build AppIcon.iconset and AppIcon.icns from the checked-in 1024x1024 source PNG."""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build" / "macos"
ICONSET = BUILD_DIR / "AppIcon.iconset"
ICNS = BUILD_DIR / "AppIcon.icns"
SOURCE_IMAGE = ROOT / "macos" / "AppIcon-source.png"

SIZES = [16, 32, 64, 128, 256, 512, 1024]
ICONSET_NAMES = {
    16: ["icon_16x16.png"],
    32: ["icon_16x16@2x.png", "icon_32x32.png"],
    64: ["icon_32x32@2x.png"],
    128: ["icon_128x128.png"],
    256: ["icon_128x128@2x.png", "icon_256x256.png"],
    512: ["icon_256x256@2x.png", "icon_512x512.png"],
    1024: ["icon_512x512@2x.png"],
}


def resize_png(source: Path, destination: Path, size: int):
    subprocess.run(
        ["sips", "-z", str(size), str(size), str(source), "--out", str(destination)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main():
    if not SOURCE_IMAGE.exists():
        print(f"missing icon source: {SOURCE_IMAGE}", file=sys.stderr)
        sys.exit(1)

    if ICONSET.exists():
        shutil.rmtree(ICONSET)
    ICONSET.mkdir(parents=True, exist_ok=True)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    for size in SIZES:
        temp_output = ICONSET / f"tmp-{size}.png"
        resize_png(SOURCE_IMAGE, temp_output, size)
        for name in ICONSET_NAMES[size]:
            shutil.copyfile(temp_output, ICONSET / name)
        temp_output.unlink()

    iconutil = shutil.which("iconutil")
    if iconutil:
        if ICNS.exists():
            ICNS.unlink()
        subprocess.run([iconutil, "-c", "icns", str(ICONSET), "-o", str(ICNS)], check=True)
    else:
        print("iconutil not found; generated PNG iconset only", file=sys.stderr)


if __name__ == "__main__":
    main()
