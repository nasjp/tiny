#!/usr/bin/env python3
"""Compose App Store-style screenshot cards into one wide PNG (transparent background).

Used for the README hero image (docs/images/screenshots.png); the same cards can be
rendered one by one for the App Store listing. Requires Pillow (`pip install pillow`).

usage: compose_screenshots.py <out.png> <card spec>...
  card spec = "brand" | "<headline>|<screenshot.png>"

Capturing the screenshots: boot the iPhone 17 Pro simulator, run
`xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged --batteryLevel 100`,
launch the app with the `-DemoMode` argument (the demo session shows a tool run, a file
card, and "build it" / "question" trigger the permission banner / AskUserQuestion), and
save `XCUIScreen.main.screenshot().pngRepresentation` from a throwaway UI test.
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

APP_DIR = Path(__file__).resolve().parents[1]          # apps/ios/Tiny
FONT = APP_DIR / "Tiny/Resources/Fonts/Inter-Variable.ttf"
ICON = APP_DIR / "Tiny/Resources/Assets.xcassets/AppIcon.appiconset/icon.png"

CW, CH, R = 640, 1380, 56          # card size / corner radius
GAP = 36
CARD_BG = (0x2F, 0x2B, 0xBD, 255)  # Color.tTint (light)
TEXT = (255, 255, 255, 255)
TEXT_DIM = (255, 255, 255, 190)
SHOT_W = 476                       # the whole screenshot fits under the headline
SHOT_TOP = 286
SHOT_R = 40
PAD = 48


def font(size, weight=600, opsz=32):
    f = ImageFont.truetype(str(FONT), size)
    f.set_variation_by_axes([opsz, weight])
    return f


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def wrap_balanced(draw, text, f, max_w):
    """One line if it fits; otherwise the 2-line split with the most even widths."""
    if draw.textlength(text, font=f) <= max_w:
        return [text]
    words = text.split()
    best = None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        wa, wb = draw.textlength(a, font=f), draw.textlength(b, font=f)
        if max(wa, wb) > max_w:
            continue
        score = abs(wa - wb)
        if best is None or score < best[0]:
            best = (score, [a, b])
    return best[1] if best else [text]


def draw_centered(draw, lines, f, top, line_h, fill=TEXT):
    y = top
    for line in lines:
        w = draw.textlength(line, font=f)
        draw.text(((CW - w) / 2, y), line, font=f, fill=fill)
        y += line_h
    return y


def card_base():
    card = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    ImageDraw.Draw(card).rounded_rectangle([0, 0, CW - 1, CH - 1], radius=R, fill=CARD_BG)
    return card


def screenshot_card(headline, shot_path):
    card = card_base()
    draw = ImageDraw.Draw(card)
    f = font(54, 600)
    lines = wrap_balanced(draw, headline, f, CW - 2 * PAD)
    line_h = 66
    top = 84 if len(lines) > 1 else 116
    draw_centered(draw, lines, f, top, line_h)

    shot = Image.open(shot_path).convert("RGBA")
    h = round(shot.height * SHOT_W / shot.width)
    shot = rounded(shot.resize((SHOT_W, h), Image.LANCZOS), SHOT_R)
    card.alpha_composite(shot, ((CW - SHOT_W) // 2, SHOT_TOP))
    return card


def brand_card():
    card = card_base()
    draw = ImageDraw.Draw(card)

    size = 360
    icon = Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)
    icon = rounded(icon, int(size * 0.2237))   # iOS icon corner ratio
    card.alpha_composite(icon, ((CW - size) // 2, 230))

    tag_f = font(52, 600)
    lines = wrap_balanced(draw, "Your Mac's coding agents, in your pocket.", tag_f, CW - 2 * PAD)
    y = draw_centered(draw, lines, tag_f, 700, 64)

    sub_f = font(34, 500)
    draw_centered(draw, ["Claude Code · Codex", "OpenCode · Cursor"], sub_f, y + 60, 46, fill=TEXT_DIM)
    return card


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    out, specs = sys.argv[1], sys.argv[2:]
    cards = []
    for s in specs:
        if s == "brand":
            cards.append(brand_card())
        else:
            headline, path = s.split("|", 1)
            cards.append(screenshot_card(headline, path))
    W = len(cards) * CW + (len(cards) - 1) * GAP
    canvas = Image.new("RGBA", (W, CH), (0, 0, 0, 0))
    for i, c in enumerate(cards):
        canvas.alpha_composite(c, (i * (CW + GAP), 0))
    canvas.save(out, optimize=True)
    print(out, canvas.size)


if __name__ == "__main__":
    main()
