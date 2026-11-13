#!/usr/bin/env python3
"""Write simple PWA icons without extra libraries."""
import struct, zlib
from pathlib import Path

def png(w, h, pixel):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            raw.extend(pixel(x, y))
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')

def icon(size):
    def pixel(x, y):
        cx = cy = (size - 1) / 2
        dx, dy = x - cx, y - cy
        r = (dx * dx + dy * dy) ** 0.5
        ring = size * 0.28
        if abs(r - ring) < size * 0.035 or r < size * 0.07:
            return (228, 181, 106, 255)
        if r < size * 0.46:
            return (18, 20, 26, 255)
        return (9, 10, 12, 255)
    return png(size, size, pixel)

root = Path(__file__).resolve().parents[1] / 'packages' / 'web' / 'public'
root.mkdir(parents=True, exist_ok=True)
(root / 'icon-192.png').write_bytes(icon(192))
(root / 'icon-512.png').write_bytes(icon(512))
print('wrote icons')
