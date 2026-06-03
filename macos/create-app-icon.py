#!/usr/bin/env python3
"""Create a simple team-calendar macOS .icns from pure-stdlib PNG iconset."""
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_DIR = ROOT / "build" / "macos"
ICONSET = BUILD_DIR / "AppIcon.iconset"
ICNS = BUILD_DIR / "AppIcon.icns"

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


def clamp(value: int) -> int:
    return max(0, min(255, value))


def blend(src, dst):
    sr, sg, sb, sa = src
    dr, dg, db, da = dst
    alpha = sa / 255
    out_a = alpha + da / 255 * (1 - alpha)
    if out_a == 0:
        return (0, 0, 0, 0)
    r = int((sr * alpha + dr * (da / 255) * (1 - alpha)) / out_a)
    g = int((sg * alpha + dg * (da / 255) * (1 - alpha)) / out_a)
    b = int((sb * alpha + db * (da / 255) * (1 - alpha)) / out_a)
    return (clamp(r), clamp(g), clamp(b), clamp(int(out_a * 255)))


def inside_round_rect(x, y, size, margin, radius):
    left = margin
    top = margin
    right = size - margin - 1
    bottom = size - margin - 1
    if left + radius <= x <= right - radius and top <= y <= bottom:
        return True
    if left <= x <= right and top + radius <= y <= bottom - radius:
        return True
    centers = [
        (left + radius, top + radius),
        (right - radius, top + radius),
        (left + radius, bottom - radius),
        (right - radius, bottom - radius),
    ]
    return any((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 for cx, cy in centers)


def png_bytes(width, height, pixels):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixels[y * width + x])

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def draw_icon(size):
    pixels = [(0, 0, 0, 0)] * (size * size)
    margin = max(2, size // 12)
    radius = max(4, size // 6)
    shadow_offset = max(1, size // 32)

    for y in range(size):
        for x in range(size):
            color = (0, 0, 0, 0)
            sx = x - shadow_offset
            sy = y - shadow_offset
            if inside_round_rect(sx, sy, size, margin, radius):
                color = (29, 27, 22, 80)
            if inside_round_rect(x, y, size, margin, radius):
                t = y / max(1, size - 1)
                color = (clamp(255 - int(12 * t)), clamp(184 - int(25 * t)), clamp(77 + int(40 * t)), 255)
            pixels[y * size + x] = color

    # Calendar page.
    page_margin = size // 5
    page_top = size // 4
    page_bottom = size - page_margin
    page_left = page_margin
    page_right = size - page_margin
    line = max(1, size // 42)
    for y in range(page_top, page_bottom):
        for x in range(page_left, page_right):
            if x < 0 or y < 0 or x >= size or y >= size:
                continue
            is_border = x < page_left + line or x >= page_right - line or y < page_top + line or y >= page_bottom - line
            is_header = y < page_top + max(3, size // 9)
            fill = (255, 250, 240, 255)
            if is_header:
                fill = (29, 27, 22, 255)
            if is_border:
                fill = (29, 27, 22, 255)
            pixels[y * size + x] = blend(fill, pixels[y * size + x])

    # Grid blocks.
    colors = [(125, 183, 255, 255), (146, 217, 135, 255), (255, 145, 184, 255), (182, 156, 255, 255)]
    cell_w = (page_right - page_left - line * 2) // 3
    cell_h = max(2, size // 11)
    start_y = page_top + max(4, size // 7)
    for i, c in enumerate(colors):
        x0 = page_left + line + (i % 2) * (cell_w + line * 2)
        y0 = start_y + (i // 2) * (cell_h + line * 2)
        w = cell_w + (cell_w // 2 if i == 1 else 0)
        for y in range(y0, min(page_bottom - line, y0 + cell_h)):
            for x in range(x0, min(page_right - line, x0 + w)):
                pixels[y * size + x] = blend(c, pixels[y * size + x])

    return png_bytes(size, size, pixels)


def main():
    if ICONSET.exists():
        shutil.rmtree(ICONSET)
    ICONSET.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        data = draw_icon(size)
        for name in ICONSET_NAMES[size]:
            (ICONSET / name).write_bytes(data)

    iconutil = shutil.which("iconutil")
    if iconutil:
        if ICNS.exists():
            ICNS.unlink()
        subprocess.run([iconutil, "-c", "icns", str(ICONSET), "-o", str(ICNS)], check=True)
    else:
        print("iconutil not found; generated PNG iconset only", file=sys.stderr)


if __name__ == "__main__":
    main()
