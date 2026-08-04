## Shipping labels

The canonical rotate/crop/normalize pipeline is the **client-side Canvas
implementation in `frontend/index.html`** (`runLabelPipeline`, `toGrayscale`,
`findBorderRect`, `insetPastCutLines`, `findLabelRegion`,
`detectLabelOrientation`, `normalizeLabelToCanvas`). All label geometry changes
go there. It is deployed and user-tested.

Rewritten 2026-08-04, replacing the earlier
`detectRotationDeg`/`detectFrameRect`/`isolateLabelBbox`/`findRuleRows` version.
Two ideas carry the whole thing:

- **The printed border says where the label ENDS.** Solid frame (USPS) or dashed
  cut line (UPS/Amazon). This is the only trustworthy basis for discarding page
  furniture in a pasted screenshot. Border edges are identified by ENDPOINT
  ALIGNMENT, not run length - a long sentence of page text produces a run as
  long as the label is wide, and a length-only test cropped 58 px of page text
  into a label. Columns are the trustworthy axis to measure first, because text
  lines are ~10 px tall and never yield a long column run.
- **The 1D tracking barcode says which way is DOWN.** It always belongs at the
  bottom of an upright label. Bar direction comes from black/white transition
  counts (crossing bars gives dozens per line, scanning along them gives ~1),
  which is also what separates a barcode from text.

Dashed borders are cropped inside (a cut guide must not print); solid borders are
kept (printed label design). Coverage along the edge tells them apart: measured
0.63 dashed vs 1.00 solid.

`backend/tools/labels/label_4x6.py` is a **dev-only reference implementation**.
Never import or shell out to it from `backend/src`; the runtime image is
`node:20-alpine` with no Python, pip, or libzbar0. Its only sanctioned use is
generating golden test fixtures.

Non-obvious rules, each learned from a real failure in production code:

- **Canvases must be white-filled before any `drawImage`.** Use `makeCanvas()`.
  `toGrayscale` reads luminance from RGB, so a transparent pixel computes as
  pure black and is treated as ink. That corrupts `contentBbox`, rotation,
  frame detection and rule finding, not just appearance. This bit three sites,
  including the pdf.js render, where it can black out an entire page.
- **Re-threshold after every resample.** `drawImage` interpolates and leaves
  grey barcode edges that thermal printers dither into noise. Snap to 0/255 at
  cutoff 160 after any scale operation.
- **Detect upside-down separately from sideways.** An upright label is
  bottom-heavy; the tracking barcode sits low. A passing barcode decode does
  NOT prove orientation, because Code128 decodes upside down. Two independent
  checks, both required. Done in `detectLabelOrientation`: aspect ratio answers
  "sideways?" and barcode-band position answers "which way?", each with its own
  cross-check (bar direction, ink weight). Disagreement logs `console.warn`
  rather than failing silently.
- **Aspect ratio is only decisive when oblong.** A cropped 4x6 "should" read
  0.667 or 1.5, but real ink bboxes measure 0.71 / 1.31 / 1.47 / 1.53, because
  printed content does not fill the stock. Trust aspect outside 0.80-1.25 only;
  inside that band use bar direction, whose margin has been at least 2x on every
  label measured.
- **Measure density on content, never on the raw canvas.** Thresholds are
  fractions of a dimension, so whitespace padding around a label deflates them
  and detection silently no-ops. Trim to the content bbox first.
- **Never let content position off-canvas.** The top-rule anchor once computed
  `y = -504`, silently discarding the top 42.7 mm of every UPS label including
  the SHIP TO address, while the preview looked clean. Fixed by removing the
  anchor entirely: the crop is already tight to the label, so plain centring is
  correct and cannot push content off-canvas.
- **Do not try to isolate a label from page text WITHOUT a border.** Three
  attempts were made and all silently amputated real data on a borderless label
  whose sections are separated by white gaps: largest connected ink blob dropped
  the top third including SHIP TO, largest-by-ink-mass dropped the address
  block, "discard only obvious specks" dropped the "1 of 1" package count. Ink
  mass cannot rescue it - an address block holds an order of magnitude less ink
  than a barcode block, so any ratio loose enough to keep it rejects nothing.
  `findLabelRegion` therefore just trims whitespace and keeps everything.
  Including a caption is cosmetic and visible in the preview; dropping the
  destination address is an undeliverable package.
- **`rotateImageToCanvas` must accept a canvas, not just an `<img>`.** The
  pipeline crops before rotating, so what it receives is normally a canvas, and
  a canvas has no `naturalWidth` - reading only that yields a 0x0 canvas and a
  `drawImage` throw on every label. Use `naturalWidth ?? width`.
- **Scale must fit both axes** (`Math.min`), never width alone, or content
  taller than the page aspect is cropped without warning.
- **Prefer dragging carrier PDFs over screenshots.** PDFs render at `LABEL_DPI`
  natively (scale ~1.0, real pixels in every bar); screenshots arrive at
  109-120 DPI and upscale 1.8-2.8x, interpolating most of the output. pdf.js
  viewport scale is relative to 72 DPI, so it must be `LABEL_DPI / 72`.
- **Browser print needs `@page { size: 4in 6in; margin: 0 }`** plus the canvas
  sized in inches, or the browser rescales and output is silently wrong.
- **Printer geometry is measured, never guessed.** Use
  `backend/tools/labels/label_calibration_target.py`. Measured: 2.0 mm margin.
  **`LABEL_MARGIN_MM` is currently 0** - edge-to-edge output was requested and
  approved 2026-08-04. That discards both the measured feed-drift allowance and
  whatever quiet zone the carrier designed in, so if bars start clipping at an
  edge, raise this constant first. Mechanical offsets +0.45 mm x / +0.20 mm y
  measured but NOT wired in; gain is under 0.5 mm. Re-measure if printer,
  driver, or stock changes.

Algorithm detail: `docs/labels/LABEL_4X6_SPEC.md`
Open items and audit history: `docs/labels/PORTING_CHECKLIST.md`
