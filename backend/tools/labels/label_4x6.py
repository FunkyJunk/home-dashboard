#!/usr/bin/env python3
"""
label_4x6.py v3 - Normalize a shipping label image to a print-ready 4x6 @ 300 DPI.

Pipeline: load -> auto-rotate upright -> crop to the outer frame -> scale to the
margin box -> re-threshold -> compose on a true 1200x1800 canvas -> save with
correct DPI metadata.

Geometry that depends on YOUR printer lives in PrinterProfile, not in the
algorithm. Measure it with label_calibration_target.py rather than guessing.

Usage:
  python label_4x6.py in.png -o out.png --pdf out.pdf --verify
  python label_4x6.py in.png -o out.png --margin-mm 2.5 --offset-x-mm 0.45
"""

import argparse
import sys

from typing import NamedTuple

import numpy as np
from PIL import Image, ImageOps

DPI = 300
DARK = 128            # ink cutoff for solid black structure
LOOSE = 200           # ink cutoff that also catches light/dashed rules
RULE_DENSITY = 0.80   # solid full-width rule
FRAME_DENSITY = 0.30  # dashed border survives this; body text does not
REBINARIZE = 160      # post-resample threshold
PORTRAIT_RANGE = (0.50, 0.85)   # plausible w/h for an upright shipping label
SOLID_EDGE = 0.85     # edge density at/above this is a solid border, below is dashed
# --- MEASURED ON THE TARGET PRINTER, 2026-08-03 -------------------------------
# Registration target v3 gave printable-area insets of:
#   top 1.50   left 1.75   bottom 1.10   right 0.85  (mm)
# Mean loss 1.30 mm per side on BOTH axes. Unequal as a percentage of each
# dimension (2.56% wide vs 1.71% tall), so this is a fixed unprintable border,
# not a scaling error. Residual mechanical offset: 0.45 mm left, 0.20 mm high.
# Flush-to-edge printing is therefore impossible on this printer.
# Re-run the target and update these if the printer or stock changes.
class PrinterProfile(NamedTuple):
    """Everything that depends on the printer + driver + stock combination."""
    loss_mm: float        # worst measured printable-area inset
    offset_x_mm: float    # shift content right to cancel mechanical offset
    offset_y_mm: float    # shift content down
    margin_solid_mm: float    # safe area around a solid printed border
    margin_cutline_mm: float  # safe area around a dashed cut line


DEFAULT_PROFILE = PrinterProfile(
    loss_mm=1.75,
    offset_x_mm=0.45,
    offset_y_mm=0.20,
    margin_solid_mm=2.0,      # worst edge + 0.25 mm buffer
    margin_cutline_mm=2.0,    # would be 0.0 if the printer could reach the edge
)


def mm_to_px(mm, dpi=DPI):
    return round(mm / 25.4 * dpi)


def _bottom_heavy(img):
    """True when the lower half carries more ink, as an upright label should."""
    a = np.array(img) < DARK
    h = a.shape[0]
    return a[h // 2:].mean() > a[:h // 2].mean()


def detect_rotation(img):
    """
    Return the transpose op that brings the label upright, or None.

    Two independent checks:
      1. Sideways or not: an upright label has more full-width inked ROWS
         (frame rules, banner bars, barcodes) than inked COLUMNS.
      2. Right way up or not: the tracking barcode is the heaviest ink block
         and belongs in the lower half.
    """
    a = np.array(img) < DARK
    sideways = (a.mean(axis=1) > RULE_DENSITY).sum() < (a.mean(axis=0) > RULE_DENSITY).sum()

    if sideways:
        col_ink = a.mean(axis=0)
        half = len(col_ink) // 2
        # Barcode block on the left means the label bottom is on the left.
        op = Image.ROTATE_90 if col_ink[:half].sum() > col_ink[half:].sum() else Image.ROTATE_270
        return op

    # Already portrait. Check it is not upside down.
    return None if _bottom_heavy(img) else Image.ROTATE_180


def find_frame(img):
    """
    Outermost rectangle formed by the label's border, solid or dashed.
    Returns (box, kind) where kind is 'border' or None.
    """
    a = np.array(img) < LOOSE
    rows = np.flatnonzero(a.mean(axis=1) > FRAME_DENSITY)
    cols = np.flatnonzero(a.mean(axis=0) > FRAME_DENSITY)
    if rows.size < 2 or cols.size < 2:
        return None, None
    box = (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)
    w, h = box[2] - box[0], box[3] - box[1]
    if h == 0:
        return None, None
    ratio = w / h
    if not (PORTRAIT_RANGE[0] <= ratio <= PORTRAIT_RANGE[1]):
        return None, None      # not label-shaped; probably grabbed page chrome

    # Solid border or dashed cut line? A dashed line has gaps, so its peak
    # density along the edge sits well below a solid rule's. Measured:
    # USPS solid box 1.00, UPS dashed cut line 0.66.
    edge = a[box[1]:box[3], box[0]:box[2]]
    rd = edge.mean(axis=1)
    peak = min(rd[:3].max(), rd[-3:].max())
    return box, ("border" if peak >= SOLID_EDGE else "cutline")


def find_rules(img):
    """Row indices of solid full-width horizontal rules."""
    a = np.array(img) < DARK
    return np.flatnonzero(a.mean(axis=1) > RULE_DENSITY).tolist()


def _load(src):
    """Accept a path, bytes, a file-like object, or an already-open PIL Image."""
    if isinstance(src, Image.Image):
        return src.convert("L")
    if isinstance(src, (bytes, bytearray)):
        import io
        return Image.open(io.BytesIO(src)).convert("L")
    return Image.open(src).convert("L")


def normalize(src, margin_mm="auto", rotate="auto", frame="auto", anchor="auto",
              dpi=DPI, drop_below_last_rule=False,
              offset_x_mm=None, offset_y_mm=None, profile=DEFAULT_PROFILE):
    """
    Returns (PIL.Image 'L' mode at 4x6 inches, report dict).
    `src` may be a path, bytes, a file-like object, or a PIL Image.

    margin_mm="auto" takes the value from `profile` according to whether the
    detected frame is a solid printed border or a dashed cut line.
    offset_x_mm / offset_y_mm default to the profile's measured values.
    """
    if offset_x_mm is None:
        offset_x_mm = profile.offset_x_mm
    if offset_y_mm is None:
        offset_y_mm = profile.offset_y_mm
    W, H = 4 * dpi, 6 * dpi
    img = _load(src)

    # 1. orientation
    ops = {"ccw": Image.ROTATE_90, "cw": Image.ROTATE_270,
           "180": Image.ROTATE_180, "none": None}
    op = detect_rotation(img) if rotate == "auto" else ops[rotate]
    if op is not None:
        img = img.transpose(op)

    # 2. framing
    kind = None
    if frame in ("auto", "border"):
        box, kind = find_frame(img)
        if box:
            img = img.crop(box)
    if kind is None:
        bbox = ImageOps.invert(img).getbbox()
        if bbox is None:
            raise ValueError("Image appears blank")
        img = img.crop(bbox)
        kind = "bbox"

    rules = find_rules(img)
    top_rule = rules[0] if rules else 0
    if drop_below_last_rule and rules:
        img = img.crop((0, 0, img.width, rules[-1] + 1))

    if anchor == "auto":
        anchor = "top-rule" if kind == "bbox" else "center"

    if margin_mm == "auto":
        margin_mm = (profile.margin_cutline_mm if kind == "cutline"
                     else profile.margin_solid_mm)
    margin = mm_to_px(margin_mm, dpi)

    # 3. scale to fit inside the margin box, aspect preserved
    avail_w, avail_h = W - 2 * margin, H - 2 * margin
    scale = min(avail_w / img.width, avail_h / img.height)
    img = img.resize((round(img.width * scale), round(img.height * scale)),
                     Image.LANCZOS)

    # 4. re-threshold so bar edges stay hard after resampling
    img = img.point(lambda p: 0 if p < REBINARIZE else 255)

    # 5. compose
    canvas = Image.new("L", (W, H), 255)
    x = (W - img.width) // 2 + mm_to_px(offset_x_mm, dpi)
    y = (H - img.height) // 2 if anchor == "center" else margin - round(top_rule * scale)
    y += mm_to_px(offset_y_mm, dpi)
    canvas.paste(img, (x, y))

    mm = lambda px: round(px / dpi * 25.4, 2)
    report = {
        "rotation": {None: "none", Image.ROTATE_90: "ccw",
                     Image.ROTATE_270: "cw", Image.ROTATE_180: "180"}[op],
        "frame": kind,
        "anchor": anchor,
        "margin_mm": margin_mm,
        "offset_mm": (offset_x_mm, offset_y_mm),
        "scale": round(scale, 3),
        "side_margin_mm": mm(x),
        "top_margin_mm": mm(y),
        "upscaled": scale > 1.0,
    }
    return canvas, report


def verify(img):
    """Decode every barcode in the finished label. This is the real test."""
    try:
        from pyzbar.pyzbar import decode
    except ImportError:
        return ["pyzbar not installed; skipping verification"]
    found = decode(img)
    return [f"{r.type}: {r.data.decode(errors='replace')}" for r in found] or \
           ["NO BARCODES DECODED"]


def main():
    p = argparse.ArgumentParser(description="Normalize a shipping label to 4x6 @ 300 DPI")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("--pdf")
    p.add_argument("--margin-mm", default="auto",
               help="mm of safe area, or 'auto' to take it from the printer profile")
    p.add_argument("--dpi", type=int, default=DPI)
    p.add_argument("--rotate", choices=["auto", "none", "cw", "ccw", "180"], default="auto")
    p.add_argument("--frame", choices=["auto", "border", "bbox"], default="auto")
    p.add_argument("--anchor", choices=["auto", "center", "top-rule"], default="auto")
    p.add_argument("--drop-below-last-rule", action="store_true")
    p.add_argument("--offset-x-mm", type=float, default=DEFAULT_PROFILE.offset_x_mm)
    p.add_argument("--offset-y-mm", type=float, default=DEFAULT_PROFILE.offset_y_mm)
    p.add_argument("--verify", action="store_true", help="Decode barcodes in the output")
    args = p.parse_args()

    if not args.output and not args.pdf:
        p.error("give at least one of -o/--output or --pdf")

    margin = args.margin_mm if args.margin_mm == "auto" else float(args.margin_mm)
    canvas, report = normalize(args.input, margin, args.rotate, args.frame,
                               args.anchor, args.dpi, args.drop_below_last_rule,
                               args.offset_x_mm, args.offset_y_mm)

    if args.output:
        canvas.save(args.output, dpi=(args.dpi, args.dpi))
    if args.pdf:
        canvas.convert("RGB").save(args.pdf, resolution=args.dpi)

    for k, v in report.items():
        print(f"{k}: {v}")
    if args.verify:
        for line in verify(canvas):
            print(f"barcode -> {line}")
    if report["upscaled"]:
        print("WARNING: source was upscaled; prefer the carrier's original file.",
              file=sys.stderr)


if __name__ == "__main__":
    main()
