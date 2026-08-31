#!/usr/bin/env python3
"""Generate the tiny icon v1 (programmatic, 1024px, no lettering).

A deep-teal-to-near-black gradient ground with a terminal-style ">" prompt +
cursor (rounded rectangle). Shapes only, no lettering. To avoid clashing with the
probes apps' palettes (wisteria, gold, teal, amber, lawn green, rose, indigo),
diverge with a near-black deep teal ground + a vivid spring-green prompt.
Usage: python3 store/make_icon.py
Output: ../Tiny/Resources/Assets.xcassets/AppIcon.appiconset/icon.png
"""
from pathlib import Path

from PIL import Image, ImageDraw

S = 1024
SS = 4
N = S * SS

BG_TOP = (14, 38, 42)      # deep teal
BG_BOTTOM = (4, 10, 12)    # near black
PROMPT = (92, 240, 154)    # terminal prompt (spring green)
CURSOR = (92, 240, 154)    # cursor (same hue, layered slightly lighter)


def px(v: float) -> float:
    return v * SS


def gradient_background() -> Image.Image:
    img = Image.new("RGB", (1, S), BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(S):
        t = y / (S - 1)
        d.point((0, y), fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    return img.resize((N, N), Image.BICUBIC)


def rounded_line(d: ImageDraw.ImageDraw, p1, p2, width: float, fill) -> None:
    """Thick line with rounded ends (PIL's line has square corners, so add circles at the ends)."""
    d.line([p1, p2], fill=fill, width=int(width))
    r = width / 2
    for p in (p1, p2):
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)


def prompt_glyph() -> Image.Image:
    """Terminal-style ">" prompt + rounded-rectangle cursor."""
    layer = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    stroke_w = px(92)
    apex = (px(636), px(512))
    top = (px(352), px(320))
    bottom = (px(352), px(704))

    rounded_line(d, top, apex, stroke_w, PROMPT)
    rounded_line(d, apex, bottom, stroke_w, PROMPT)

    # Cursor (rounded rectangle, right of the prompt)
    cx0, cy0 = px(716), px(452)
    cx1, cy1 = px(792), px(572)
    d.rounded_rectangle([cx0, cy0, cx1, cy1], radius=px(18), fill=CURSOR)

    return layer


def main() -> None:
    img = gradient_background().convert("RGBA")
    img = Image.alpha_composite(img, prompt_glyph())
    out = img.convert("RGB").resize((S, S), Image.LANCZOS)
    dest = (
        Path(__file__).resolve().parent.parent
        / "Tiny/Resources/Assets.xcassets/AppIcon.appiconset/icon.png"
    )
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.save(dest, format="PNG")
    print(f"wrote {dest} {out.size}")


if __name__ == "__main__":
    main()
