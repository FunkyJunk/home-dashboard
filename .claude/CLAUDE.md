## Shipping labels

The canonical label rotate/crop/normalize pipeline is the **client-side Canvas
implementation in `frontend/index.html`** (`runLabelPipeline`, `detectRotationDeg`,
`detectFrameRect`, `isolateLabelBbox`, `normalizeLabelToCanvas`). All changes to
label geometry go there. It is deployed and user-tested; do not replace it.

`backend/tools/labels/label_4x6.py` is a **dev-only reference implementation**.
It is not wired into the runtime and must never be imported or shelled out to
from `backend/src`. The runtime image is `node:20-alpine` with no Python, pip,
or libzbar0. Its only sanctioned use is generating golden test fixtures.

Non-obvious rules, each learned from a real failure:

- **Re-threshold after every resample.** `drawImage` interpolates and leaves grey
  barcode edges that thermal printers dither into noise. Snap to 0/255 at
  cutoff 160 after any scale operation.
- **Detect upside-down separately from sideways.** An upright label is
  bottom-heavy. A passing barcode decode does NOT prove orientation; Code128
  decodes upside down. Two independent checks, both required.
- **Printer geometry is measured, never guessed.** Use
  `backend/tools/labels/label_calibration_target.py`. Current measured values:
  margin 2.0 mm, offset +0.45 mm x / +0.20 mm y. Re-measure if printer, driver,
  or stock changes.
- **Browser print needs `@page { size: 4in 6in; margin: 0 }`** plus the canvas
  sized in inches, or the browser rescales and the output is silently wrong.

Source of truth for the algorithm: `docs/labels/LABEL_4X6_SPEC.md`
Porting checklist: `docs/labels/PORTING_CHECKLIST.md`
