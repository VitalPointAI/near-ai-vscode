---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 05
subsystem: team-core
tags: [team-mode, gsd-import, idempotent-import, secret-withholding, size-fit, stale-guard, cas-race]
requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: 62-01 item events and the item.imported body, 62-02 private-ref reads and isAncestor, 62-03 buildGsdGraph and the fixture tree, 62-04 item snapshots
provides:
  - importPlans, which reads the integration branch, builds the graph, cleans and fits every body and writes only the difference as signed items
  - graphToItems, fitItemBody, diffImport, importResultText and listImportableMilestones
  - import.json change detection (treeHash, sourceCommit, milestone asked for) and the stale-leader guard on the milestone item's source commit
  - A live proof on this repository's own .planning at HEAD and a metadata-only canary over the coordination branch
affects: [62-06, 62-07, 62-14]
actuals:
  tokens: 21870
  tasks: 3
  commits: 5
tech-stack:
  added: []
  patterns:
    - "log.append(state => diff) returns a conflict marker when there is nothing to change, so a lost CAS race turns the loser into a no-op"
    - "Clean per field, then fit, then validateBody with the read side's own validator, so one bad string never aborts an import"
    - "A worst-case envelope (longest id, lamport, time, author, device, prev and an 86-character signature) decides whether a body fits MAX_EVENT_BYTES"
key-files:
  created:
    - src/team/importPlans.ts
    - src/test/teamImport.test.ts
    - src/test/teamItemPrivacy.test.ts
  modified:
    - src/domain/team/validate.ts
key-decisions:
  - "A dependency that points outside the imported graph is dropped with a warning, so a plan that waits on an older milestone is not stuck as dependency-missing for ever"
  - "import.json stores the milestone that was asked for ('' means the current one), so an auto run for the current milestone is never skipped because of an earlier explicit archive import"
  - "The fit keeps the first must-have, drops trailing must-haves first, then trailing file paths, then halves the remaining must-haves down to 40 characters; list caps come first and warn"
  - "The permission check runs before any fetch, so a developer's import fails fast with 'not permitted: ...' and touches neither the remote nor the private ref"
  - "A new milestone item carries its source in its own item.imported; an existing one gets a final item.updated source only when other intents exist"
patterns-established:
  - "Stale guard: skip when the commit read is an ancestor of the recorded source; an unknown recorded source skips in auto mode with a warning and proceeds in command mode; the builder asks the guard again if another lead recorded a different source mid-race"
  - "Result text lives next to the result type, and every reason passes through redactGitMessage"
requirements-completed: []
requirements-advanced: [BOARD-01]
coverage:
  - id: D1
    description: "The fixture roadmap on the integration branch becomes 13 signed items in one commit; a second clone materialises byte-identical state; a re-import writes nothing"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamImport.test.js#the fixture roadmap on the integration branch becomes 13 signed items in one commit, a second clone sees the same items and a re-import writes nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "Re-import updates changed fields, never moves a card, cancels what left the roadmap with the fixed reason, keeps finished work and cancelled-by-person cards, and is a no-op on repeat"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamImport.test.js#a pushed roadmap change updates what changed, never moves a card, cancels what left the roadmap and keeps finished work, all as no-op on repeat"
        status: pass
      - kind: integration
        ref: "dist/test/teamImport.test.js#a plan a person cancelled stays cancelled when it is still in the roadmap, and the result counts it so a lead can reopen it"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every text is cleaned per field, secret-like strings are withheld as a fixed placeholder and counted, lists are cut to the validator caps and oversize bodies are fitted, all with warnings that name the item"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamImport.test.js#every text is cleaned per field: control characters and whitespace, code-point cuts, lone surrogates and secret-like strings"
        status: pass
      - kind: integration
        ref: "dist/test/teamImport.test.js#over-cap and oversize plans pushed to the branch are imported trimmed with warnings, nothing else is lost, and a re-import writes nothing"
        status: pass
    human_judgment: false
  - id: D4
    description: "Large roadmaps are written in appends of at most 250 intents with parents first; archived and switched milestones behave; the stale guard and change detection hold; two leads racing write each item once; a developer is refused"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamImport.test.js#600 task items are written in three appends of at most 250 intents, parents before children, and a re-import writes nothing"
        status: pass
      - kind: integration
        ref: "dist/test/teamImport.test.js#when the owner and a lead import at once the coordination CAS turns the loser into a no-op: one item.imported per item"
        status: pass
      - kind: integration
        ref: "dist/test/teamImport.test.js#a developer cannot import: the result carries the permission reason and nothing is written"
        status: pass
    human_judgment: false
  - id: D5
    description: "This repository's own .planning at HEAD imports as milestone v0.6.0 with phases 60 to 67, Phase 60 and 61 plans done with their tasks, the 61-02 bearer-token must-have withheld, and a re-import writes 0 events"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamImport.test.js#this repository's own .planning at HEAD imports into a correct graph, and importing it again writes nothing"
        status: pass
    human_judgment: false
  - id: D6
    description: "No objective, context or action text and no secret-like string reaches the coordination branch, a mirror, import.json or team.json"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamItemPrivacy.test.js#an import writes only metadata: no objective, context or action text and no secret-like string reaches the coordination branch, a mirror, the import state or team.json"
        status: pass
    human_judgment: false
  - id: D7
    description: "A lead's import of the real repository on the real integration branch reads correctly on the owner's machine"
    requirement: BOARD-01
    verification: []
    human_judgment: true
    rationale: "Whether the board matches the roadmap as the owner sees it needs the owner's own eyes on a real remote; tests prove the graph from a committed ref, not the owner's judgment of it"
duration: about 40 min (start time was not recorded; estimated from the first commit)
completed: 2026-11-02
status: complete
plan_head_before: 92cd4303edfad15886a0cad2705cdc31853dd925
plan_head_after: 30d308d5926949b404b30b863feffd3f8d9d0275
commits: 5
---

# Phase 62 Plan 05: Import Summary

**An idempotent importer turns the integration branch's GSD files into signed milestone, phase, plan and task items: cleaned, secret-withheld and size-fitted per field, diffed against the log so a repeat writes nothing, chunked at 250 intents, guarded against stale leads, and proven on two clones, a two-lead race and this repository's own roadmap.**

## Performance

- **Duration:** about 40 min (the start time was not recorded)
- **Completed:** 2026-11-02T18:57Z
- **Tasks:** 3 (1 tracer, 2 auto), all TDD
- **Files:** 3 created (`src/team/importPlans.ts`, `src/test/teamImport.test.ts`, `src/test/teamItemPrivacy.test.ts`), 1 modified (`src/domain/team/validate.ts`, exports only)

## Accomplishments

- The tracer pushes the fixture roadmap to a bare remote and imports it from the private ref as 13 items (milestone, 4 phases, 3 plans, 5 tasks) in exactly one coordination commit. A second clone materialises byte-identical state, and a second import writes nothing and makes no commit.
- Re-import compares the imported-field projection with the stored item: new ids get `item.imported`, changed ones get `item.updated` with only the changed keys, state is never touched, items of the imported milestone that left the roadmap and are not done or cancelled get `item.cancelled` with "no longer in the roadmap", and the milestone's source commit is written last and only when something else changed. Done items and person-cancelled cards survive; the latter are counted in `reopenNeeded`.
- Cleaning is per field before any event is built: whitespace collapsed, control characters removed, lone surrogates replaced, code-point-safe cuts, and a secret-like string replaced by the fixed placeholder and counted. Lists are cut to the 62-01 validator caps with a warning that names the item, and a body whose signed event would pass `MAX_EVENT_BYTES` is shrunk in a fixed order. No single string or oversize plan aborts an import.
- Appends are chunked at 250 intents with parents first (614 items go in as 250, 250 and 114), the stale guard uses `isAncestor`, and the two-lead race ends with exactly one `item.imported` per item (one result wrote 13, the other 0).
- Importing this repository's own `.planning` at HEAD gives `milestone:v0.6.0` (active), phases 60 to 67, every Phase 60 and 61 plan done with its tasks, 149 items in all, the 61-02 bearer-token must-have withheld, and a re-import writes 0 events.
- The privacy canary shows that objective, context and action text and an `sk-` string never reach the coordination branch, the owner's mirror, `import.json` or `team.json`. A control shows the same scanner finds them on the code branch.

## Task Commits

1. **Task 1: Tracer** - RED `3a4bb3e` (test), GREEN `0ca6994` (feat)
2. **Task 2: Updates, cancels, cleaning, caps, chunks, milestones, stale guard, race, permissions** - tests `48c463e` (test), fix `be81532` (fix)
3. **Task 3: Live import and privacy canary** - `30d308d` (test)

**Plan metadata:** the docs commit that adds this file.

Tracer gate: auto mode, the tracer's `<verify>` was re-run before Task 2 and passed (Tracer verified end-to-end, expanding).

## Files Created/Modified

- `src/team/importPlans.ts` - cleaning helpers, `fitItemBody`, `graphToItems`, `diffImport`, `importPlans`, `importResultText`, `listImportableMilestones`, import state read and write
- `src/test/teamImport.test.ts` - 19 tests over real git: tracer, re-import, cancel, cleaning, caps and size fit, chunking, milestones, stale guard, change detection, race, permissions, result text, live HEAD
- `src/test/teamItemPrivacy.test.ts` - metadata-only and secret canary over the coordination ref, mirror, import state and team.json
- `src/domain/team/validate.ts` - `export` added to the item limit and pattern constants the fit step needs

## Decisions Made

- **Dependencies outside the graph are dropped, with a warning.** A plan that waits on a plan of an older milestone would otherwise read `dependency-missing` for ever and never become ready. The cost is that an archived milestone imported later does not retroactively restore such a dependency.
- **`import.json` records the milestone that was asked for** (empty meaning the current one), not the resolved key, so the unchanged-tree skip in auto mode compares like with like.
- **Fit order:** list caps, then trailing must-haves (the first stays), then trailing file paths, then must-haves halved to 40 characters, then a last resort that cannot be reached with legal input. A 16 by 600-character must-have plan with 64 paths of 200 characters therefore keeps all 64 paths and loses most must-haves; the warning says so.
- **The developer refusal is decided before any git work**, using the same `decideTeamAction` question the writer and reader ask; the message is `not permitted: only the team owner and leads can import plans`.
- The milestone's `item.imported` carries `source` and `active` itself; later batches add `source` last, only when other intents exist.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The item limits were not exported from validate.ts**
- **Found during:** Task 1 (the fit step)
- **Issue:** The wiring note from 62-04 said the validator limits were exported; only `TITLE_MAX` and `REASON_MAX` were. The importer needs the caps and patterns so it cannot drift from the read side.
- **Fix:** Added `export` to `DESCRIPTION_MAX`, `MUST_HAVE_MAX`, `MAX_SCOPE_ENTRIES`, `MAX_REQUIREMENTS`, `MAX_MUST_HAVES`, `MAX_DEPENDENCIES`, `MAX_TAGS`, `MAX_ESTIMATE_TOKENS`, `MAX_WAVE`, `REQUIREMENT_PATTERN`, `ITEM_TAG_PATTERN`, `GSD_PHASE_PATTERN`, `GSD_PLAN_PATTERN` and `COMMIT_PATTERN`. No behavior change.
- **Files modified:** src/domain/team/validate.ts
- **Committed in:** 0ca6994

**2. [Rule 1 - Bug] The reopen sentence said "reopen they" for more than one plan**
- **Found during:** Task 2 (the result text test)
- **Issue:** `importResultText` used the subject pronoun for the object.
- **Fix:** "reopen them if they should continue" for several, "reopen it if it should continue" for one.
- **Files modified:** src/team/importPlans.ts
- **Verification:** `importResultText says what happened in plain words` failed in RED `48c463e`, passes after `be81532`.
- **Committed in:** be81532

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Neither changes scope. The plan's `files_modified` did not list `validate.ts`; the change is export-only.

## TDD Gate Compliance

- **RED (Task 1):** `3a4bb3e`. The module existed as a compiling stub that threw "not implemented", so the tracer failed when the stubbed `importPlans` ran (the 62-02 precedent). Semantic assessment: the target test ran to the importer call and failed because the behavior did not exist, not through a build or fixture fault. `gsd_run check tdd-red-evidence` was not run.
- **GREEN (Task 1):** `0ca6994`. No REFACTOR commit was needed.
- **Task 2:** the full implementation was written with the tracer, so 17 of the 18 tests passed on arrival and are characterisation of that behavior, recorded here rather than hidden. The one genuine RED was `importResultText says what happened in plain words` (`48c463e`), fixed in `be81532`. Mutation checks showed the tests bite: cancelling done items fails the cancel test, removing the stale skip fails both stale-guard tests, and turning off secret withholding fails nine tests including the privacy canary. All mutations were reverted before commit.
- **Task 3:** test-only by the plan ("no production change is expected"), so there is no RED; it passed on arrival and the secret-withholding mutation above shows the live and privacy tests are not vacuous.

## Issues Encountered

- The file-writing tool turned `   ` in a regular expression into literal separator characters (as in 62-01); they were restored to escape sequences before the first compile.
- The 600-task test first counted four coordination commits, not three: the log writes a snapshot after 500 events. The test now counts only commits that carry item events.
- My first expectation that the live import has "a few hundred" items was wrong: HEAD has 149 (Phases 63 to 67 have no plan files yet), so the assertion is structural.

## Known Stubs

None.

## Threat Flags

None. T-62-14 to T-62-18 are implemented as planned: per-field `findSecrets` with a fixed placeholder, a projection limited to titles, ids, globs, requirement ids, estimates, waves, tags and truth strings, diff-based no-op with the stale guard and chunk and round caps, cleaning plus list caps plus the size fit before `validateBody`, and `item.imported` mapped to `item.create` with `ownDraft` false. No package was installed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Ready for 62-06 and the board: `importPlans`, `importResultText` and `listImportableMilestones` are the surface the session auto-import gate and the `NEAR AI: Import Plans to Team Board` command call. `skipped: 'unchanged-tree'` and `skipped: 'stale-source'` tell the caller nothing was written; `warnings` and `withheld` are for the report text; `reopenNeeded` feeds the "reopen them" sentence.
- The owner's hands-on check that the board matches the roadmap on the real remote is the one backstop item (coverage D7).
- BOARD-01 is advanced, not complete: it is ticked only by plan 62-14.

## Self-Check: PASSED

- Files exist: `src/team/importPlans.ts`, `src/test/teamImport.test.ts`, `src/test/teamItemPrivacy.test.ts`.
- Commits found on this branch: 3a4bb3e, 0ca6994, 48c463e, be81532, 30d308d.
- Acceptance greps match (`export async function importPlans`, `IMPORT_NOOP`, `NOT_IN_ROADMAP` and `WITHHELD_TEXT` in the test, `createRig`, `export function fitItemBody`, `MAX_EVENT_BYTES` in the test, `ref: 'HEAD'`, `CANARY-ACTION-62`); no `from 'vscode'` in `importPlans.ts`.
- `npm run lint` exits 0; `node --test dist/test/team*.test.js`: 827 tests, 825 pass, 0 fail, 2 skipped (unchanged skips).

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-02*
