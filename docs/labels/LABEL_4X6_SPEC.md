# Shipping Label to 4x6 Normalization Spec (v2)

Hand this to Claude Code as the requirements doc. It is deterministic on purpose:
every threshold and step is named so the result is reproducible rather than
"whatever the model felt like doing today."

## Output contract

- Canvas: exactly `4 * DPI` x `6 * DPI` pixels. At 300 DPI that is **1200 x 1800**.
- Mode: 8-bit grayscale, pure black (0) and white (255) only. No anti-aliased gray.
- Background: white, filling the full canvas. Never transparent.
- PNG must be saved with `dpi=(300, 300)` metadata. PDF must be saved with
  `resolution=300` so the page measures 4x6 inches, not 4x6 points.

## Pipeline, in order

Order is load-bearing. Swapping steps 5 and 6 produces gray, fuzzy barcodes.

1. **Load** as grayscale (`Image.open(path).convert("L")`).
2. **Rotate upright.** Do not hardcode a direction. Detect it (see below).
   Two separate checks are required: sideways-or-not, and right-way-up-or-not.
3. **Find the outer frame,** solid or dashed, and crop to it. Use the loose ink
   threshold (`< 200`) so light and dashed borders register, take rows and
   columns above **30%** ink density, and use their outer min/max. Body text
   never reaches 30%, so surrounding page chrome such as "cut here and affix to
   the package" falls away on its own. Reject the box unless its width/height
   lands between 0.50 and 0.85, the plausible range for an upright label;
   without that gate a busy page hands you a garbage rectangle silently.
   Fall back to `img.crop(ImageOps.invert(img).getbbox())` when no frame is found.

   **Classify the frame.** A solid printed border and a dashed cut line need
   different treatment. Take the peak ink density of the outer three rows at
   the top and bottom of the frame; a solid rule reads near 1.00, a dashed line
   reads well below because of its gaps. Measured: USPS solid box 1.00, UPS
   dashed cut line 0.66. Threshold at **0.85**.

   * `cutline` -> in principle margin **0 mm**, because nothing is printed
     outside a cut line. In practice the margin is bounded by the printer's
     unprintable border, measured below.
   * `border` -> margin equal to the measured printable-area inset plus a buffer.
4. **Find the internal rules.** Convert to a boolean ink mask (`pixel < 128`). A row is a
   full-width rule when more than **80%** of its pixels are ink. Collect those
   row indices. `rules[0]` is the top border, `rules[-1]` is the bottom rule.
   Anchor margins to these, not to the raw bounding box, because stray marks
   (the loose QR code below the tracking barcode) sit outside the frame and
   would otherwise skew the layout.
5. **Scale to width.** `scale = (canvas_width - 2 * margin_px) / content_width`.
   Resample with `Image.LANCZOS`. Scale is driven by width only; height follows
   from the source aspect ratio.
6. **Re-threshold** after resampling: `img.point(lambda p: 0 if p < 160 else 255)`.
   This is the single most important step for barcode scannability. LANCZOS
   leaves soft gray edges on the bars; a thermal printer dithers those into
   noise and scanners choke. The 160 cutoff biases slightly toward ink, which
   keeps thin bars from dropping out.
7. **Compose.** Centre horizontally. Vertically, either centre inside the
   margin box (correct when a full border rectangle was found) or pin the top
   rule with `y = margin_px - round(top_rule * scale)` (correct when only
   horizontal rules exist). Pick one per frame type and be consistent.
8. **Save** PNG and PDF as described in the output contract.

## Rotation detection

A correctly oriented label has many heavily inked **rows** (frame rules, the
banner bar, the tracking barcode) and few heavily inked columns. Compare the
count of rows above the 0.80 ink threshold against the count of such columns.
If columns win, the label is sideways.

To pick the direction: the tracking barcode block is the densest region and
belongs at the bottom. Sum column ink density for the left half versus the right
half. Barcode on the left means the label's bottom is on the left, so rotate
counterclockwise (`Image.ROTATE_90`). Otherwise rotate clockwise
(`Image.ROTATE_270`).

Once the label is portrait, check it is not upside down: an upright label is
bottom-heavy because the tracking barcode sits low. Compare mean ink in the
lower half against the upper half. Measured on real labels: USPS 0.216 vs
0.119, UPS 0.185 vs 0.094. If the top half is heavier, rotate 180.

This check is not redundant with barcode verification. Code128 decodes
correctly upside down, so a passing decode does not prove correct orientation.

Always expose a manual override flag. Heuristics fail eventually, and when they
do you want a switch, not a rewrite.

## Constants worth naming in code

| Name | Value | Why |
|---|---|---|
| `DPI` | 300 | Standard for thermal label printers |
| `DARK` | 128 | Ink cutoff on the source scan |
| `LOOSE` | 200 | Ink cutoff that also catches dashed/light borders |
| `RULE_DENSITY` | 0.80 | Row is a solid full-width rule above this |
| `FRAME_DENSITY` | 0.30 | Border survives this; body text does not |
| `REBINARIZE` | 160 | Post-resample cutoff, biased toward ink |
| `SOLID_EDGE` | 0.85 | Edge density at/above this is solid, below is dashed |
| `MARGIN_SOLID_MM` | 2.0 | Safe area around a solid printed border |
| `MARGIN_CUTLINE_MM` | 2.0 | Was 0.0; flush is not achievable on the measured printer |
| `PRINTER_LOSS_MM` | 1.75 | Worst measured printable-area inset |
| `OFFSET_X_MM` | 0.45 | Cancels the measured leftward mechanical offset |
| `OFFSET_Y_MM` | 0.20 | Cancels the measured upward mechanical offset |

## Measured printer characteristics

Registration target v3, run 2026-08-03. Printable area begins this far inside
the label edge:

| Edge | Inset | 
|---|---|
| top | 1.50 mm |
| left | 1.75 mm |
| bottom | 1.10 mm |
| right | 0.85 mm |

Mean loss is 1.30 mm per side on **both** axes. As a fraction of each dimension
that is 2.56% horizontally against 1.71% vertically. Unequal percentages mean
this is a **fixed unprintable border**, not a scaling error, so it cannot be
corrected by adjusting page size.

The residual asymmetry (0.45 mm left, 0.20 mm high) is mechanical registration
and IS correctable, via `OFFSET_X_MM` / `OFFSET_Y_MM`, which shift the composed
content on the canvas.

Re-run the target whenever the printer, driver, or label stock changes. These
numbers are properties of that combination, not of the label format.

## Known limitations to surface, not hide

- **Upscaling.** If `scale > 1.0` the source had less detail than the output
  claims. Log a warning. A 627 px wide screenshot blown up to 1152 px is
  interpolated data, and no amount of thresholding invents real barcode edges.
  The fix is upstream: get the carrier's original PDF or the raw ZPL.
- **Aspect mismatch.** USPS label content is roughly 0.68 wide-to-tall while 4x6
  is 0.667. Once the sides are pinned, the bottom margin is whatever is left
  over, typically 20 mm to the bottom rule. Do not stretch to close that gap.
  Distorting a barcode's height is how you get a package returned.
- **Skew.** This pipeline assumes the source is square to the page. If you start
  ingesting phone photos, add a deskew stage (Hough transform on the frame
  rules) before step 3.

## Test assertions

- Output is exactly 1200 x 1800.
- Output histogram contains only values 0 and 255.
- Top frame rule sits within 1 px of `margin_px` from the top.
- Left and right frame borders sit within 1 px of `margin_px` from their edges.
- Re-running on an already-normalized output is idempotent within 1 px.
- Decode the tracking barcode from the output with `pyzbar` and compare against
  the expected string. This is the assertion that actually matters, and it is
  the one most people skip.
- Feed a 90, 180, and 270 degree rotated copy of each fixture and assert the
  output is pixel-identical to the unrotated run. This is what catches the
  upside-down case that barcode verification cannot.
