"""Generates the extension icons (icons/icon-{16,32,48,128}.png). Requires Pillow."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'icons')
os.makedirs(OUT, exist_ok=True)

TOP = (138, 107, 255)     # violet
BOTTOM = (255, 92, 168)   # pink


def make(size: int) -> Image.Image:
    s = size * 4  # supersample for smooth edges
    grad = Image.new('RGBA', (s, s))
    px = grad.load()
    for y in range(s):
        for x in range(s):
            t = (x + y) / (2 * s)
            px[x, y] = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)

    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=255)
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    w = max(int(s * 0.11), 2)
    # Double up-chevron ("upscale")
    for dy in (0.0, 0.22):
        y0 = s * (0.50 + dy)
        d.line([(s * 0.26, y0), (s * 0.50, y0 - s * 0.22), (s * 0.74, y0)],
               fill=(255, 255, 255, 255), width=w, joint='curve')
    # Sparkle (top-right) on larger sizes
    if size >= 32:
        cx, cy, r = s * 0.78, s * 0.22, s * 0.11
        d.polygon([(cx, cy - r), (cx + r * 0.28, cy - r * 0.28), (cx + r, cy),
                   (cx + r * 0.28, cy + r * 0.28), (cx, cy + r), (cx - r * 0.28, cy + r * 0.28),
                   (cx - r, cy), (cx - r * 0.28, cy - r * 0.28)], fill=(255, 255, 255, 235))
    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    path = os.path.join(OUT, f'icon-{size}.png')
    make(size).save(path)
    print('wrote', os.path.relpath(path, os.path.join(HERE, '..')), f'{size}x{size}')
