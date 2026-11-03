---
phase: 25-cybersecurity-harness-with-offensive-and-defensive-scanning
plan: 07
subsystem: security
tags: [cybersecurity, sarif, export, report, diff, visual-capture, deterministic]

requires:
  - phase: 25-01
    provides: "buildPtesReport's skeleton and its acceptance table, Finding/WSTG_MAP/hardeningAdvice, the ledger chain helpers"
  - phase: 25-05
    provides: "CyberEvidenceStore.put/get for the capture blobs, the ledger entry shape"
  - phase: 25-06
    provides: "renderVerdict and verdictToSarifLevel (D-24's table)"

provides:
  - "cyberSarifExport.ts: toSarif (2.1.0, verdict levels, a location on every result, embedded authorization), findingsDocument, exportFiles, exportRun"
  - "cyberReport.ts: populated Findings/Narrative/Remediation/Appendix sections, the four-category Run Diff, the exported acceptanceBlock"
  - "cyberVisualCapture.ts: three deterministic SVG forms, captureForRun, SCREENSHOT_ABSENT_NOTE"

affects: [25-08]

actuals:
  tokens: 21300
  tasks: 3
  commits: 1

tech-stack:
  added: []
  patterns:
    - "SARIF correctness asserted structurally (no schema library), consistent with the zero-new-dependency decision"
    - "SVG assembled as escaped text with no clock, randomness, or unordered iteration, so a capture's hash is stable"
    - "One acceptance-table builder shared by the Markdown report, the JSON document and every SARIF result"
---

# Plan 25-07 — the export surface

## What landed

One commit: `cyberSarifExport.ts`, the extended `cyberReport.ts`, `cyberVisualCapture.ts`, and both test files.

## Requirements: CYBER-12

| Clause | Where it is delivered |
|---|---|
| SARIF 2.1.0 with verdict levels | `toSarif` maps `verified_access`→`error`, `exploit_failed`/`could_not_determine`→`note`, `not_vulnerable`→`pass`, and a pass stays in `results` rather than being omitted |
| A location on every result (Pitfall 6) | `locationsFor` always returns one entry; a network finding cites its URL, a file finding cites `file:line` with a parsed `startLine` |
| Embedded authorization (D-16) | `authorizationFor` rides every result's `properties` and the run's |
| Missing-tools note | `missingTools` on the run's `properties` and in the JSON document |
| Markdown, JSON, SARIF | `exportRun` writes all three through the atomic temp-then-rename write |
| Deterministic output | Two exports of one run are byte-identical; the test asserts it on the report and the SARIF file |
| Per-run diff | `diffFindings` produces added / resolved / unchanged / unplaceable, and the Markdown gains a Run Diff section |
| No secret leakage | `assertRedacted` re-scans the report, JSON and SARIF for raw credential shapes and throws `ExportError` |

## D-27 evidence kind 4

`cyberVisualCapture.ts` renders three deterministic SVG forms from stored evidence: an annotated HTTP exchange panel, a terminal transcript card, and a findings-by-severity bar whose **text labels carry the counts** (never colour alone). Each capture's bytes go through `CyberEvidenceStore.put`, so the picture is on the same chain as the data it shows, and the filename derives from the hash.

The host-browser screenshot is recorded **absent with a reason**, not omitted: the appendix always emits a `Screenshot:` line, using the shared `SCREENSHOT_ABSENT_NOTE` even when no captures were requested at all.

## Deviations from the plan

**1. [Rule 2 — missing critical functionality] `exportRun` lives in `cyberSarifExport.ts`, not `cyberReport.ts`.**
The plan's Task 2 text put `exportRun` in the report module while its acceptance criteria counted `report.md`/`findings.json`/`findings.sarif` occurrences in the *export* module. Putting the bundle writer beside `toSarif` keeps the three formats in one file with one atomic-write helper; `buildPtesReport` stays the Markdown builder and `exportRun` calls it, so there is still one report path.

**2. [Rule 1 — bug] `ExportBundle.markdown` became `ExportBundle.report`.**
The type named the path `markdown` while the file it points at is `report.md`; the test used `report` and caught the mismatch. `report` is the clearer name and matches the criterion's own vocabulary.

**3. [Rule 1 — bug] The screenshot fallback line was duplicated prose.**
`cyberReport.ts` originally carried "no visual capture was requested for this run" while the capture module owned `SCREENSHOT_ABSENT_NOTE`. The report now imports the constant, so the browser-requirement sentence has exactly one definition.

**4. [Rule 1 — bug] Two of my own test assertions were wrong, and both were loosened only where the code was right.**
The Run Diff assertion expected `Resolved since the previous run (1)` but the heading pairs a bold label with the count (`**Resolved…** (1)`). The "never clean" assertion scanned the whole pre-Acceptance report, which legitimately contains the Executive Summary's "That is not a clean bill of health" — the honest negation. It now checks the rendered verdict lines specifically. Separately, the visual test's tag-balance regex was greedy and swallowed `<rect/>`'s self-closing slash; the checker was fixed, not the SVG.

**5. [Rule 1 — bug] The escaping test asserted escaping on a form that renders no finding titles.**
The severity bar draws severity names and counts only, so a hostile finding *title* never reaches it. The test now drives the HTTP-exchange form with a hostile path and body, which is a form that really does interpolate captured text.

## Verification

| Gate | Command | Result |
|---|---|---|
| Lint / typecheck | `npm run lint` | exit 0 |
| Plan + tracer tests | `node --test dist/test/cyberSarif.test.js dist/test/cyberVisualCapture.test.js dist/test/cyberTracer.test.js` | 20 pass, 0 fail |
| Full suite | `npm run compile && node --test dist/test/*.test.js` | 745 tests, 737 pass, 0 fail, 8 skipped |

Acceptance greps:

| Criterion | Required | Actual |
|---|---|---|
| `2.1.0` in the exporter | ≥ 2 | 3 |
| `locations` in the exporter | ≥ 2 | 3 |
| `authorization` | ≥ 2 | 7 |
| clock/randomness in the capture renderer | 0 | 0 |
| `escapeXml` | ≥ 2 | 7 |
| `evidence.put`/`evidenceHash` | ≥ 2 | 13 |
| `SCREENSHOT_ABSENT_NOTE` defined once, referenced by the report | yes | 2 + 2 |
| "host browser" stated | ≥ 1 | 2 |
| `visualCaptures` in the report and the JSON export | ≥ 2 | 5 + 5 |
| `<image`/`href="http` in the renderer | 0 | 0 |
| `from 'vscode'` | none | none |
| `Run Diff` / `resolved` in the report | ≥ 1 each | 1 / 7 |
| `report.md`/`findings.json`/`findings.sarif` | ≥ 3 | 8 |
| one shared acceptance builder | shared | defined in `cyberReport.ts`, imported by the exporter |

## Issues encountered

- `npm run compile` is required before a full run (`scripts/vendor-libs.mjs` vendors `vendor/pdfjs`); without it eight document/graphics tests fail.
- The 25-01 tracer test still passes unchanged after `buildPtesReport` gained an optional fifth parameter, which is the additive-signature check the plan asked for.

## Next phase readiness

- **For 25-08 (panel):** the Export action is `exportRun({ directory, payload, run, ledger, previousFindings, visualCaptures, captureFiles })`. Supply `payload.missingTools` from 25-03's `missingToolsNote(detected)` — an empty string there would defeat D-12.
- **For 25-08 (offensive sequencing):** run one `runOffensiveScan` per candidate and collect the findings; then pass them here with `previousFindings` from the engagement store's prior run to get the diff.
- **Known gap:** `captureForRun` is not yet called by `exportRun` itself; the caller passes `captureFiles`. Wiring it inside `exportRun` is a small change but would make the exporter depend on the evidence store, so it stays an explicit step.

## Self-check: PASSED

Both plan files pass (20/20 including the tracer regression), `npm run lint` exits 0, the full suite is 737 pass / 0 fail, every acceptance grep meets its threshold, no dependency was added, and none of the three modules imports `vscode`.
