# Port the decisions, not the code

## STATUS after audit of frontend/index.html (2026-08-03)

| # | Decision | Audit verdict | Action |
|---|---|---|---|
| 1 | Re-threshold after resample | Implemented (line 2660-2670, luminance-weighted) | **None.** Better than the reference. |
| 2 | Upside-down detection | Missing (detectRotationDeg:2385 returns early) | **DO** |
| 3 | Cut line vs solid border | Missing | **SKIP.** Both margins are 2.0 mm on this printer; the branch would be dead code. |
| 4 | Reject page chrome | Partial. Method differs and works; aspect gate absent | **DO the aspect gate only.** Leave the detection method alone. |
| 5 | Scale on one axis | Partial. Width hardcoded as binding axis; tall content silently crops | **DO. Highest priority.** |
| 6 | Printer profile | Partial. Margin applied, offsets never wired in | **DECIDE:** wire it or correct CLAUDE.md. Gain is under 0.5 mm. |
| 7 | Browser print at true size | Implemented and exceeded (always emits a jsPDF at exact page size) | **None.** |
| 8 | Verification gate | Missing | **DEFER.** Separate project. Advisory by default; block only on mismatch. |

Score: 2 implemented, 3 partial, 3 missing. Two of the three "missing" are
deliberately not being done.

---

## The call: keep the JS pipeline. Do not migrate.

`frontend/index.html` holds a deployed, user-tested Canvas implementation.
`backend/tools/labels/label_4x6.py` is a parallel reimplementation of the same
algorithm in a language the runtime does not have. Wiring it in would mean:

- adding `python3`, `pip`, Pillow, numpy and `libzbar0` to a `node:20-alpine`
  runtime image that currently has none of them,
- moving image processing from the client, where it is free, instant and never
  leaves the machine, to the server, where it costs an upload and a round trip,
- maintaining two implementations of one algorithm, which will drift.

That is a regression bought with real complexity. The Python module's value was
never the code. It was the set of decisions encoded in it, and those port to
JavaScript in an afternoon.

`MIGRATION.md` describes a migration that should not happen. Delete it.

---

## Disposition of the files already committed

| File | Do this |
|---|---|
| `frontend/index.html` pipeline | **Canonical.** Everything below gets verified or added here. |
| `backend/tools/labels/label_4x6.py` | Keep temporarily as a **test oracle** to generate golden fixtures, then delete. Never import it from `backend/src`. |
| `backend/tools/labels/label_calibration_target.py` | **Keep.** Manual dev tool, run by hand, zero runtime impact. |
| `docs/labels/LABEL_4X6_SPEC.md` | **Keep. This is the source of truth**, and it is language-agnostic. |
| `docs/labels/MIGRATION.md` | **Delete.** Premise is wrong. |
| `.claude/CLAUDE.md` shipping-labels section | **Rewrite.** As written it prohibits the working implementation. |

---

## Decisions to verify in the JS pipeline

For each item: confirm the JS already does it, or add it. Several of these were
discovered the hard way and are not obvious from the function names.

### 1. Re-threshold after every resample

**Most important item on this list.** `ctx.drawImage()` interpolates, which
leaves soft grey edges on barcode bars. A thermal head dithers grey into noise
and scanners reject it. After any scale operation, walk the ImageData and snap
every pixel to pure black or white:

```js
const t = 160;                       // biased toward ink; thin bars survive
for (let i = 0; i < d.length; i += 4) {
  const v = d[i] < t ? 0 : 255;
  d[i] = d[i+1] = d[i+2] = v;
}
```

Also set `ctx.imageSmoothingEnabled = false` where you are not deliberately
resampling.

### 2. Upside-down detection

Detecting "sideways or not" is not enough. An upright label is bottom-heavy
because the tracking barcode block sits low. Compare mean ink in the lower half
against the upper half; if the top is heavier, rotate 180.

Measured on real labels: USPS 0.216 vs 0.119, UPS 0.185 vs 0.094.

**This cannot be caught by barcode verification.** Code128 decodes correctly
upside down. Two independent safeguards, both required.

### 3. Frame classification: cut line vs solid border

> **SKIPPED.** This was designed when flush-to-edge printing looked achievable.
> The measured 1.75 mm unprintable border makes `marginCutline` and
> `marginSolid` both 2.0 mm, so the classifier would compute a value and then
> branch to the same number. Revisit only if a printer that can reach the edge
> arrives. Original rationale retained below.

Take the peak ink density of the outer three rows at the top and bottom of the
detected frame. Solid rules read near 1.00; dashed cut lines read well below
because of the gaps. Threshold at **0.85**.

Measured: USPS solid box 1.00, UPS dashed cut line 0.66.

They need different margins, and on a label with a cut line nothing is printed
outside it.

### 4. Frame detection must reject page chrome

Use a loose ink cutoff (`< 200`, not `< 128`) so dashed and light-grey borders
register. Take rows and columns above **30%** ink density and use their outer
min/max; body text never reaches 30%, so surrounding instructions such as "cut
here and affix to the package" fall away on their own.

Then gate it: **reject the box unless width/height lands between 0.50 and 0.85.**
Without that gate a busy page hands you a garbage rectangle and nothing tells you.

### 5. Scale on one axis, never stretch

> **AUDIT:** line 2650 hardcodes width as the binding axis. Aspect is preserved,
> so nothing stretches, but content taller than the page aspect is silently
> cropped by the canvas bounds with no warning. Fix:
> `const scale = Math.min((W - 2*marginPx)/bbox.width, (H - 2*marginPx)/bbox.height);`

Fit inside the margin box preserving aspect. Any code trying to satisfy margins
on all four sides independently will stretch, and a stretched barcode fails
verification. USPS label content is roughly 0.68 wide-to-tall against 4x6's
0.667; the leftover goes to one axis as slack.

### 6. Printer profile, measured not guessed

From the v3 registration target on your printer:

```js
const PRINTER = {
  lossMm:    1.75,   // worst measured printable-area inset (left edge)
  offsetXMm: 0.45,   // shift content right to cancel mechanical offset
  offsetYMm: 0.20,   // shift content down
  marginMm:  2.00,   // worst edge + 0.25 mm buffer
};
```

Per-edge printable-area insets measured: top 1.50, left 1.75, bottom 1.10,
right 0.85 mm. Mean loss 1.30 mm per side on both axes; unequal as a percentage
of each dimension (2.56% wide vs 1.71% tall), so it is a fixed driver border,
not a scaling error. Flush-to-edge printing is not achievable on this printer.

Re-measure whenever printer, driver, or stock changes.

### 7. Browser printing at true physical size

A 1200x1800 canvas does not print as 4x6 inches on its own. The browser applies
its own page setup and scales. Required:

```css
@media print {
  @page { size: 4in 6in; margin: 0; }
  html, body { margin: 0; padding: 0; }
  #labelCanvas { width: 4in; height: 6in; display: block; }
}
```

Then in the print dialog: scale 100%, margins none, background graphics on.
This is the browser equivalent of setting the PDF MediaBox, and getting it wrong
produces exactly the off-centre, wrong-size output that looks like a pipeline bug.

Worth offering a "download PDF" path alongside browser print, since a PDF with
an explicit 4x6 page is far more predictable across printers.

### 8. Verification gate

Decode the finished canvas before it is printed or downloaded. In the browser,
`@zxing/library` or `zxing-wasm` will do it. Compare against the expected
tracking number when one is known; on mismatch or no decode, block and surface
the error.

Remember item 2: a passing decode does not prove orientation.

---

## Constants, for reference

| Name | Value | Meaning |
|---|---|---|
| `DARK` | 128 | Ink cutoff for solid black structure |
| `LOOSE` | 200 | Ink cutoff that also catches dashed/light borders |
| `RULE_DENSITY` | 0.80 | Row is a solid full-width rule above this |
| `FRAME_DENSITY` | 0.30 | Border survives this; body text does not |
| `SOLID_EDGE` | 0.85 | At/above is a solid border, below is a dashed cut line |
| `REBINARIZE` | 160 | Post-resample threshold, biased toward ink |
| `PORTRAIT_RANGE` | 0.50 to 0.85 | Plausible w/h for an upright label |

---

## Test fixtures

Before deleting `label_4x6.py`, use it once to generate golden outputs for every
sample label, and assert the JS produces the same geometry: 1200x1800, only
values 0 and 255, ink bounding box clearing the measured per-edge printer loss,
and identical barcode decodes.

Then add the rotation round-trip: feed 90, 180 and 270 degree rotated copies of
each fixture and assert output is identical to the unrotated run. That is the
assertion that catches what the decode gate cannot.

Running score: three label formats so far, and each one broke an assumption that
looked safe at the time. There will be a fourth.
