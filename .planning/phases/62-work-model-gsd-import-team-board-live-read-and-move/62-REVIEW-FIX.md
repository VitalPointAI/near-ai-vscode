---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
fixed_at: 2026-11-02T23:51:41Z
review_path: .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-REVIEW.md
iteration: 1
findings_in_scope: 19
fixed: 19
skipped: 0
status: all_fixed
---

# Phase 62: Code Review Fix Report

**Fixed at:** 2026-11-02T23:51:41Z
**Source review:** .planning/phases/62-work-model-gsd-import-team-board-live-read-and-move/62-REVIEW.md, plus T-62-46 to T-62-49 and advisory A1 from 62-SECURITY.md
**Iteration:** 1

**Summary:**
- Findings in scope: 19 (CR-01, CR-02, WR-01 to WR-05, IN-01 to IN-08, T-62-46 to T-62-49). Several share a commit: CR-01 with WR-05, CR-02 with T-62-47, WR-03 with T-62-48, T-62-46 with IN-08, IN-05 with advisory A1.
- Fixed: 19, in 15 commits
- Skipped: 0

**Verification (ran in the linked worktree `.claude/worktrees/team-mode`, on branch `gsd/phase-62-work-model-gsd-import-team-board-live-read-and-move`, not in a nested review-fix worktree, as the orchestrator instructed):**
- Every node and npm run was wrapped as `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 <command>`.
- After each fix: `npx tsc -p tsconfig.json` and `node --test` on the affected compiled test files. All passed before each commit.
- Each new regression test was run against the code before its fix and failed, by putting the committed source back in place temporarily, recompiling, running the test and restoring the fix. Nothing from these probes was committed. Results: CR-01 78 of 89 board client tests failed against the stricter fake DOM (TypeError: cards.map is not a function), and the new e2e step failed in the real window ("the render listeners ran: at least one card is draggable"); CR-02 5 of 5; WR-01 2 of 2; WR-03 1 of 1; WR-04 1 of 1; T-62-46/IN-08 3 of 3; T-62-49 1 of 1; IN-01 4 of 4; IN-02 1 of 1; IN-05 1 of 1 (activate returning the API for any NEAR_AI_E2E); IN-06 1 of 1; IN-07 1 of 1. WR-02 adds a cap and a ceiling that did not exist, so its tests cannot compile against the old code (they use the new exports).
- Final runs, once, after the last fix (all capped as above):
  - `npm run lint`: exit 0.
  - `npm test` (compile, then `node --test dist/test/*.test.js`): exit 0. 1626 tests, 1616 pass, 0 fail, 0 cancelled, 10 skipped (the same environment skips as before).
  - `npm run compile && env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js`: exit 0. 17 of 17 extension-host tests pass (project 8, plain 2, team 7, including the new real-window board step).
  - `npm run verify:release`: exit 0. "Release content verified: 260 entries, 184 runtime JavaScript files, and 50 required release assets."
  - The `teamConcurrency` forked-clients test that failed once under load during a mid-pass team-suite run passed in the full run.
- `src/domain/team/*` and `src/team/*` still import nothing from vscode. No package.json or package-lock.json change, no new dependency. No em-dash or en-dash in any new user-facing text.
- `.planning/config.json` and `.planning/state.json` were left uncommitted and untouched.

## Fixed Issues

### CR-01: Array methods called on NodeList results; the board client throws in a real browser

**Files modified:** `media/board/board.js`, `media/board/menu.js`, `media/board/detail.js`, `media/board/form.js`, `src/services/team/boardView.ts`, `src/test/e2e/suite.ts`, `src/test/boardDrag.test.ts`, `src/test/boardClient.test.ts`, `src/test/teamBoardAssets.test.ts` (plus the WR-05 files below)
**Commit:** d506d0e
**Applied fix:**
- `board.js` has one `nodesOf(scope, selector)` helper that returns an Array; `headNodes`, `applyRoving`, the list and kanban `navTarget` use it. `menu.js` `itemNodes`, `detail.js` focus restore and `form.js` `newItemButton` use `Array.from`. The `for...of` loops in `drag.js` already work on a NodeList and were left alone.
- Real-window e2e: a test-only probe. Under NEAR_AI_E2E=1 only, `registerTeamBoard` marks the page with `data-e2e="1"` and offers `boardTap.probe`; the page answers an `e2e-probe` with an `e2e-facts` message (card ids, draggable count, focused card and role, whether the Move menu is open and how many items it has, and every page error caught by a window `error` listener). The host ignores that answer; the test reads it through `boardTap.fromView`.
**Regression tests:**
- e2e team scenario 'the real page draws the imported cards, a card takes focus and the Move menu opens and steps from the keyboard, with no page error (CR-01)': plan:90-01 and plan:90-02 are drawn, a card is draggable, focus lands on plan:90-02, ArrowRight runs without error, M opens the menu with focus on a menu item, ArrowDown steps it, Escape closes it and focus returns to the card, and no page error was caught. With the old `applyRoving` restored it fails in the real window.
- boardDrag.test.ts 'CR-01: with browser-shaped NodeLists every render runs to its end: one roving stop per lane, draggable set, and a second model updates both' (also opens and steps the Move menu from the keyboard).
- boardClient.test.ts 'the e2e probe answers only on a page the host marked for the extension-host tests, and reports the drawn cards and no page error'.
- teamBoardAssets.test.ts 'CR-01: no board script calls an Array method straight on a querySelectorAll, children or childNodes result' (static half).

### WR-05: The fake DOM returns Arrays from querySelectorAll

**Files modified:** `src/test/helpers/fakeDom.ts`, `src/test/fakeDom.test.ts`, `src/test/boardClient.test.ts`, `src/test/boardDetail.test.ts`, `src/test/boardForm.test.ts`, `src/test/boardMenu.test.ts`
**Commit:** d506d0e (with CR-01)
**Applied fix:** `querySelectorAll` and `childNodes` return a `FakeNodeList` (length, index access, item, forEach, entries, keys, values, iteration) and `children` a `FakeHTMLCollection` (no forEach). Neither has map, filter, find, indexOf or some. The fake keeps its own child Array in a hidden `kids` field (out of what inspect prints, like the other links). Test code that needs Array methods now converts with `Array.from`, as the page must; the harness `$$` still returns an Array. No assertion was removed or loosened.
**Regression tests:** the CR-01 tests above, plus fakeDom.test.ts now checks `kids` stays out of what inspect prints. Against the old board code, 78 of 89 board client tests fail with the new fake.

### CR-02: A partial read of the integration branch is treated as complete, so live plans and tasks get cancelled

**Files modified:** `src/team/integrationSource.ts`, `src/team/runGit.ts`, `src/team/importPlans.ts`, `src/domain/team/gsdImport.ts`, `src/test/teamImport.test.ts`, `src/test/teamImportSource.test.ts`
**Commit:** 0b9cda9
**Status:** fixed: requires human verification (import logic on an append-only log)
**Applied fix:**
- Filter first: `git ls-tree` is given the pathspecs `.planning/ROADMAP.md .planning/STATE.md .planning/phases .planning/milestones`, and only `isPlanningSourcePath` files (the roadmap, the state file, and PLAN and SUMMARY files under phases or milestones) are kept and counted against the 2000-path cap.
- Bounded read (T-62-47): `runGit` takes `maxStdoutBytes` and stops git as soon as it writes more. The listing is read with a 4 MB cap, and a bigger one throws `PlanningTooLargeError`; the import then fails with "The planning folder is too large to read. Nothing was changed." before any file is read or written. `listImportableMilestones` offers no pick in that case. The auto-import probe now reads only the tree hash (`planningTreeHash`), no listing at all.
- Additive only: the snapshot reports `listingComplete`. A listing cut at the path cap makes `diffImport` write only new items, with no `item.updated` and no `item.cancelled`. A plan whose text was not read (over 256 KB, past the 8 MB total, or missing) is marked `unread` by `buildGsdGraph`; neither it nor its tasks are ever updated or cancelled, while the rest of the import still updates and cancels as before.
- Note: plans outside `phases/` and `milestones/` (for example a stray `.planning/quick/...-PLAN.md`) are no longer listed, as the orchestrator specified.
**Regression tests:**
- teamImport.test.ts 'CR-02: a read cut at the path cap cancels nothing and changes nothing, adds only new plans, and a complete read afterwards applies the changes'
- teamImport.test.ts 'CR-02: a plan too large to read keeps its scope, must-haves and tasks while the rest of the import still updates'
- teamImport.test.ts 'CR-02 / T-62-47: a .planning listing over the byte cap is refused before anything is read or written, and git is stopped at the cap'
- teamImportSource.test.ts 'CR-02: only the roadmap, the state file and plan and summary files count against the path cap, so other planning files never push plans out'
- teamImportSource.test.ts 'T-62-47: runGit stops git once it writes more than maxStdoutBytes and keeps only that many bytes'

### WR-01: One YAML-escaped lone surrogate in files_modified aborts the whole import

**Files modified:** `src/domain/team/gsdImport.ts`, `src/team/importPlans.ts`, `src/test/teamImport.test.ts`
**Commit:** 3965e97
**Applied fix:** `unquote` turns an escaped lone surrogate into U+FFFD. `safeScope` drops a file path with a broken character (lone surrogate or U+FFFD) with the warning "a file path was left out because it has a broken character". `graphToItems` catches a `CanonicalJsonError` while fitting one item, warns "was left out because one of its fields cannot be saved" and skips only that item.
**Regression tests:**
- teamImport.test.ts 'WR-01: a lone surrogate in any field never stops the import: a broken file path is dropped with a warning and the rest is kept'
- teamImport.test.ts 'WR-01: a plan file whose frontmatter escapes half a surrogate pair is imported through git, with that entry dropped and every other item written' (all 13 fixture items written)

### WR-02: A lead's window auto-imports an unbounded number of items into an immutable log

**Files modified:** `src/team/importPlans.ts`, `src/services/team/teamSession.ts`, `src/test/teamImport.test.ts`, `src/test/teamSessionImport.test.ts`
**Commit:** 3bf3079
**Status:** fixed: requires human verification (new import gate)
**Applied fix:**
- `MAX_IMPORT_ITEMS = 2000`: `graphToItems` keeps the milestone, phases and plans first, so tasks are what is left out; it warns once ("Only the first 2000 items were imported. The rest were left out.") and an item left out by the cap is never cancelled.
- `AUTO_IMPORT_MAX_CHANGES = 300`: an automatic import whose first diff has more than 300 events writes nothing and returns `skipped: 'needs-command'` with the count. The lead's window shows, once per head: 'The roadmap has N changes for the Team Board. An automatic import makes at most 300, so nothing was changed. Run "NEAR AI: Import Plans to Team Board" to bring them in.' The command writes them as before. The ceiling counts every event (new, changed and cancelled), not only new items, so a flood of updates or cancellations is held back too.
**Regression tests:**
- teamImport.test.ts 'WR-02: one import holds at most 2000 items, tasks are the ones left out, and an item left out by the cap is never cancelled'
- teamImport.test.ts 'WR-02: an automatic import with more changes than the ceiling writes nothing and says so; the command writes them all' (614 changes)
- teamSessionImport.test.ts 'WR-02: an automatic import with more changes than the ceiling writes nothing, tells the lead once in plain words, and the Import command brings them in' (358 changes through a real session)

### WR-03 and T-62-48: Board host error text bypasses the redaction used everywhere else

**Files modified:** `src/services/team/boardView.ts`, `src/services/team/teamCommands.ts`, `src/test/teamBoardView.test.ts`
**Commit:** cf72101
**Applied fix:** `boardView.ts` `describe()` returns `safeReason(message)`, which covers all five output-channel writes; the `busy` reason posted to the page and the refusal line written to the channel go through `safeReason` too. `teamCommands.ts` routes its three remaining raw texts (a message that could not be shown, the context key, a team.json error) through its redacting `describe()`. `memberCommands.ts` already redacted everything.
**Regression test:** teamBoardView.test.ts 'WR-03: an unexpected error from a move, a new item or a model update reaches the output channel redacted, flat and without the credential'

### WR-04: The .state class is used for both the empty-state box and the card state chip

**Files modified:** `media/board/board.css`, `media/board/board.js`, `src/test/boardClient.test.ts`
**Commit:** 9faa2f7
**Applied fix:** The page-level empty, loading and error box is now `state-box` (in `stateView` and board.css); `state` is only the chip, so no rule makes it a centred column.
**Regression test:** boardClient.test.ts 'WR-04: the card state chip and the page state box have their own classes, so the chip lays out its icon beside its word' (parses board.css: no rule that reaches `.state` sets `flex-direction: column` or centred text; the chip element's class is exactly `state`).

### T-62-46 and IN-08: Unsent form drafts, including teammate text and pasted secrets, persisted in webview state

**Files modified:** `media/board/form.js`, `src/test/boardForm.test.ts`, `src/test/teamBoardAssets.test.ts`
**Commit:** b15806a
**Applied fix:** `storable()` keeps a draft only for the person's own unsent new item, never for an edit form, so a teammate's card text never outlives the page. An edit draft stored by an older version is dropped on load and not reopened. A title, description or files field that looks like a key or password (the host's `SECRET_PATTERNS` and redaction patterns, plus a 32+ character random token with letters and digits) is stored as empty. What is sent is unchanged, so the host still refuses it with its own sentence.
**Regression tests:**
- boardForm.test.ts 'T-62-46: a field that looks like a key or password is never stored in the draft, the other fields are, and the host still gets what was typed'
- boardForm.test.ts 'IN-08: an edit form is never stored, so a teammate's card text does not outlive the page, and an older stored edit draft is dropped'
- teamBoardAssets.test.ts 'T-62-46: form.js keeps every host secret pattern, so the stored draft leaves out what the host would refuse' (drift guard)

### T-62-49: Page-to-host messages are not rate-limited

**Files modified:** `src/services/team/boardView.ts`, `src/test/teamBoardView.test.ts`
**Commit:** 170cf7c
**Status:** fixed: requires human verification (concurrency)
**Applied fix:** One item write, one import and one retry run at a time. An import or a retry is not started again within a 2 second cool-down. Item writes that reach the log draw on a bucket of 10 that refills one every 500 ms; requests the host refuses for their content cost nothing. An extra write gets the form's refused answer "The board is still saving your last change. Try again in a moment. Nothing was saved."; an extra import or retry gets a notice ("An import of the plans is already running or just ran. Try again in a moment." / "The board is already checking for changes. Try again in a moment."). Moves were not in scope and are unchanged (they already wait on prompts and re-plan inside the append). The limits and the clock are test seams (`requestLimits`, `nowMs`).
**Regression test:** teamBoardView.test.ts 'T-62-49: the page gets one item write, one import and one retry at a time, a cool-down between imports and retries, and a small write bucket'

### IN-01: Bidi and zero-width format characters are accepted in titles, reasons, names and scope entries

**Files modified:** `src/domain/team/boardText.ts`, `src/domain/team/board.ts`, `src/services/team/boardView.ts`, `src/team/importPlans.ts`, `src/test/teamBoardModel.test.ts`, `src/test/teamBoardItems.test.ts`, `src/test/teamBoardMoves.test.ts`, `src/test/teamImport.test.ts`
**Commit:** b3f767e
**Applied fix:** `stripFormatControls` (U+061C, U+200B to U+200F, U+202A to U+202E, U+2060 to U+2064, U+2066 to U+2069, U+FEFF) is applied on write (board titles via `flattenName`, descriptions, file lines, block and cancel reasons, and every imported text and path) and on display (`flattenName` for every name, title and reason in the model, and the detail description). The signed validators are deliberately unchanged, so existing logs replay exactly as before; rejecting these characters in `validateText`, `isScopePattern`, `validateName` and `validateMustHaves` remains a separate signed-shape decision.
**Regression tests:** teamBoardModel.test.ts 'IN-01: flattenName and stripFormatControls remove bidi overrides, ...'; teamBoardItems.test.ts 'IN-01: a title, description and file line typed with bidi or zero-width characters are written without them'; teamImport.test.ts 'IN-01: imported titles, must-haves and file paths are written without bidi or zero-width characters'; a reason case added to teamBoardMoves.test.ts 'a block or cancel reason is trimmed ...'.

### IN-02: A phase with no live plans can never be completed

**Files modified:** `src/domain/team/work.ts`, `src/test/teamWork.test.ts`
**Commit:** 04a2b80
**Status:** fixed: requires human verification (readiness rule)
**Applied fix:** The rule, documented beside `phaseComplete`: the 62-04 rule stays for a phase that was never planned (complete only when stored done; it never releases the phases that wait on it). A phase that had plans and saw every one of them cancelled has nothing left to do and now counts as complete for its dependants. A cancelled plan dependency still keeps its own dependants waiting, which matches the Cancel confirmation wording. Readiness is computed, not signed, so no event shape changed.
**Regression test:** teamWork.test.ts 'IN-02: a phase whose plans were all cancelled counts as complete for the phases that wait on it; a phase never planned still does not'

### IN-03: Duplicated constants can drift

**Files modified:** `src/services/team/boardView.ts`, `src/test/teamBoardAssets.test.ts`
**Commit:** bb5d7fe
**Applied fix:** `boardView.ts` imports `TITLE_MAX`, `DESCRIPTION_MAX`, `MAX_SCOPE_ENTRIES` and `MAX_ESTIMATE_TOKENS` from `validate.ts`. The copies that cannot import (form.js limits in the page; `OPEN_BOARD_COMMAND` in teamStatusBar, kept apart from teamCommands so the solo load path does not change) are checked against their source.
**Regression test:** teamBoardAssets.test.ts 'IN-03: the form's limits and the duplicated command id match the one source they copy'

### IN-04: Dead exports and an unused method

**Files modified:** `src/domain/team/boardText.ts`, `src/domain/team/itemHistory.ts`
**Commit:** c4bdbf6
**Applied fix:** Removed `IMPORTED_NOTE`, `EMPTY_HISTORY_TEXT`, `EMPTY_TASKS_TEXT` and `ItemHistory.clear` (with its misleading comment). The compiler confirms nothing referred to them.
**Regression test:** none; this is a removal of unreferenced code, and `tsc` is the check.

### IN-05: Test seams are live in production code

**Files modified:** `media/board/board.js`, `src/services/team/boardView.ts`, `src/test/boardClient.test.ts`, `src/test/teamBoardView.test.ts`, `src/test/extensionActivate.test.ts` (new)
**Commit:** e9fbda9
**Applied fix:** The controller offers `boardTap.request` (and the CR-01 probe) only when `registerTeamBoard` sees NEAR_AI_E2E=1, which also marks the page with `data-e2e`; `board.js` honours `host-request` (and `e2e-probe`) only on a marked page. `extension.ts` already returned the API only for NEAR_AI_E2E=1.
**Regression tests:**
- extensionActivate.test.ts (new) 'IN-05: activate() returns undefined without NEAR_AI_E2E=1, ...': unset, empty, "0", "true" and " 1" return undefined; "1" returns the API. It runs the real `activate()` under the vscode stub with an inert fallback for the members the shared stub lacks (only in this file). This resolves advisory A1 of 62-SECURITY.md.
- teamBoardView.test.ts 'host-request reaches the visible surfaces and nothing that is hidden, and exists only under the extension-host tests (IN-05)' and the boardClient tracer: an unmarked page ignores host-request, a marked one re-posts it.

### IN-06: headingTitle slices from the first \n--- rather than the frontmatter's closing line

**Files modified:** `src/domain/team/gsdImport.ts`, `src/test/teamGsdImport.test.ts`
**Commit:** 68f5251
**Applied fix:** `frontmatterEnd` finds the closing line with the same rule `frontmatterBlock` uses (a line that is exactly `---`), and the heading search starts after it.
**Regression test:** teamGsdImport.test.ts 'IN-06: the plan title comes from the first heading after the closing --- line, never from a comment or a ---- line inside the frontmatter' (LF and CRLF).

### IN-07: staleOrPlain names the last history author, who may be the viewer or unrelated

**Files modified:** `src/services/team/boardView.ts`, `src/test/teamBoardView.test.ts`
**Commit:** 7d4e248
**Applied fix:** `move()` notes the card's newest history entry when the page asks. A stale refusal names the newest entry's author only when that entry arrived after the request and someone other than the viewer made it; otherwise it says Someone.
**Regression test:** teamBoardView.test.ts 'a card that changed while the prompt was open ...' now asserts "Someone already changed this card..." for a change made with the viewer's own key (it said "Owner Test" before); the adjacency test still names the teammate who got there first.

## Follow-ups noticed while fixing (not done, not in scope)

- IN-01's other half: rejecting bidi and zero-width characters in the signed validators is a signed-shape change and needs an owner decision.
- The WR-02 notice tells the lead the command name; it has no button. A "Import plans" action on the notice would save a step (wording and UI belong to the plain-language pass).
- A cancelled phase that was never planned still never releases its dependants (IN-02 kept the 62-04 rule for unplanned phases). Removing the dependency from the roadmap is the way out.
- `teamConcurrency.test.ts` '3 forked clients sharing one mirror directory ...' failed once in a mid-pass team-suite run under load, passed 3 of 3 alone and passed in the final full run. It does not touch the code changed here, but it looks timing-sensitive.

## Deviations

- **No nested worktree.** The orchestrator said to work in the linked worktree `.claude/worktrees/team-mode` and not switch branches, so no `gsd-reviewfix/*` worktree, temporary branch or recovery sentinel was created and the cleanup tail did not apply. The fixes are committed directly on `gsd/phase-62-work-model-gsd-import-team-board-live-read-and-move`.
- **Plain `git commit`.** Commits were made with `git add <paths>` and `git commit` with normal hooks (no `--no-verify`) and the Co-Authored-By trailer, matching the Phase 60 and 61 fix passes. Only the listed files went into each commit.
- **Shared commits.** CR-01 and WR-05 are one commit (the orchestrator asked for them together), as are CR-02 and T-62-47, WR-03 and T-62-48, T-62-46 and IN-08, and IN-05 and advisory A1.
- 62-SECURITY.md was updated (T-62-44 evidence, T-62-46 to T-62-49 closed, AR-62-01 note, advisories, audit trail) and committed separately. This report is not committed; the orchestrator commits it.

---

_Fixed: 2026-11-02T23:51:41Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_

## Plain-language pass (2026-11-02)

**Why:** the owner's first product principle in .planning/PROJECT.md: "No developer knowledge required: people build together without knowing git. Git terms appear only in an optional details view, never as a required step or decision." Source: 62-UI-REVIEW.md J-01 to J-19 and warnings 2 to 7, plus the Phase 60/61 user-facing text (61-UI-REVIEW items 6, 7 and 10). Pass 1 above was kept as it is.

**Commits:** 101ec90 (board, form, detail), 0f5ea20 (Enable, sharing, status bar, team check, imports), f6890da (invite, join, link, removal), 642b700 (banned-term scan), 3310e82 (62-UI-SPEC copy amended, with the reason), 7cb4dcf (unfinished link save, key delivery reads).

**Verification (linked worktree `.claude/worktrees/team-mode`, branch `gsd/phase-62-work-model-gsd-import-team-board-live-read-and-move`; every run capped with `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536`):**
- `npm run lint`: exit 0.
- `npm test`: exit 0. 1636 tests, 1626 pass, 0 fail, 0 cancelled, 10 skipped (the same environment skips).
- `npm run compile && env -u ELECTRON_RUN_AS_NODE DISPLAY=:0 node dist/test/e2e/run.js`: exit 0, 17 of 17 extension-host tests pass (project 8, plain 2, team 7).
- `npm run verify:release`: exit 0. "Release content verified: 260 entries, 184 runtime JavaScript files, and 50 required release assets."
- No new dependency, no package-lock change, no em-dash or en-dash in any new text. `.planning/config.json` and `.planning/state.json` untouched.

### What changed for people (old -> new)

Board (boardText.ts, media/board/*.js, boardView.ts, board.ts):
- Column `Integrating` -> `Shipping`; caption and refusal `Merging arrives in a later update.` -> `Adding finished work to the project arrives in a later update.`; icon `git-merge` -> `check-all`.
- The four later columns (Claimed, In progress, In review, Shipping) start folded in the kanban with the note `Claimed, In progress, In review and Shipping are folded for now. They fill in when those steps arrive in a later update.`; an opened column stays open.
- Paused banner `The team log changed in a way the board cannot trust, so the board is paused. Run "NEAR AI: Verify Team Log" to find out why.` -> `Something unexpected changed in the shared team record, so the board is paused to protect your work. Choose "Check the team" to see what happened, or ask your lead.`; untrusted `The team log did not pass its checks, ...` -> `The shared team record failed a safety check, so the board is paused. Choose "Check the team" to see what happened, or ask your lead.` Both banners now have a `Check the team` button (page message `check-team`, rate-limited like retry, runs `nearAi.team.verifyLog`). The untrusted sentence is now also chosen for the "does not belong to this team" reason, which the old text match never reached.
- Offline refusal `The team remote could not be reached, so nothing was changed. Try again when you are back online.` -> `The team could not be reached, so nothing was changed. Check your internet connection and try again.`; slow `... The team remote may be slow.` -> `... The connection to your team may be slow.`
- Read-only `This computer has no device key for this team, so it can read the team log but not write to it.` -> `This computer is not yet approved to make changes for this team. You can look at the board. Ask your lead to approve this computer.` (boardText NO_DEVICE_KEY_TEXT and teamSession READ_ONLY_TEXT).
- Badge `Done in GSD, confirm` -> `Looks finished, please confirm`; accessible name `Done in GSD, waiting for confirmation.` -> `The project plans say this is finished. Waiting for someone to confirm.`
- Type `Spike` -> `Experiment` (stored kind stays `spike`); empty board `... a bug, chore or spike yourself.` -> `... a bug, chore or experiment yourself.`
- Detail facts `Wave` -> `Order within the phase`, `Kind` -> `Type`, `Source` -> `Where it came from`; sections `Must-haves` -> `What must be true when it is done`, `Files` -> `Parts of the project`; imported note `... Change the plan files and the board updates.` -> `... Change the plan and the board follows.`; history words `files` -> `parts of the project`, `must-haves` -> `checks for done`.
- Not-ready reason `it lists no files` / `It lists no files.` -> `it does not say which parts of the project it covers` / `It does not say which parts of the project it covers.`
- Mark done `... finished and merged. ...` -> `... finished and added to the project. ...`; block placeholder `For example: waiting for the API key` -> `For example: waiting for a teammate's answer, or for the API key`.
- `The team log did not accept this change/item.` -> `The shared team record did not accept this change/item.`; the busy refusal no longer shows the transport's reason but `The team was busy saving other changes. Try again in a moment.` (the reason is in the channel); `Items from the project plans change only when the plan files change.` -> `... only when the plans change.`
- 2px paddings (inputs, buttons, icon buttons, narrow move button) -> 0 or 4px; textareas 4px 8px.

New item form (J-01, J-02):
- `Files this touches (optional)` -> `Parts of the project this covers (optional)`; hint `One pattern per line, for example src/services/**` -> `Add a folder or file name on each line, for example "settings". Leave empty if you are not sure.`; error `Use one pattern per line, relative to the project folder, for example src/services/**.` -> `One of these lines is not a folder or file name in this project. Remove it and try again.` and a separate `List 64 parts of the project or fewer.` (form and host).
- `Choose folders...` button: the host opens `showOpenDialog` (folders and files, many, in the project) and answers `folders-chosen` with project-relative forward-slash paths that pass the stored scope rule; the project itself, anything outside it and repeats are left out; nothing is written until the form is saved.
- Readiness hint `Without files and an estimate this item stays in Backlog.` (muted hint) -> a note in normal text with an accent border: `This item stays in Backlog until you say which parts of the project it covers and roughly how big it is.`; a board card that sits in Backlog without parts or size says `Stays in Backlog until it says which parts of the project it covers and roughly how big it is.` on its face and at the end of its accessible name (new optional `backlogRule` on the card model).

Status bar and the team check (teamStatusBar.ts, teamSession.ts, package.json):
- `Team sync paused: remote unreachable` -> `Team sync paused: offline`; `... log rewritten` -> `... record changed`; `... log missing on remote` -> `... team record missing`; `Team log not trusted` -> `Team record not trusted`; `Click to run Verify Team Log.` -> `Click to check the team.`
- Tooltips are fixed plain sentences per known reason (UNREACHABLE/REWRITTEN/MISSING/REFUSED_TOOLTIP); the raw reason, which can carry git words, is only in the output channel line the session already writes.
- Command title `Verify Team Log` -> `Check Team Record` (id `nearAi.team.verifyLog` kept); progress `Verifying the team log` -> `Checking the team record`; `Team log verified: ...` -> `The team record passed its check: ...`; `Team log checked, with problems: ...` -> `The team record was checked and has problems: ...` (a refused record says `The record failed its safety check. Choose Show details to see why.`); `Verify Team Log could not finish: {error}` -> `The team check could not finish. Choose Show details to see why.`; the untrusted warning says `Team record not trusted: it does not belong to this project's team, so new team activity is ignored. Click the team status to check the team, or ask your lead.` Channel report header `Verify Team Log:` -> `Check Team Record:`.

Imports (importPlans.ts, teamSession.ts, teamCommands.ts):
- `There is no integration branch to import from.` / `The integration branch was not found on the team remote` -> `The team's shared copy of the project could not be found`; `The team remote could not be reached (...)` and an unread team record -> `The team could not be reached. Check your internet connection and try again`; `The integration branch has no .planning folder.` -> `This project has no plans to import yet. Plan your first phase, then import again.` The git reason travels in a new optional `detail` on the failed ImportResult and is written to the channel (`Import details: ...`, and the auto-import issue line).
- WR-02 notice `... Run "NEAR AI: Import Plans to Team Board" to bring them in.` -> `... Choose Import now, or run "NEAR AI: Import Plans to Team Board", to bring them in.` with an `Import now` button that runs the Import command.

Enable Team Mode (teamCommands.ts, J-10):
- Button `Push` -> `Share with my team`; `Verify Team Log` -> `Check the team`. Message `Team Mode is on for X. team.json is committed on main. Push it when you are ready so teammates can see the team.` -> `Team Mode is on for X. Share it so teammates can see the team.` (the commit and branch line is written to the channel). Success `Pushed main to origin.` -> `Shared with your team.` (git line kept in the channel). Failure (was the raw git message) -> `Team Mode could not be shared with your team yet. Check your internet connection, then choose Try again. Nothing was lost.` with `Try again` and `Show details`.
- Enable stops show a plain sentence with `Show details`; the enable.ts message (git init, remote add, commit command) goes to the channel: not a repository / no commits / no remote -> `This project is not shared online yet, so a team cannot use it. Team Mode works through the place your project is hosted, such as GitHub. Ask whoever set up the project to put it online, or choose Show details for the steps.`; unreachable -> `The place this project is hosted could not be reached, so nothing was changed. Check your internet connection and try again.`; git missing, team already online, create failed, create unconfirmed and team.json not committed each get their own plain sentence; an invalid remote or branch name -> `The sharing settings of this project could not be used, so nothing was changed. Choose Show details for more.`
- Email prompt `Your email is stored only as a salted hash in the team log.` -> `Your email is kept only as a scrambled code (a salted hash) in the team record, never as plain text.`

Invite, join, link and removal (memberCommands.ts, join.ts, cleanupChecklist.ts, remove.ts, keyDelivery.ts, gitTransport.ts):
- `Clone repository` -> `Get the project`; `This invite is for a project that is not open. Clone it, then ...` -> `... Choose Get the project to download it, then ...` (the address is still passed only to `git.clone`, never shown). Join placeholder `near-ai-invite-v1....` -> `Paste the invite here`.
- Join failures: `... because the team's repository could not be reached: {git}` -> `Your join could not be saved because the team could not be reached. Check your internet connection and try again.`; `The team's repository did not accept your join: {git}` -> `The team did not accept your join. The NEAR AI Team output has the details.`; `The team log could not be read/reached: {git}` -> `The team could not be reached, so your join did not start. ...`; a paused or untrusted record now gets a plain sentence; the git reason goes in a new `detail` that the Join command writes to the channel. `... names a different coordination branch ...` -> `This invite is for a different copy of this project than the one that is open. ...`; `Ask your lead to push the NEAR link (or pull it if they already did)` -> `Ask your lead to share the NEAR link with the team (or get the latest version of the project if they already did)`.
- Link and invite: `Push` -> `Share with my team`; `Linked X to Y. team.json is committed on main. Push it so your teammates see the link.` -> `Linked X to Y. Share it so your teammates see the link.`; `The NEAR link is not pushed yet, so a teammate who clones the project now will not see it. Push your branch before they join.` -> `The NEAR link is not shared with your team yet, so a teammate who gets the project now will not see it. Share it before they join.`; `Pushed main to origin.` -> `Shared with your team.`; push failures and "no current branch" -> plain sentences with `Show details`; progress `Writing the link to team.json and committing it` -> `Saving the link in this project`; an unfinished link save -> `The link is saved in this project, but saving it for the team did not finish. Choose Show details for the one step that is left.`; a remote address that cannot go into an invite -> `The address this project is shared from cannot be put in an invite, so no invite was made. Choose Show details for why.`
- Removal: `Remove their access to the git repository yourself afterwards.` -> `Afterwards, remove their access to the project on GitHub (or wherever the project is hosted) yourself.`; checklist step `Remove repository access`, row `Repository access for X`, Mark done `You removed their repository access` and reminder `Remove X's access to the git repository last, after their client has seen the removal.` -> `Remove their access to the project on GitHub (or wherever the project is hosted)`, `Project access for X`, `You removed their access to the project where it is hosted`, `Remove X's access to the project on GitHub (or wherever the project is hosted) last, after NEAR AI on their computer has seen the removal.`; remove result `Remove their repository access last; ...` -> `Remove their access to the project on GitHub (or wherever the project is hosted) last; ...`.
- Every progress step and prompt `... team log` -> `... team record`; `The team log changed too often ...` -> `The team record changed too often ...`; key delivery `... in the team log ...` -> `... in the team record ...`; unknown delivery `... because the team's repository could not be reached to check` -> `... because the team could not be reached to check`.
- 61-UI-REVIEW item 10: Skip `Invite without one` -> `Invite without a NEAR organization`; the lifetime pick no longer sets an empty description.

### Tests

- Every test that pinned old text pins the new text exactly; several got stricter (status bar tooltips and paused texts are now exact equals instead of startsWith/endsWith, Enable and share notifications are exact, the paused banner checks its Check the team button and post). No assertion was removed or loosened.
- New: teamPlainLanguage.test.ts (below); boardForm 'J-01: Choose folders...'; teamBoardView 'Check the team' and 'J-01: Choose folders...' (the vscode stub gained `showOpenDialog`); boardClient folded columns and 'J-02' card face; teamBoardModel 'J-02'; teamImport 'J-07 and J-08'; teamSessionImport WR-02 now presses Import now; teamManifest pins the copied import command id; teamMemberCommands unfinished link save.
- **Banned-term scan (src/test/teamPlainLanguage.test.ts):** parses boardText.ts, media/board/{board,detail,form,menu,drag}.js, teamStatusBar.ts, boardView.ts, teamCommands.ts, memberCommands.ts and teamSession.ts with the TypeScript parser (already a dev dependency) and fails on branch(es), commit(s/ted/ting), push(ed/ing), pull, remote, worktree, glob, GSD, repository, repo, clone(d), merge(d/ing), rebase, team log, device key, pattern or integration branch in any readable literal (a sentence, or a capitalised single word such as a button). Allowlist for output-channel-only text: literals inside the arguments of `appendLine`, `line` or `reportIssue` (the NEAR AI Team channel), plus one exact entry (teamSession's identityProblem text, written only with `session.line`); a stale allowlist entry fails. Module paths, ids, codes and class names (lower-case, no space) are not text. Against the code before this pass it flags 52 strings; after it, none.

### Left as it is (not done in this pass)

- 61-UI-REVIEW items 3 (quick pick hierarchy, codicons, separators), 4 (invite bundle in a modal detail), 8 (casing, Re-issue naming, "Sign Out of NEAR (Team)"), 9 (Remove beside Confirm in the toast) and the read-only separator of item 10: layout and interaction work, not words. The NEAR cleanup rows still show the raw item status (`pending`, `failed`) in their description.
- "Git" is still named once, as the tool to install, in Enable's git-missing sentence; "salted hash" stays in the email prompt, explained in brackets.
- The folder picker fills in folder paths (for example `src/settings`), not globs. Nothing matches scope against files yet; when claims arrive (Phase 63) a folder entry should be read as "everything under it".
- The paused banner still picks its sentence by matching the status text; a status field for "untrusted" would be cleaner than the text match.
- src/team messages that are only written to the channel (enable.ts, inviteBundle.ts, gitTransport.ts reasons, join and import details) keep their git words on purpose; the scan covers the text tables, not src/team.
