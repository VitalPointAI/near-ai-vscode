# Phase 44.1: deferred items

Out-of-scope problems found while executing a plan, recorded instead of fixed.

## Found during 44.1-09 (2026-11-25)

- **`compliance/test/levels.test.ts` fails at `a09bf3d0`:** "the existing Protected B rows and counts are the same as in a bundle without the hosted entries".
  - The test builds a bundle from a copy of `levels.json` without the hosted levels. The applicability loader now refuses that copy: "reviews.json: stage stage-1 names level hosted-protected-a, which does not exist".
  - Cause: the stage 1 record in `compliance/applicability/reviews.json` (`a09bf3d0`) names `hosted-protected-a`, and the test keeps the real `reviews.json` while removing that level.
  - Not caused by 44.1-09: its files do not touch the bundle, the levels or the applicability loader. Reproduced outside the suite with the test's own setup.
  - Effect: `npm --prefix compliance test` runs 582 tests with 1 failing, so the `compliance` CI job of the combined gate pull request fails until this is fixed.
  - Likely fix, for whoever owns the 44.1-05 to 44.1-08 gate: in the test's level-filtered copy, also leave out the removed levels from a copied review record. Do not edit `reviews.json`. The loader's refusal of an unknown level is correct and should stay.
