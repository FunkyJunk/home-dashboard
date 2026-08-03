#!/usr/bin/env python3
"""
label_calibration_target.py v3 - 4x6 printer registration target.

v3 exists because v1 and v2 both asked you to COUNT THIN LINES, and counting
thin lines is exactly what a thermal printer makes ambiguous. A line that
dropped out from low darkness looks identical to a line that got clipped by
the edge. That is a broken measurement.

v3 replaces every stack of nested rectangles with four STAIRCASES. Each stair
tread is a fat solid block whose outer face sits at a known mm inset, the
treads are spread out ALONG the edge so none of them touch, and each one has a
large numeral under it. You read a numeral. You do not count anything.

  Lowest numeral still fully printed on an edge = your safe margin for that edge.

Print at 100%. Turn OFF fit-to-page, scale-to-fit, shrink-oversized-pages.
"""

from PIL import Image, ImageDraw, ImageFont

DPI = 300
W, H = 4 * DPI, 6 * DPI
MM = DPI / 25.4
STEPS = [0, 1, 2, 3, 4, 5]
PITCH = 16.0      # mm between treads, along the edge
TREAD = 14.0      # mm length of each tread
THICK = 1.0       # mm thickness of each tread
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def px(mm):
    return mm * MM


def staircase(d, edge, font):
    """Fat treads stepping inward, spread along the edge, each with a numeral."""
    span = (len(STEPS) - 1) * PITCH
    centre = (101.6 if edge in ("top", "bottom") else 152.4) / 2
    start = centre - span / 2
    num_in = 9.0                       # numeral sits this far inside the edge
    for k in STEPS:
        along = start + k * PITCH
        a, b = px(along - TREAD / 2), px(along + TREAD / 2)
        o, t = px(k), px(THICK)
        if edge == "top":
            d.rectangle([a, o, b, o + t], fill=0)
            d.text((px(along), px(num_in)), str(k), font=font, fill=0, anchor="ma")
        elif edge == "bottom":
            d.rectangle([a, H - 1 - o - t, b, H - 1 - o], fill=0)
            d.text((px(along), H - 1 - px(num_in)), str(k), font=font, fill=0, anchor="md")
        elif edge == "left":
            d.rectangle([o, a, o + t, b], fill=0)
            d.text((px(num_in), px(along)), str(k), font=font, fill=0, anchor="lm")
        else:
            d.rectangle([W - 1 - o - t, a, W - 1 - o, b], fill=0)
            d.text((W - 1 - px(num_in), px(along)), str(k), font=font, fill=0, anchor="rm")


def build():
    img = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(img)
    f_xs = ImageFont.truetype(FONT, 24)
    f_sm = ImageFont.truetype(FONT, 30)
    f_num = ImageFont.truetype(FONT_B, 62)     # about 5 mm tall
    f_edge = ImageFont.truetype(FONT_B, 40)
    f_bg = ImageFont.truetype(FONT_B, 48)

    for e in ("top", "bottom", "left", "right"):
        staircase(d, e, f_num)

    cx, cy = W / 2, H / 2
    # Edge names, so there is never a question about which side you are reading
    d.text((cx, px(19)), "TOP", font=f_edge, fill=0, anchor="ma")
    d.text((cx, H - px(19)), "BOTTOM", font=f_edge, fill=0, anchor="md")
    d.text((px(19), cy), "LEFT", font=f_edge, fill=0, anchor="mm")
    d.text((W - px(19), cy), "RIGHT", font=f_edge, fill=0, anchor="mm")

    d.text((cx, px(29)), "4x6 REGISTRATION TARGET v3", font=f_bg, fill=0, anchor="ma")
    d.text((cx, px(36)), "4.000 x 6.000 in   |   101.6 x 152.4 mm",
           font=f_xs, fill=0, anchor="ma")

    # Solid ink patch for darkness
    d.rectangle([cx - px(20), px(43), cx + px(20), px(51)], fill=0)
    d.text((cx, px(52.5)), "must be solid, even black", font=f_xs, fill=0, anchor="ma")

    # Centre mark
    d.line([cx, cy - px(9), cx, cy + px(9)], fill=0, width=round(0.6 * MM))
    d.line([cx - px(9), cy, cx + px(9), cy], fill=0, width=round(0.6 * MM))
    d.text((cx, cy + px(11)), "TRUE CENTRE", font=f_sm, fill=0, anchor="ma")

    # 50 mm scale bar
    y = px(96)
    x0, x1 = cx - px(25), cx + px(25)
    d.rectangle([x0, y, x1, y + px(1.2)], fill=0)
    for x in (x0, x1):
        d.rectangle([x - px(0.7), y - px(3), x + px(0.7), y + px(4.5)], fill=0)
    d.text((cx, px(103)), "50.00 mm between end caps", font=f_sm, fill=0, anchor="ma")

    notes = [
        "PRINT AT 100%. No fit-to-page.",
        "Lowest numeral still FULLY printed on",
        "an edge is your safe margin, in mm,",
        "for that edge. Report all four.",
        "If a bar looks patchy, raise darkness.",
    ]
    for i, line in enumerate(notes):
        d.text((cx, px(112) + i * 34), line, font=f_xs, fill=0, anchor="ma")

    return img


if __name__ == "__main__":
    img = build()
    img.save("/mnt/user-data/outputs/label_calibration_target.png", dpi=(DPI, DPI))
    img.convert("RGB").save("/mnt/user-data/outputs/label_calibration_target.pdf",
                            resolution=DPI)
    print("written")
