---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 17
subsystem: ui
tags: [team-mode, board, webview, manifest, g-62-1, owner-amendments]
status: complete

requires:
  - phase: 61-15
    provides: "Command titles and the Team section's Open board (package.json commands untouched here)"
  - phase: 61-19
    provides: "nearAi.team.share (package.json untouched outside contributes.views)"
  - phase: 61-22
    provides: "Phase 61 fix pass complete"
provides:
  - "package.json: the NEAR AI container (nearAiSecondaryViewContainer) lists only nearAiChatView; nearAiTeamBoardView is gone"
  - "src/services/team/boardView.ts: registerTeamBoard registers no view provider; openPanel (called only by nearAi.team.openBoard) makes the one editor tab; boardHtml(webview, media, nonce, testSeams) with no surface; BoardSurface.kind is 'panel'; BOARD_VIEW_ID and viewSurface removed"
  - "parseBoardMessage and the controller drop the bare open-board type (T-62-57)"
  - "media/board/board.js has no Open Team Board toolbar button; board.css has no data-surface rules, the body takes the editor background, the list layout keeps its 2 line title clamp"
  - "62-CONTEXT.md 'Owner amendments (2026-11-03, after the hands-on check)' and 62-UI-SPEC.md 'Amendments (2026-11-03)'"
affects: [62-18, 62-19, 62-20, 62-21, 62-22, 62-23, 62-24]

actuals:
  tokens: 11988
  tasks: 3
  commits: 5
plan_head_before: 89fa48ca6543ede135dfd96a934db5539c9f2e11
plan_head_after: fbb6fd5236c8c4ab1891ef06ed23d5e43c1bfbc5

tech-stack:
  added: []
  patterns:
    - "The only code path that creates a board page is openPanel, and only the Open Team Board command calls it"
    - "Controller tests that need a second page attach a hand-made surface with controller.attach instead of a sidebar view"

key-files:
  created:
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-17-SUMMARY.md
  modified:
    - package.json
    - src/services/team/boardView.ts
    - media/board/board.js
    - media/board/board.css
    - src/test/teamManifest.test.ts
    - src/test/teamBoardView.test.ts
    - src/test/boardClient.test.ts
    - src/test/helpers/fakeDom.ts
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-CONTEXT.md
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-UI-SPEC.md
    - .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/deferred-items.md

key-decisions:
  - "The board is one editor tab opened on purpose: no sidebar view, nothing opened by Team Mode or a session start (owner decision 2026-11-03, amends D-15 and AD-22)"
  - "The nearAi.teamMode context key stays: the session still sets it (62-08) and it costs nothing, though no view uses it now"
  - "The controller keeps serving a set of surfaces; with one tab the set holds one page, and the tests keep the multi-page visibility rules covered with a hand-made second page"
  - "The unused link-external icon stays in the page's icon table, because the icon table test lists it and removing it would weaken that test for no gain"
  - "Owner amendments are appended to 62-CONTEXT.md and 62-UI-SPEC.md, never rewritten into the original text; each names the plan that builds it"

patterns-established:
  - "Tests that asserted the sidebar view are rewritten to assert its absence, with a comment naming the owner decision of 2026-11-03"

requirements-completed: [BOARD-01]

coverage:
  - id: D1
    description: "The NEAR AI container lists only the chat view, and no manifest contribution or activation event names a sidebar Team Board view; package.json changed only in contributes.views"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamManifest.test.ts#the NEAR AI container lists only the chat view, and no contribution names a sidebar Team Board view (G-62-1)"
        status: pass
      - kind: other
        ref: "Task 1 package.json scope check against 1d25cbf ('package.json differs from 1d25cbf only by the removed board view')"
        status: pass
    human_judgment: false
  - id: D2
    description: "A lead session that syncs an import registers no view provider and opens no panel; Open Team Board opens exactly one nearAiTeamBoard panel and a second Open reveals it"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "src/test/teamBoardView.test.ts#no view provider is ever registered, and a lead session that syncs and imports opens nothing until the board is asked for (G-62-1)"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardView.test.ts#team project: nothing opens when the session starts, Open Team Board opens one panel and reveals it again, and the context key follows the window"
        status: pass
    human_judgment: false
  - id: D3
    description: "The page keeps its nonce CSP and script list and carries no surface mark"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/teamBoardView.test.ts#the page has one nonce CSP, one script tag per client file in order and no inline script, style, remote address or font source"
        status: pass
    human_judgment: false
  - id: D4
    description: "The page has no button or message that opens the board, the host ignores such a message, and the page takes the editor background in both layouts with the list title clamp kept"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "src/test/boardClient.test.ts#G-62-1: the toolbar has Import plans and New item at 400 px and at 900 px, no button opens the board, and nothing posts a request for it"
        status: pass
      - kind: unit
        ref: "src/test/boardClient.test.ts#G-62-1: the page takes the editor background in both layouts, has no surface rules, and the list layout still clamps titles to 2 lines"
        status: pass
      - kind: unit
        ref: "src/test/teamBoardView.test.ts#parseBoardMessage accepts exactly the contract and returns the fields it checked"
        status: pass
      - kind: integration
        ref: "src/test/teamBoardView.test.ts#the page can ask for the import, a retry and the output channel, and a request to open the board does nothing (G-62-1, T-62-57)"
        status: pass
    human_judgment: false
  - id: D5
    description: "62-CONTEXT.md and 62-UI-SPEC.md record the owner's amendments of 2026-11-03"
    verification:
      - kind: other
        ref: "Task 3 check: both sections present, no em or en dash in the new CONTEXT section; grep -c 'amends D-15' = 1"
        status: pass
    human_judgment: true
    rationale: "Whether the amendment text matches what the owner meant is for the owner and the later plans' reviewers to confirm"
  - id: D6
    description: "In a real VS Code window, turning Team Mode on puts nothing under the chat and Open board opens the board in its own tab"
    verification: []
    human_judgment: true
    rationale: "No e2e was run in this plan (the machine was shared with other agents' suites and the plan's verification is unit and host level); the real-window repeat is 62-24 and the owner's hands-on check"

duration: 27min
completed: 2026-11-04
---

# Phase 62 Plan 17: Board Only in Its Own Editor Tab Summary

**The sidebar Team Board view is gone: the NEAR AI container lists only the chat, registerTeamBoard registers no view provider, the one board page is the editor tab that Open Team Board opens or reveals, the page has no Open Team Board button and the host ignores an open-board message; the owner's 2026-11-03 amendments are now in 62-CONTEXT.md and 62-UI-SPEC.md.**

## Performance

- **Duration:** 27 min
- **Started:** 2026-11-04T01:13:51Z
- **Completed:** 2026-11-04T01:41:49Z
- **Tasks:** 3 of 3
- **Files modified:** 11 (8 code and test files, 3 planning files)

## Accomplishments

- G-62-1 root cause removed: `nearAiTeamBoardView` (a webview view in the NEAR AI container, shown while `nearAi.teamMode` is set) is no longer in package.json, so turning Team Mode on puts nothing under the chat. The scope check shows package.json differs from `1d25cbf` only by that entry.
- `registerTeamBoard` now only builds the controller and `openPanel`. No page exists until Open Team Board runs. A lead session that syncs an import still has no panel and no view provider, and a second Open reveals the first tab.
- `boardHtml` takes no surface and the body has no `data-surface`. `BoardSurface.kind` is `'panel'` only. `BOARD_VIEW_ID` and `viewSurface` are removed.
- The page cannot ask the host to open anything. The toolbar button and its post are gone, `open-board` is out of `parseBoardMessage` and the controller, and a test sends it and sees no command, no panel, no reveal and no answer (T-62-57).
- board.css: the body takes `--vscode-editor-background`, and the sidebar background and both surface rules are gone. The list layout keeps its 2 line title clamp on `#root[data-layout="list"] .card-title`.
- The phase contract records every amendment the owner made on 2026-11-03. Each one names the D number it amends and the plan that builds it.

## Task Commits

1. **Task 1 (tracer): no sidebar board view, nothing opened by a session, one editor tab**
   - `954e34d` test(62-17): expect no sidebar board view, nothing opened by a session, and a page with no surface (RED)
   - `5ec1474` feat(62-17): the Team Board is one editor tab opened on purpose, with no sidebar view (GREEN)
2. **Task 2: the page loses its sidebar-only parts; the host refuses open-board**
   - `6cb2312` test(62-17): expect a page with no open-the-board button, no surface rules, and a host that refuses the request (RED)
   - `53c5ebb` feat(62-17): the board page is written for the editor tab only and cannot ask to open the board (GREEN)
3. **Task 3: owner amendments in the phase contract**
   - `fbb6fd5` docs(62-17): record the owner's amendments of 2026-11-03 in the phase contract

No REFACTOR commits were needed.

## TDD Gate Compliance

- **Task 1 RED** (`954e34d`): `node --test --test-reporter=tap dist/test/teamManifest.test.js dist/test/teamBoardView.test.js dist/test/teamSoloParity.test.js` exited 1 with 53 tests, 49 pass and 4 fail. `gsd-tools check tdd-red-evidence` returned RED_EVIDENCE_OK (target_test_failed) for the target "no view provider is ever registered, and a lead session that syncs and imports opens nothing until the board is asked for (G-62-1)". Semantic assessment: the target ran and failed on its first planned assertion, "no sidebar view provider: 1 !== 0". The other three failures were also on planned assertions. The page test failed on "no surface attribute on the body". The team project test failed on "no view provider is registered: 1 !== 0". The manifest test failed on the container listing `nearAiTeamBoardView`. There was no build, load or fixture fault. The RED test called boardHtml through a cast with the new signature so the commit type-checked, and the GREEN commit removed the cast.
- **Task 1 tracer gate (auto mode):** the verify command was re-run after GREEN with 53 of 53 passing, and the package.json scope check exited 0, so expansion went ahead.
- **Task 2 RED** (`6cb2312`): `node --test --test-reporter=tap dist/test/boardClient.test.js dist/test/teamBoardView.test.js dist/test/teamBoardAssets.test.js dist/test/boardMenu.test.js dist/test/boardDetail.test.js` exited 1 with 97 tests, 93 pass and 4 fail. RED_EVIDENCE_OK for the target "the page can ask for the import, a retry and the output channel, and a request to open the board does nothing (G-62-1, T-62-57)". Semantic assessment: the target failed on "asking the host to open the board runs no command", because nearAi.team.openBoard ran. The toolbar test failed because the 400 px toolbar still listed 'Open Team Board'. The CSS test failed on "no rule depends on a surface mark". The parser test failed because `{ type: 'open-board' }` was still accepted. All four failures were on planned assertions.
- **GREEN:** `5ec1474` passed 53 of 53 and `53c5ebb` passed 97 of 97.

## Files Created/Modified

- `package.json`: the board view entry is removed from `contributes.views.nearAiSecondaryViewContainer`. Nothing else changed.
- `src/services/team/boardView.ts`: panel only. No view provider, no surface parameter and no open-board message.
- `media/board/board.js`: the Open Team Board button, its string and its layout toggle are removed.
- `media/board/board.css`: one body rule with the editor background, and the list clamp without the surface selector.
- `src/test/teamManifest.test.ts`: the view test is replaced by the absence test.
- `src/test/teamBoardView.test.ts`: the sidebar provider test is replaced by the lead-session absence test. The CSP test has no surface. The host-request and visibility tests use a hand-made second page. The team project test expects no view provider. The parser and page-request tests now refuse open-board.
- `src/test/boardClient.test.ts`: two G-62-1 tests (toolbar at 400 and 900 px, CSS rules).
- `src/test/helpers/fakeDom.ts`: the harness no longer sets `data-surface` on the body, matching the real page.
- `62-CONTEXT.md`, `62-UI-SPEC.md`: the appended amendment sections.
- `deferred-items.md`: a note about the flaky teamSession test seen in the full run.

## Decisions Made

See key-decisions in the frontmatter.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Controller tests needed a second page once the sidebar view was gone**
- **Found during:** Task 1 RED authoring
- **Issue:** "host-request reaches the visible surfaces..." and "a hidden surface gets nothing, the session is told only when no surface is visible..." used the registered sidebar view provider as the second page. With no provider, they could not run.
- **Fix:** a `secondPage(board)` helper attaches a hand-made page through the public `controller.attach`. Every assertion stayed: a hidden page gets nothing, and the session hears "hidden" only when no page can be seen.
- **Files modified:** src/test/teamBoardView.test.ts
- **Commit:** 954e34d

**2. [Rule 1 - Consistency] The fake DOM harness still marked the body with a surface**
- **Found during:** Task 2 GREEN
- **Issue:** `createBoardHarness` set `data-surface` (default 'panel') on the body, which the real page no longer does. Board tests would have run against a page the extension never makes.
- **Fix:** the `surface` option and the attribute are removed. No test passed the option.
- **Files modified:** src/test/helpers/fakeDom.ts
- **Commit:** 53c5ebb

---

**Total deviations:** 2 auto-fixed (1 blocking test rig change, 1 harness consistency fix). **Impact:** no assertion was weakened, and both changes are test-side.

## Issues Encountered

- A here-document holding a regular expression with `/*` was refused by a shell safety check. The test edits were written as Python scripts in the scratchpad instead.
- The machine was shared with other agents' test runs. The teamBoardView file took several minutes per run, but no run hit its cap or its timeout.

## Verification

- Task 1: `npx tsc -p tsconfig.json && node --test dist/test/teamManifest.test.js dist/test/teamBoardView.test.js dist/test/teamSoloParity.test.js` passed 53 of 53, 0 fail. The package.json scope check printed "package.json differs from 1d25cbf only by the removed board view" and exited 0. `grep -c nearAiTeamBoardView package.json` = 0 and `grep -c registerWebviewViewProvider src/services/team/boardView.ts` = 0.
- Task 2: `npx tsc -p tsconfig.json && node --test dist/test/boardClient.test.js dist/test/teamBoardView.test.js dist/test/teamBoardAssets.test.js dist/test/boardMenu.test.js dist/test/boardDetail.test.js` passed 97 of 97, 0 fail. `grep -c open-board media/board/board.js` = 0 and `grep -c 'data-surface="view"' media/board/board.css` = 0.
- Task 3: the section and dash check exited 0. `grep -c "amends D-15" 62-CONTEXT.md` = 1.
- Impacted batch (harness users and team board files: boardDrag, fakeDom, sidebarReadiness, boardForm, boardLayoutProbe, teamSectionPage, teamBoardItems, teamBoardLive, teamManifest, teamSoloParity): 129 tests, 128 pass, 0 fail, 1 skipped (the existing PR #7 parity seam from 61-25).
- Full suite (`npm test` under MemoryMax=6G, timeout 1800): 1830 tests, 1818 pass, 1 fail, 11 skipped. The one failure is the known timing-sensitive teamSession test "an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers" ("the paused state is written once while it lasts: 3 !== 1"). It is already logged in Phase 61's deferred-items, it passed 3 of 3 alone, and this plan changed no session code. It is logged again in this phase's deferred-items. The 11 skips are environment skips plus the PR #7 parity seam.
- No e2e run in this plan (see coverage D6).

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat register. T-62-57 is mitigated: the open-board type is gone from the parser and the controller, and a test sends it and sees nothing happen. T-62-58 is mitigated: the view contribution is gone, and tests assert no view provider and no panel exist until the command runs. T-62-SC is mitigated: there were no installs, and package.json changed only in contributes.views.

## User Setup Required

None.

## Next Phase Readiness

- 62-18 can fill the Team section's board summary. The sidebar now has no board of its own, so that one line and Open board are the sidebar's whole board surface.
- 62-19 to 62-24 can work from the amended contract in 62-CONTEXT.md and 62-UI-SPEC.md.

## Self-Check: PASSED

- All modified files exist, and the SUMMARY is at the plan path.
- Commits 954e34d, 5ec1474, 6cb2312, 53c5ebb and fbb6fd5 are ancestors of HEAD.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-04*
