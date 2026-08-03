# home-dashboard

## Shipping labels

All shipping-label normalization goes through `normalize()` in
`backend/tools/labels/label_4x6.py`. Never add ad-hoc rotate, crop, or resize
calls to label images anywhere else in this repo.

- Tuning constants (DARK, LOOSE, RULE_DENSITY, FRAME_DENSITY, SOLID_EDGE,
  REBINARIZE) are calibrated against test fixtures. Do not change one without
  re-running the label tests over every fixture.
- `PrinterProfile` values are measured with
  `backend/tools/labels/label_calibration_target.py`. Measure them. Never guess
  them or copy them from another printer.
- A passing barcode decode does NOT prove correct orientation. Code128 decodes
  upside down. Orientation is covered by the rotation round-trip test, which is
  a separate assertion from the decode check.
- The module is Python. If it is called from Node, the container image needs
  `python3`, `pip`, and `libzbar0` installed or verification fails silently at
  runtime.
- Detail: `docs/labels/LABEL_4X6_SPEC.md`
- Migration plan: `docs/labels/LABEL_MIGRATION.md`
