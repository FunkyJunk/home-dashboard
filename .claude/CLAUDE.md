## Shipping labels

The canonical rotate/crop/normalize pipeline is the **client-side Canvas
implementation in `frontend/index.html`** (`runLabelPipeline`, `toGrayscale`,
`detectRotationDeg`, `detectFrameRect`, `isolateLabelBbox`,
`normalizeLabelToCanvas`). All label geometry changes go there. It is deployed
and user-tested. Do not replace it.

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
  checks, both required. **Still outstanding in `detectRotationDeg`.**
- **Measure density on content, never on the raw canvas.** Thresholds are
  fractions of a dimension, so whitespace padding around a label deflates them
  and detection silently no-ops. Trim to the content bbox first.
- **Never let content position off-canvas.** The top-rule anchor once computed
  `y = -504`, silently discarding the top 42.7 mm of every UPS label including
  the SHIP TO address, while the preview looked clean. Guard: centre when
  `y < marginPx`.
- **Scale must fit both axes** (`Math.min`), never width alone, or content
  taller than the page aspect is cropped without warning.
- **Prefer dragging carrier PDFs over screenshots.** PDFs render at `LABEL_DPI`
  natively (scale ~1.0, real pixels in every bar); screenshots arrive at
  109-120 DPI and upscale 1.8-2.8x, interpolating most of the output. pdf.js
  viewport scale is relative to 72 DPI, so it must be `LABEL_DPI / 72`.
- **Browser print needs `@page { size: 4in 6in; margin: 0 }`** plus the canvas
  sized in inches, or the browser rescales and output is silently wrong.
- **Printer geometry is measured, never guessed.** Use
  `backend/tools/labels/label_calibration_target.py`. Measured: 2.0 mm margin
  (applied). Mechanical offsets +0.45 mm x / +0.20 mm y measured but NOT wired
  in; gain is under 0.5 mm. Re-measure if printer, driver, or stock changes.

Algorithm detail: `docs/labels/LABEL_4X6_SPEC.md`
Open items and audit history: `docs/labels/PORTING_CHECKLIST.md`
