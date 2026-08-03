# Replacing your existing rotate/crop with `label_4x6.py`

Supersedes the earlier version of this document. The module changed
substantially: it now classifies frames, corrects 180-degree flips, and carries
measured printer geometry in a `PrinterProfile`.

Do these in order. Steps 1 to 4 all happen BEFORE you delete anything, so you
can prove the new path is better rather than hoping it is.

---

## Step 0. Find what you already have

Paste into Claude Code:

> Search this repo for existing shipping-label image handling. Look for calls to
> PIL/Pillow `rotate`, `transpose`, `crop`, `resize`, `thumbnail`, or any use of
> sharp, jimp, ImageMagick, or `convert`. Also grep for "4x6", "label", "1200",
> "1800", "300 dpi", and "rotate". List every file and line number, what each
> one does, and who calls it. Do not change any code yet.

Three answers needed before continuing:

1. **Which function is the entry point** callers actually use.
2. **What it takes and returns** (path? bytes? PIL Image? a written file?).
3. **Is the app Python.** Determines Step 3.

---

## Step 1. Freeze current behavior as a baseline

> Create `tests/fixtures/labels/` and copy in every sample label we have. Write
> `tests/baseline_capture.py` that runs the CURRENT rotate/crop function over
> every fixture and saves output to `tests/baseline/<name>.png`. Commit it. Do
> not modify the existing function.

---

## Step 2. Calibrate the printer. Do not skip this.

The module ships with geometry measured on one specific printer. Those numbers
are properties of the printer + driver + stock combination, not of the label
format. Using someone else's numbers is the same mistake as guessing.

1. Print `label_calibration_target.pdf` at **100%**, fit-to-page OFF.
2. Read the lowest fully-printed numeral on each of the four staircases.
3. Convert: tread *k* spans *k* to *k+1* mm, so a tread that is *f* fraction
   visible means the printable area starts at `k + (1 - f)` mm from that edge.
4. Fill in the profile:

```python
MY_PRINTER = PrinterProfile(
    loss_mm=<worst of the four edges>,
    offset_x_mm=(left_loss - right_loss) / 2,   # positive shifts content right
    offset_y_mm=(top_loss - bottom_loss) / 2,   # positive shifts content down
    margin_solid_mm=<loss_mm + 0.25>,
    margin_cutline_mm=<same, unless the printer can reach the edge>,
)
```

Sanity check while you are there: if the loss is roughly equal in **millimetres**
on both axes, it is a fixed driver border. If it is roughly equal as a
**percentage** of each dimension, something is scaling your page and you should
fix that instead of compensating for it.

Before accepting the number, open printer preferences and look for a custom page
size or an unprintable-margin setting. A fixed driver border can often be zeroed,
which buys back several percent of label area.

---

## Step 3. Install and drop in

```bash
pip install pillow numpy pyzbar
#   Debian/Ubuntu:  apt-get install libzbar0
#   macOS:          brew install zbar
```

`pyzbar` is optional at runtime but you want it. It is the only check that
proves a label works.

**Python app:** copy `label_4x6.py` to `src/labels/label_4x6.py`.

**Node/TS or anything else:** shell out first, port later once tests lock the
behavior.

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export async function normalizeLabel(inPath, outPath) {
  const { stdout } = await run("python3", [
    "tools/label_4x6.py", inPath, "-o", outPath, "--verify",
  ]);
  if (stdout.includes("NO BARCODES DECODED")) {
    throw new Error("Label failed barcode verification");
  }
  return stdout;
}
```

A subprocess costs ~200ms. Rewriting in sharp means rediscovering the
re-threshold step, the frame-density gate, and the 180-degree check the hard way.

---

## Step 4. Pin the one ambiguous setting

Auto-anchoring centers a label with a detected frame and pins the top rule when
only horizontal rules were found. On the USPS sample that yields an 11 mm top
margin; `anchor="top-rule", frame="bbox"` yields 2 mm. Both are defensible.
Choose one and hardcode it, or the same input renders two ways.

```python
from labels.label_4x6 import normalize, PrinterProfile

canvas, report = normalize(src, profile=MY_PRINTER)                     # per-frame auto
canvas, report = normalize(src, profile=MY_PRINTER,
                           anchor="top-rule", frame="bbox")             # always pin top
```

---

## Step 5. Swap the call site, keep the old code

> Replace the body of `<function from Step 0>` with a call to `normalize()`.
> Keep the existing name and signature so no caller changes. Inside it:
>   1. call `normalize(src, profile=MY_PRINTER)` with the Step 4 anchor setting
>   2. return in whatever shape the old function returned
>   3. log the returned `report` dict at INFO on every call
>   4. if `report["upscaled"]` is True, log a WARNING with the source filename
> Move the old implementation to `_legacy_rotate_crop()` in the same file.
> Do not delete it.

Point 3 is not optional. The report carries rotation, frame type, anchor,
margin, offset, scale, and both measured margins. When a label comes out wrong
in production that line is the difference between a five-minute fix and an
afternoon.

---

## Step 6. Test

> Write `tests/test_label_4x6.py` running over every fixture:
>
>   1. Output is exactly 1200x1800.
>   2. Histogram contains only 0 and 255.
>   3. PNG DPI metadata is (300, 300); PDF page measures 4x6 inches.
>   4. `pyzbar.decode()` on the OUTPUT returns the expected tracking string
>      from `tests/fixtures/expected.json`.
>   5. Re-running `normalize()` on its own output is idempotent within 1 px.
>   6. Feeding 90/180/270-rotated copies produces pixel-identical results.
>   7. Ink bounding box clears the measured per-edge printer loss on all four
>      sides, with the buffer reported per edge.
>
> Then `tests/test_compare_legacy.py`: render every fixture through both
> `_legacy_rotate_crop()` and the new path, print a table of dimensions,
> barcode decodes, and margins. A report, not a pass/fail test.

Assertion 6 caught a real bug: an earlier version detected sideways labels and
sailed straight past upside-down ones. Assertion 7 is the one that connects the
code to physical reality.

**Know what assertion 4 does not catch.** Code128 decodes fine upside down. A
passing decode does not prove correct orientation. That is assertion 6's job.

---

## Step 7. Read the comparison table yourself

Do not delegate this. Every fixture should decode at least as well under the new
path. Any regression is a label format the frame detection does not handle. Add
a per-fixture flag override rather than weakening the defaults.

---

## Step 8. Delete the legacy code

Only now. Remove `_legacy_rotate_crop()` and `test_compare_legacy.py`. Keep
`tests/baseline/` in git history, drop it from the working tree.

---

## Step 9. Gate on verification

> After normalization and before the file is written, printed, or returned:
> decode the canvas with pyzbar and compare against the expected tracking number
> when the caller supplied one. On mismatch or no decode, raise and surface the
> error with the report dict attached. Never silently emit an unverified label.

---

## Step 10. Make it stick

> Add a `## Shipping labels` section to CLAUDE.md: all label normalization goes
> through `normalize()` in `label_4x6.py`. Never add ad-hoc rotate, crop, or
> resize calls to label images anywhere else. The tuning constants (DARK=128,
> LOOSE=200, RULE_DENSITY=0.80, FRAME_DENSITY=0.30, SOLID_EDGE=0.85,
> REBINARIZE=160) must not change without re-running tests against all fixtures.
> The PrinterProfile numbers come from label_calibration_target.py and must be
> re-measured, never guessed. Link to LABEL_4X6_SPEC.md.

---

## If you print to more than one device

`PrinterProfile` is a NamedTuple precisely so it can move out of the module. Put
one profile per printer in your config or database, keyed by printer ID, and
pass it in at call time:

```python
canvas, _ = normalize(src, profile=PROFILES[printer_id])
```

Calibrate each device once. A profile that is right for one thermal printer will
clip on another.

---

## Ongoing: the fixture habit

Every label a user reports as broken goes into `tests/fixtures/labels/` with its
expected decode string, before anyone tries to fix it. Running score so far:
three label formats, and each one broke an assumption that looked safe at the
time. There will be a fourth.
