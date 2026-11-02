---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 03
subsystem: team-core
tags: [team-mode, gsd-import, parser, frontmatter, roadmap, hostile-input]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: 62-02 reads .planning from a private ref and hands paths plus capped texts to the parser (source shape GsdSource)
provides:
  - gsdImport.ts, a pure dependency-free parser from ROADMAP.md, STATE.md and *-PLAN.md texts to one milestone graph (phases, plans, tasks, dependencies, scope, estimate, requirements, wave, truths, SUMMARY state)
  - A committed fixture planning tree (test/fixtures/gsd-import/planning) reusable by the importer and the e2e team scenario
  - A survey test that parses every plan committed at HEAD and pins this repository's v0.6.0 graph shape
affects: [62-05, 62-06, 62-14]

actuals:
  tokens: 14600
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Identity comes from the file name (NN-MM-PLAN.md), never from frontmatter; the frontmatter phase is only cross-checked and a mismatch is a warning"
    - "Targeted frontmatter reader: only known keys are read, every other key and its indented children are skipped; parsed values live in locals, Sets and Maps and are never spread"
    - "Every scan is one linear pass with caps: 400 frontmatter lines, 4000 characters per line, 64 list entries, 50 tasks per plan, 2000 plans, 100 warnings of at most 200 characters, 200 milestones, 500 sections, 2000 roadmap phases"
    - "Orphan plans (phase in no milestone) are skipped with one warning; plans of another known milestone are skipped silently"

key-files:
  created:
    - src/domain/team/gsdImport.ts
    - src/test/teamGsdImport.test.ts
    - test/fixtures/gsd-import/planning/ROADMAP.md
    - test/fixtures/gsd-import/planning/STATE.md
    - test/fixtures/gsd-import/planning/phases/90-alpha/90-01-PLAN.md
    - test/fixtures/gsd-import/planning/phases/90-alpha/90-01-SUMMARY.md
    - test/fixtures/gsd-import/planning/phases/90-alpha/90-02-PLAN.md
    - test/fixtures/gsd-import/planning/phases/91.1-beta-fix/91.1-01-PLAN.md
    - test/fixtures/gsd-import/planning/milestones/v0.1.0-phases/01-start/01-01-PLAN.md
  modified: []

key-decisions:
  - "The Roadmap type also keeps the checklist wave label and the trailing requirement group per plan entry; both are fallbacks used only when a plan has no frontmatter value"
  - "An archived milestone with no roadmap section is built from its bullet range and only the plan files under .planning/milestones; phase titles come from the folder slug (leading number and phases- prefix removed, first letter capitalised)"
  - "GsdMilestone.current always means the repository's current milestone (STATE.md, then the construction sign, then the bullet that says current), so an archived graph reports current false"
  - "A missing closing task tag ends the task scan: a closing tag must follow a start tag, so no later task can close either, which keeps a flood of unclosed tags linear"
  - "The task fallback for plans without task elements takes the ### headings under ## Tasks when present (the archived v0.4.0 shape) and the top-level bullets otherwise"

patterns-established:
  - "Parser exports are pure functions of texts and paths; the importer (62-05) will do the code-point-safe truncation, the secret placeholder and the item id mapping"
  - "Survey tests assert structural invariants only (phase list, counts for finished phases, every plan parses) so they keep passing as phases add plans"

requirements-completed: []
requirements-advanced: [BOARD-01]

coverage:
  - id: D1
    description: "The fixture roadmap parses into a milestone, ordered phases (including an inserted decimal phase and an empty phase), plans and tasks with dependencies, scope, estimate, confidence, wave, requirements, must-have truths and SUMMARY state"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#the fixture roadmap becomes a milestone, phases, plans and tasks with dependencies, scope, estimate and SUMMARY state"
        status: pass
    human_judgment: false
  - id: D2
    description: "Plan identity comes from the file name with leading zeros removed from the phase and the plan padded to two digits; the frontmatter reader takes inline, quoted inline and block lists and skips every other key"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#plan identity comes from the file name: leading zeros leave the phase, decimal phases survive, summaries are told apart"
        status: pass
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#the frontmatter reader takes inline, quoted inline and block lists and skips every other key"
        status: pass
    human_judgment: false
  - id: D3
    description: "CRLF files give the same graph as LF files; an archived milestone is built from its bullet range with plans that have no frontmatter; orphan plans are skipped with one warning; the current milestone order is STATE.md, construction sign, current bullet"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#the same files with CRLF line endings give the same graph"
        status: pass
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#an archived milestone is built from its bullet range and the folders under milestones, with plans that have no frontmatter"
        status: pass
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#a plan whose phase is in no milestone is skipped with one warning, and not warned about when an archived copy exists"
        status: pass
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#the current milestone comes from STATE.md, then the construction sign, then the bullet that says current"
        status: pass
    human_judgment: false
  - id: D4
    description: "Hostile input is bounded and inert: a 1 MB frontmatter, a __proto__ key, unterminated blocks, thousands of list items, unclosed task tags and milestone floods return problems and capped results quickly without polluting Object.prototype (T-62-09, T-62-10)"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#frontmatter hostile input is bounded and inert"
        status: pass
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#a flood of unclosed task tags and of milestone bullets is read in bounded time"
        status: pass
      - kind: unit
        ref: "dist/test/teamGsdImport.test.js#a task element without a closing tag is ignored and a task count above the cap is cut"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every plan committed at HEAD parses; HEAD gives current milestone v0.6.0 with phases 60 to 67 in order, 12 plans in phase 60 and 14 in phase 61 each with a SUMMARY, and as many phase 62 plans as plan files"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamGsdImport.test.js#every plan committed at HEAD parses, and HEAD gives milestone v0.6.0 with phases 60 to 67 and finished phases 60 and 61"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-11-02
status: complete
plan_head_before: c894f9c3a10690468f7fe5c1389e3c2ac4eab429
plan_head_after: 577f3b2cf6774b795e5859c2128fc3d501c36229
commits: 4
---

# Phase 62 Plan 03: GSD parser and work graph Summary

**A pure, dependency-free parser that turns ROADMAP.md, STATE.md and *-PLAN.md texts into one milestone graph of phases, plans and tasks with dependencies, scope, estimate, wave, requirements, truths and SUMMARY state, identity taken from file names, every scan capped and linear, proven on a committed fixture tree and on every plan at this repository's HEAD.**

## Performance

- **Duration:** about 10 min
- **Started:** 2026-11-02T18:10:00Z
- **Completed:** 2026-11-02T18:21:00Z
- **Tasks:** 2 (1 tracer, 1 auto), both TDD
- **Files:** 9 created (parser, test, 7 fixture files), none modified

## Accomplishments

- The fixture tree (Phases 90 to 92 plus the inserted 91.1 and an archived phase 1) builds the exact graph the board needs: milestone v0.9.0 current, phases 90, 91, 91.1, 92 with dependencies [], [90], [91], [], plan 90-01 with SUMMARY and two tasks (titles stripped of "Task N:"), plan 90-02 depending on 90-01 with gap closure and three truths (the one mentioning a bearer token kept verbatim for the importer to sanitise), plan 91.1-01 depending on 90-02.
- Plan identity comes only from the file name (`05.1-02-PLAN.md` is phase 5.1 plan 02); the frontmatter phase is cross-checked and a disagreement becomes a warning. Plans of other known milestones are skipped silently, orphans (phase in no milestone, such as this branch's Phase 25 plans) get exactly one warning.
- The frontmatter reader reads only phase, plan, wave, depends_on, files_modified, requirements, autonomous, gap_closure, estimate and must_haves.truths in inline, quoted inline and block forms, skips every other key by indentation, and treats CRLF like LF.
- Archived milestones build from the Milestones bullet range plus the folders under `.planning/milestones` (plans without frontmatter use their Tasks headings or bullets and have no estimate).
- At HEAD the survey parses every committed plan, finds milestone v0.6.0 current with phases 60 to 67 in order, 12 plans in Phase 60 and 14 in Phase 61 all with SUMMARY files.

## Task Commits

1. **Task 1 (tracer): fixture roadmap to graph** - `5d52550` (test), `7c68501` (feat)
2. **Task 2: variants, hostile input, archived milestones, HEAD survey** - `34a2f6d` (test), `577f3b2` (feat)

Tracer gate: auto mode, the tracer `<verify>` (tsc plus the node:test file) was re-run end to end and passed before Task 2 started (Tracer verified end-to-end - expanding).

**Plan metadata:** the docs commit that carries this file.

## Files Created/Modified

- `src/domain/team/gsdImport.ts` - the parser and graph builder (exports planIdentity, normalisePhase, parseFrontmatter, parsePlanTasks, parseRoadmap, currentMilestoneKey, buildGsdGraph and the Gsd*, PlanFrontmatter, Roadmap types)
- `src/test/teamGsdImport.test.ts` - 14 tests: fixture graph, identity, frontmatter, CRLF, archived milestone, errors, current milestone, orphans, hostile input, floods, surrogates, requirement ranges, HEAD survey
- `test/fixtures/gsd-import/planning/**` - real-shape roadmap, state, three plans, one summary, one archived plan (invented phase numbers 90 to 92 and 1, FIX requirement ids)

## Decisions Made

See `key-decisions` in the frontmatter. In short: file names own identity, archived milestones use only the milestones folder, `current` means the repository's current milestone, a missing closing task tag ends the task scan, and the Tasks fallback prefers `###` headings over bullets.

## TDD Gate Compliance

- RED (Task 1): `5d52550`. The module existed as a stub that threw "not implemented", so the file compiled and all three tests failed when the stub ran. This is the same compiling-RED mechanism used in 62-02; the failure is a stub throw rather than an assertion on the planned values. Semantic assessment: all three target tests executed and failed because the behavior did not exist. The `gsd_run check tdd-red-evidence` classifier was not run.
- GREEN (Task 1): `7c68501`, all three tests pass, lint exits 0.
- RED (Task 2): `34a2f6d`. Of the 11 tests added, 10 passed on arrival because the tracer implementation already contained the caps, whitespace collapse and CRLF handling; they are regression coverage, not RED proof. One test genuinely failed: the flood of unclosed task tags (60,000 start tags without a closing tag) took 24.4 seconds because each candidate rescanned to the end of the text (quadratic). To check the passing tests are not vacuous, five of them were mutation-checked against the compiled output (list cap 64 raised, frontmatter line cap raised, orphan warning removed, CR stripping disabled, task cap raised); each mutation made exactly the expected test fail. A sixth mutation (removing the known-key allow-list) was not caught, because the switch statement ignores unknown keys anyway; the allow-list is defence in depth.
- GREEN (Task 2): `577f3b2`. The flood test now finishes in 57 ms.
- No REFACTOR commit was needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Quadratic scan on unclosed task tags and unbounded roadmap lookups**
- **Found during:** Task 2 (threat T-62-09 review while adding the flood test)
- **Issue:** `parsePlanTasks` searched to the end of the text for `>` and `</task>` from every unclosed `<task` candidate; roadmap milestone, section and phase counts were unbounded and the orphan check scanned every section's phase list per orphan plan.
- **Fix:** Start tag read in a 400-character window, a missing `</task>` ends the scan, milestone (200), section (500) and roadmap phase (2000) caps with a recorded problem, and a Set for the known-phase lookup.
- **Files modified:** src/domain/team/gsdImport.ts
- **Verification:** the flood test (24.4 s before, 57 ms after) and the full 14-test file
- **Committed in:** `577f3b2`

**2. [Rule 2 - Missing critical] Non-ASCII characters written as escapes in source**
- **Found during:** Task 2 (project rule: no em-dashes)
- **Issue:** The roadmap dash and ellipsis alternatives were stored as literal glyphs in a regex.
- **Fix:** Written as `—`, `–`, `…` and `\u{1F6A7}` escapes; behavior unchanged. The fixture ROADMAP keeps a literal em dash on purpose because it copies the real roadmap shape.
- **Files modified:** src/domain/team/gsdImport.ts
- **Committed in:** `577f3b2`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical)
**Impact on plan:** Both inside the plan's own mitigation scope (T-62-09). No scope creep.

## Issues Encountered

None.

## Known Stubs

None. The temporary stub module in the first RED commit was replaced in the same task.

## Threat Flags

None. The module is pure (no I/O, no clock, no vscode, no new dependency). T-62-09 (denial of service) is mitigated by single linear passes, the caps listed above and the timing tests; T-62-10 (prototype keys) by the known-key allow-list, locals and Sets, and the pollution test. T-62-SC: no package installs, package.json unchanged.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Ready for the plans that consume the graph (62-05 importer). Wiring notes for them:

- `buildGsdGraph({ paths, files })` takes paths relative to the repository root (`.planning/...`) and the capped texts 62-02 returns for ROADMAP.md, STATE.md and every `*-PLAN.md`; `*-SUMMARY.md` needs only to appear in `paths`.
- `GsdPlan.dependsOn` uses the normalised `61-09` form, `GsdPhase.dependsOn` the normalised phase number (`91.1`); the importer turns both into item ids.
- Titles and truths come back whitespace-collapsed but not truncated or secret-checked: the importer must truncate by code points and replace secret-like strings (the fixture truth mentioning a bearer token is the test case).
- `GsdGraph.warnings` lists orphan plans, duplicate plan files and frontmatter mismatches (at most 100, 200 characters each) for the import report.
- `buildGsdGraph(source, { milestone })` builds an archived milestone on request; an unknown milestone or a missing ROADMAP.md returns `{ error }`.

## Self-Check: PASSED

- FOUND: src/domain/team/gsdImport.ts, src/test/teamGsdImport.test.ts, the seven files under test/fixtures/gsd-import/planning
- FOUND commits: 5d52550, 7c68501, 34a2f6d, 577f3b2 (all ancestors of HEAD)
- `npx tsc -p tsconfig.json && node --test dist/test/teamGsdImport.test.js`: 14 tests, 14 pass; `npm run lint` exits 0; `node --test dist/test/team*.test.js`: 779 tests, 777 pass, 0 fail.
- Acceptance: `export function buildGsdGraph` matches, the SUMMARY fixture exists, `grep -c "bearer token"` on 90-02-PLAN.md prints 1, `ls-tree` matches in the test, no `node:fs`, `node:child_process` or `vscode` import in the module.
