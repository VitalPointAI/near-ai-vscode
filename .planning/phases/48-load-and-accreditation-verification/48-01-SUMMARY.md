---
phase: 48-load-and-accreditation-verification
plan: 01
subsystem: compliance
tags: [oscal, compliance-dashboard, levels, accreditation, docs-site]

requires:
  - phase: 44-accreditation-evidence-and-compliance-dashboard
    provides: levels.json, the status engine (no-statement for silent in-scope components, #160), controlText, LevelPage
provides:
  - hosted-protected-a, hosted-protected-b and hosted-itsp-10-171 entries in compliance/levels.json
  - thirteen no-statement OSCAL component definitions (workbench plus the twelve Phase 47 platform ids)
  - catalogue titles and text drawer for hosted rows (controlText level ids)
  - hosted Protected A and Protected B docs pages on the shared LevelPage component
affects: [48-02, 48-05, 48-06, 48-07, 48-08, 48-09, 48-10, phase-46, phase-47]

actuals:
  tokens: 6970
  tasks: 2
  commits: 4
plan_head_before: bbba39932adf4539852b4ca61820babe371ff6f7
plan_head_after: ad86db0d40c0ca25cbf80be72f9801745bdd4272

tech-stack:
  added: []
  patterns:
    - "Hosted scope as separate levels.json entries reusing existing profiles (no status-engine change)"
    - "Component definition with no control-implementations, so every in-scope row reads No statement yet"
    - "Real-sources bundle in tests through the bundle CLI; a linked copy of compliance/ with a filtered levels.json for with/without comparisons"

key-files:
  created:
    - compliance/components/workbench.json
    - compliance/components/rke2.json
    - compliance/components/image-registry.json
    - compliance/components/ingress.json
    - compliance/components/cert-manager.json
    - compliance/components/keycloak.json
    - compliance/components/theia-cloud.json
    - compliance/components/oauth2-proxy.json
    - compliance/components/openbao.json
    - compliance/components/hsm.json
    - compliance/components/site-storage.json
    - compliance/components/site-logging.json
    - compliance/components/offline-bundle.json
    - docs-site/content/accreditation/hosted-protected-a.mdx
    - docs-site/content/accreditation/hosted-protected-b.mdx
  modified:
    - compliance/levels.json
    - compliance/src/controlText.ts
    - compliance/test/levels.test.ts
    - compliance/test/components.test.ts
    - docs-site/test/pages.test.mjs

key-decisions:
  - "All twelve platform component files are new: origin/main (846e04b9) had only the six existing components, so no Phase 47 file needed reconciling and no reserved-boundary statement was dropped."
  - "Hosted pages do not claim to show the hosted ITSP.10.171 overlay rows, because LevelPage renders only rows of its own levelId."
  - "site-logging names no product (log store under a licence other than the AGPL); ingress names no controller, because neither is a landed Phase 47 choice."

patterns-established:
  - "A hosted level lists components in the fixed order rke2 ... offline-bundle, workbench, release-pipeline, hub; levels.test.ts pins it."

requirements-completed: [VER-04, VER-07]

coverage:
  - id: D1
    description: "Three hosted levels.json entries (hosted-protected-a, hosted-protected-b, hosted-itsp-10-171) listing the fifteen hosted components in order; existing levels unchanged"
    requirement: VER-04
    verification:
      - kind: unit
        ref: "compliance/test/levels.test.ts#each hosted level and the hosted overlay list exactly the hosted components, in order"
        status: pass
      - kind: unit
        ref: "compliance/test/levels.test.ts#the existing levels and overlays list exactly the components they listed before"
        status: pass
      - kind: unit
        ref: "compliance/test/levels.test.ts#the existing Protected B rows and counts are the same as in a bundle without the hosted entries"
        status: pass
    human_judgment: false
  - id: D2
    description: "Thirteen component definitions with no statements; each file's component-id equals its file name"
    requirement: VER-04
    verification:
      - kind: unit
        ref: "compliance/test/components.test.ts#every component definition loads as OSCAL content, one per file, named by its component id"
        status: pass
      - kind: unit
        ref: "compliance/test/levels.test.ts#every component a level lists has a definition file named by its id"
        status: pass
      - kind: other
        ref: "node scripts/resource-check.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "Hosted rows titled from the catalogue, platform and workbench rows read No statement yet, none reads Met"
    requirement: VER-04
    verification:
      - kind: integration
        ref: "compliance/test/levels.test.ts#a hosted Protected B row carries the catalogue title and an honest workbench row, in levels.json order"
        status: pass
      - kind: integration
        ref: "compliance/test/levels.test.ts#every hosted platform row of hosted Protected B ac-02 reads No statement yet"
        status: pass
      - kind: integration
        ref: "compliance/test/levels.test.ts#no hosted component without statements reads Met on any hosted row"
        status: pass
    human_judgment: false
  - id: D4
    description: "Hosted Protected A and Protected B docs pages on AccreditationData and LevelPage, opening with Your organization decides, passing the word lint"
    requirement: VER-07
    verification:
      - kind: unit
        ref: "docs-site/test/pages.test.mjs#hosted level pages open with the organization decision and use the shared level page"
        status: pass
      - kind: unit
        ref: "docs-site/test/pages.test.mjs#pages have no prohibited claim wording"
        status: pass
    human_judgment: true
    rationale: "Hosted levels are a gate-path scope decision (D-18); the owner approves the hosted levels, the hosted overlay and the page wording at the 48-06 gate checkpoint."

duration: 10min
completed: 2026-11-24
status: complete
---

# Phase 48 Plan 01: Hosted scope on the compliance dashboard Summary

**Hosted Protected A, Protected B and ITSP.10.171 levels with thirteen no-statement OSCAL components (workbench plus the twelve Phase 47 platform ids), titled rows, and two hosted docs pages; every hosted platform row reads "No statement yet" and the existing levels are unchanged.**

## Performance

- **Duration:** about 10 min of wall time measured by the system clock (start 2026-11-24T03:19:23Z, last commit 2026-11-24T03:28Z)
- **Tasks:** 2 (both TDD: RED then GREEN commits)
- **Files:** 15 created, 5 modified

## Accomplishments

- `compliance/levels.json`: `hosted-protected-a` (profile `profiles/protected-a.json`), `hosted-protected-b` (profile `profiles/itsp-10-033-01-medium.json`) and the overlay `hosted-itsp-10-171` (profile `profiles/itsp-10-171-overlay.json`, attached to both hosted levels). Each lists, in order: rke2, image-registry, ingress, cert-manager, keycloak, theia-cloud, oauth2-proxy, openbao, hsm, site-storage, site-logging, offline-bundle, workbench, release-pipeline, hub.
- Thirteen component definitions with no `control-implementations` section, so no hosted row can show a statement or read Met (D-11, D-12, T-48-02).
- `controlText.ts`: hosted level ids added to the `itsp-10-033` and `itsp-10-171` catalogue entries, so hosted rows carry the catalogue title and text file (Pitfall 4).
- Docs pages `hosted-protected-a.mdx` (sidebar 13) and `hosted-protected-b.mdx` (sidebar 14) that reuse `AccreditationData` and `LevelPage`.

## Bundle over the real sources (local, `kind: pr`, no collectors)

| Level | Rows | Met | Not met | Your organization's responsibility |
|-------|------|-----|---------|-----------------------------------|
| hosted-protected-a | 417 | 0 | 304 | 113 |
| hosted-protected-b | 417 | 0 | 304 | 113 |
| hosted-itsp-10-171 | 131 | 0 | 0 | 131 |
| protected-b (before and after) | 417 | 0 | 304 | 113 |

The other existing levels kept the same counts as well: unclassified 13 rows, protected-a 417, classified 179, itsp-10-171 131, cpcsc-level-1 13, overlay-cgp 22, overlay-itar 14.

`dashboard/dashboard.json` size: **2,618,514 bytes before** the hosted entries and **7,661,686 bytes after**, about 2.9 times larger. That is below the 16 MiB (16,777,216 bytes) default cap of `loadJson` in `compliance/src/validate.ts`. No new limit was set; the number is here for the docs site.

## Task Commits

1. **Task 1 (tracer): hosted Protected B with the workbench, through the bundle to a titled row and page**
   - RED `f0c866cd` test(48-01): add failing tests for the hosted Protected B level and workbench component
   - GREEN `f96d598d` feat(48-01): hosted Protected B level with the workbench component and its page
   - Tracer gate (auto mode): verify was re-run end to end and passed before Task 2 started.
2. **Task 2: the twelve platform components, both hosted levels and the hosted overlay, hosted Protected A page**
   - RED `c543baf2` test(48-01): add failing tests for the hosted platform components and overlay
   - GREEN `ad86db0d` feat(48-01): hosted platform components in both hosted levels and the hosted overlay

## TDD Gate Compliance

- Task 1 RED: `gsd-tools check tdd-red-evidence` returned `RED_EVIDENCE_OK` (target "a hosted Protected B row carries the catalogue title and an honest workbench row, in levels.json order"). 4 of 32 tests failed, each on an assertion about the missing hosted level, workbench file or page; none failed from load or syntax errors.
- Task 2 RED: `RED_EVIDENCE_OK` (target "each hosted level and the hosted overlay list exactly the hosted components, in order"). 4 of 36 tests failed, each on a missing component, list entry or page.
- Three new tests are regression guards and passed on the base: "every component a level lists has a definition file", "the existing levels and overlays list exactly the components they listed before" and "the existing Protected B rows and counts are the same as in a bundle without the hosted entries". They protect existing behaviour (T-48-01), so they are not expected to fail first.

## Component files: created or reconciled

All thirteen are **created**. I listed `compliance/components/` on `origin/main` at `846e04b9` and found only the six existing files (appliance, extension, hub, model-endpoints, relay, release-pipeline), so no Phase 47 file was on main and nothing needed reconciling (objective choice 3 did not apply). The Phase 47 plans (`47-CONTEXT.md` D-53) use exactly the ids in choice 2, so there was no id deviation to report. Each file has fresh v4 uuids, `last-modified` 2026-11-23, and OSCAL type `hardware` (hsm), `service` (keycloak, openbao, theia-cloud, oauth2-proxy, image-registry, site-logging) or `software` (the rest).

## Gate-path files touched (join the 48-06 combined gate PR)

- `compliance/levels.json`
- `compliance/components/` (13 new files)
- `compliance/src/controlText.ts`

Not gate paths: `compliance/test/*`, `docs-site/*`.

## Decisions Made

See `key-decisions` in the frontmatter. One more: the with/without comparison test strips `collectedAt` before comparing, because each bundle stamps its own collection time. Every other field of the protected-b rows and counts must match exactly.

## Deviations from Plan

**1. [Rule 1 - Bug] Hosted Protected A page wording**
- **Found during:** Task 2
- **Issue:** My first draft said the page shows the hosted ITSP.10.171 overlay rows, but `LevelPage` filters rows to its own `levelId`, so the page would not show them.
- **Fix:** Removed the overlay mention. The page now matches the Protected B page.
- **Files modified:** docs-site/content/accreditation/hosted-protected-a.mdx (before its commit)
- **Committed in:** ad86db0d

**Total deviations:** 1 auto-fixed (Rule 1). **Impact:** wording only; keeps the page honest.

## Issues Encountered

These existing problems are out of scope and were not fixed. They are recorded here instead of in a new `deferred-items.md`, to avoid a merge conflict with the sibling plans:
- `docs-site/content/accreditation/protected-a.mdx` says the page "includes the ITSP.10.171 overlay rows", but `LevelPage` renders only `protected-a` rows.
- `controlled-goods-canada.mdx` and `itar.mdx` pass `levelId="controlled-goods-canada"` and `levelId="itar"`, but the levels are `overlay-cgp` and `overlay-itar`, so those pages probably render no rows. Worth checking in 48-06 or a docs fix.
- The hosted ITSP.10.171 overlay has no page of its own, the same as the existing ITSP.10.171 overlay.

## Verification run (tests run, none added beyond those listed above)

- Task 1 verify: `npm --prefix compliance run lint` passed; `node scripts/run-tests.mjs` on levels, components and pages: 32 tests, 32 passed, 0 failed; `compliance validate` reported no problems.
- Task 2 verify: lint passed; full compliance suite: 501 tests, 501 passed, 0 failed; `docs-site/test/pages.test.mjs`: 13 tests, 13 passed; `validate` reported no problems; `scripts/resource-check.mjs` passed with 54 resources.
- All acceptance criteria passed: grep counts 1/1/1 and 1/1, 19 component files, no implemented requirements on the 13 hosted ids.

## User Setup Required

None.

## Next Phase Readiness

- 48-07 (workbench) and 48-08 (platform components) can add statements to these files as the behaviour lands.
- 48-06 carries the owner gate checkpoint, which covers the hosted levels, the hosted ITSP.10.171 overlay (D-18 owner item 2) and the question about CPCSC, CGP and ITAR hosted overlays.
- Expect a merge with 48-02 or 48-05 if either also edits `compliance/test/components.test.ts` or `levels.json`.

## Self-Check: PASSED

- All 15 created files exist on disk.
- Commits f0c866cd, f96d598d, c543baf2 and ad86db0d are ancestors of HEAD; 4 commits since plan_head_before.

---
*Phase: 48-load-and-accreditation-verification*
*Completed: 2026-11-24*
