---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 08
subsystem: team-board-host
tags: [team-mode, webview, csp, view-provider, native-prompts, solo-parity, vscode-stub]

requires:
  - phase: 62-work-model-gsd-import-team-board-live-read-and-move
    provides: "planMove, availableMoves, buildBoardModel, buildCardDetail and staleRefusal (62-06); TeamSession onStateChange, itemHistory, setBoardVisible, boardStatus, canWrite, importPlans and the status bar click target (62-07); importResultText and listImportableMilestones (62-05)"
provides:
  - "src/services/team/boardView.ts: board page html under a nonce CSP, parseBoardMessage, BoardController, sidebar view provider, one editor panel, boardTap"
  - "Commands nearAi.team.openBoard and nearAi.team.importPlans, registered at activation and inert in a solo project"
  - "View nearAiTeamBoardView in the NEAR AI container, shown only while the context key nearAi.teamMode is set"
  - "The vscode test stub now records webview panels, view providers, Uri, ViewColumn and MessageItem buttons"
affects: [62-09, 62-10, 62-11, 62-12, 62-13, 62-14]

actuals:
  tokens: 27800
  tasks: 3
  commits: 6
plan_head_before: 6ad7fd425845a6d9c7755639cca1da865630c2b3
plan_head_after: ac2ce6b

tech-stack:
  added: []
  patterns:
    - "Board host outside chat.ts: one controller serves a view and a panel; posts only to visible surfaces, only on a changed serialised model, at most once per 250 ms"
    - "A move is planned three times: on known state to pick the prompt, again after the prompts on the then-current state, and inside log.append on the freshest fetched state"
    - "Lazy module: teamCommands loads boardView with a dynamic import after a session starts, so a solo project loads nothing"

key-files:
  created:
    - src/services/team/boardView.ts
    - src/test/teamBoardView.test.ts
  modified:
    - src/services/team/teamCommands.ts
    - package.json
    - src/test/helpers/vscodeStub.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamManifest.test.ts

key-decisions:
  - "The page protocol host-to-page messages are state {model}, refused {itemId, reason}, detail {...CardDetail with its itemId}, and host-request {payload}; a dismissed prompt answers refused with reason '' and is not written to the output channel"
  - "A card-state refusal after the page was offered the move (already held, already blocked, settled, not now) is shown as the stale sentence naming the author of the newest history entry; permission, secret and reason refusals stay plain"
  - "While the board status is offline or paused the model's canWrite is false with a plain reason, so the board offers no moves; a live or syncing board follows session.canWrite()"
  - "boardView imports the two command ids from teamCommands (a value import in that direction only); teamCommands never imports boardView statically"
  - "Context key is set once, after the first session starts and the board is registered, and cleared when the window's subscriptions dispose; later starts and restarts only call controller.sessionChanged()"

patterns-established:
  - "BoardTimers test seam (now, set, clear) so throttle behaviour is driven by hand with the same LiveTimers the session tests use"
  - "createWebviewView and RecordedWebviewPanel in the stub: receive(), setVisible(), dispose() play the page and the editor"

requirements-advanced: [BOARD-01, BOARD-02, BOARD-03]
requirements-completed: []

coverage:
  - id: D1
    description: "The Team Board is a sidebar view and one editor panel served by one controller from src/services/team/boardView.ts, a real team session over real clones sends the first state, a hold lands on the remote and the card comes back in Backlog"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#tracer: the panel opens on a real team session, gets the first state, posts a hold and gets the card back in Backlog"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#the panel is one editor tab: a second Open reveals it, and it asks for scripts, no retained context and only media/board"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#the sidebar view provider is registered once under the view id with no retained context, and serves the same page"
        status: pass
    human_judgment: false
  - id: D2
    description: "The page loads under default-src 'none' with a nonce, no inline script or style, no remote address and no font source; every page message is parsed with exact keys, id patterns and length caps"
    requirement: BOARD-03
    verification:
      - kind: unit
        ref: "dist/test/teamBoardView.test.js#the page has one nonce CSP, one script tag per client file in order and no inline script, style, remote address or font source"
        status: pass
      - kind: unit
        ref: "dist/test/teamBoardView.test.js#parseBoardMessage refuses anything else: extra or missing keys, odd ids, unknown moves, long text, bad numbers and non-objects"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#hostile messages from a page are ignored or refused and never reach the log"
        status: pass
    human_judgment: false
  - id: D3
    description: "Moves use native prompts (reason box for block and cancel, modal for mark done, second modal for a cancel with dependents), are planned again inside the append, and failures read as plain sentences"
    requirement: BOARD-03
    verification:
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#block asks for the reason in a native box with the UI-SPEC words, validates it, and appends the answer"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#mark done always asks with a modal, and Not yet writes nothing"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#cancel asks a reason, then a modal only when other cards wait for it, and Keep item writes nothing"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#adjacency: two members move the same card in the same poll window, one move lands and the other is told who got there first"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#an append that fails offline gives the offline sentence, and the failure is written to the output channel"
        status: pass
    human_judgment: false
  - id: D4
    description: "Posts go only to visible surfaces, only when the serialised model changed and at most four times a second; any visible surface keeps the faster poll through setBoardVisible"
    requirement: BOARD-02
    verification:
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#a hidden surface gets nothing, the session is told only when no surface is visible, and showing it brings it up to date once"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#posts are throttled to four a second and only when the model changed"
        status: pass
    human_judgment: false
  - id: D5
    description: "Open Team Board and Import Plans to Team Board are registered at activation, are silent and inert in a solo project, and in a team project open one panel and import under a progress notification"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamSoloParity.test.js#Open Team Board and Import Plans to Team Board in a solo project only explain how to turn Team Mode on and load nothing"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#team project: the board comes up once the session starts, Open Team Board opens one panel and reveals it again, and the context key follows the window"
        status: pass
      - kind: integration
        ref: "dist/test/teamBoardView.test.js#Import Plans to Team Board: a palette run with two milestones asks first with the current one recommended, runs under a progress and reports the sentence"
        status: pass
      - kind: unit
        ref: "dist/test/teamManifest.test.js#the Team Board view sits in the NEAR AI container after the chat view and shows only while Team Mode is on"
        status: pass
    human_judgment: false
  - id: D6
    description: "The board opens in a real editor window from the sidebar, the command and the status bar click, and the page that loads is the finished client"
    requirement: BOARD-01
    verification: []
    human_judgment: true
    rationale: "Needs the real editor (e2e suite or the owner) and the client files from plans 62-09 to 62-13; media/board does not exist yet, so the page is empty until those plans land. The e2e command-registration assertion was not run here."

duration: ~45min (start time was not logged; estimated from the first read)
completed: 2026-11-02
status: complete
---

# Phase 62 Plan 08: Team Board host Summary

**Team Board host in VS Code: a sidebar view and one editor panel behind a nonce CSP, a controller that posts throttled models to visible pages only and plans every move again on fresh state with native prompts, and two solo-safe commands (Open Team Board, Import Plans to Team Board).**

## Performance

- **Duration:** about 45 min (start time not logged)
- **Completed:** 2026-11-02T20:08Z
- **Tasks:** 3 (one tracer, two auto), each with a RED and a GREEN commit
- **Files modified:** 7 (2 new)

## Accomplishments

- `boardView.ts` serves the same page to `nearAiTeamBoardView` and to the `nearAiTeamBoard` panel. CSP is `default-src 'none'; style-src <cspSource>; script-src 'nonce-<nonce>'`, one script tag per `BOARD_SCRIPTS` entry in order, `localResourceRoots` limited to `media/board`, no `retainContextWhenHidden`, no font source.
- `parseBoardMessage` reads the whole page contract with exact own keys, id patterns, the seven move keys and length caps (title 200, description 2000, 64 scope lines of 200, estimate 1 to 10^12). `new-item` and `edit-item` are parsed and left for 62-13; everything else unknown returns `undefined` and gets no reply.
- The controller posts `state {model}` only to visible surfaces, only when the serialised model differs from that surface's last send, and at most once per 250 ms (one timer, not one per change). `ready` always sends. The combined visibility of all surfaces goes to `session.setBoardVisible`.
- Moves: a refusal on known state is answered before any prompt. Block and cancel ask for a reason in a native input box (UI-SPEC words, validator, `ignoreFocusOut`), mark done always asks in a modal, a cancel with dependents adds a second modal. The move is then planned again on current state and a third time inside `log.append`. A card changed by someone else gets "`<Name>` already changed this card. The board now shows the latest. Nothing was moved." and the page is brought up to date at once. Offline and paused map to the offline sentence, `SecretLeakError` to the secret sentence, `NoDeviceKeyError` to the read-only sentence. Failures go to the NEAR AI Team channel without card text.
- `detail` replies carry `buildCardDetail` with `itemHistory`; `import-plans`, `open-board`, `retry` and `show-details` run the commands, nudge the session and show the channel.
- `teamCommands.ts` registers both commands at activation. In a solo project they show `SOLO_TEXT` and nothing else loads (no board module, provider, panel, context key, progress or timer). In a team project the board loads by dynamic import after a session starts, the context key `nearAi.teamMode` is set once and cleared on dispose. Import Plans asks for a milestone only from the palette with two or more (current first, described as Recommended), runs under "Importing plans to the Team Board" and reports `importResultText`.
- `package.json` gains the two commands (`$(project)`, `$(sync)`) and the `Team Board` webview view with `when: nearAi.teamMode` after the chat view. No dependency added.

## Task Commits

1. **Task 1: Tracer** - `c19a59d` (test, RED), `22a5101` (feat, GREEN)
2. **Task 2: Moves, prompts, stale and offline answers, detail, visibility, hostile messages** - `a389f83` (test, RED), `34d08eb` (feat, GREEN)
3. **Task 3: Commands, view contribution, solo parity** - `ade1b2d` (test, RED), `ac2ce6b` (feat, GREEN)

**Plan metadata:** the docs commit that carries this file and the state update follows it.

## Files Created/Modified

- `src/services/team/boardView.ts` - view provider, panel, html, parser, controller, `boardTap`
- `src/services/team/teamCommands.ts` - the two commands, `bringUpBoard`, context key, `guarded` now forwards arguments
- `package.json` - two commands and the Team Board view
- `src/test/helpers/vscodeStub.ts` - webview panels, view providers, `createWebviewView`, `Uri`, `ViewColumn`, MessageItem buttons, `extensionUri` on the fake context
- `src/test/teamBoardView.test.ts` - 27 tests on real clones (host tracer through commands)
- `src/test/teamSoloParity.test.ts`, `src/test/teamManifest.test.ts` - solo and manifest assertions for the new commands and view

## Decisions Made

See `key-decisions`. Two worth repeating for the client plans: the `detail` message is `{ type: 'detail', ...CardDetail }` (so `itemId` is at the top level), and a dismissed prompt is `refused` with `reason: ''` which the page must clear silently.

## TDD Gate Compliance

Each task has a `test(62-08)` commit followed by a `feat(62-08)` commit: Task 1 `c19a59d` then `22a5101`, Task 2 `a389f83` then `34d08eb`, Task 3 `ade1b2d` then `ac2ce6b`. The `gsd_run check tdd-red-evidence` classifier was not run; the RED reports were inspected by hand.

- **Task 1 RED:** 6 of 7 tests failed on their planned assertions ("a panel was created", the parser returning `undefined` for valid messages, no first state). The "refuses anything else" parser test passed at RED because the skeleton returns `undefined` for everything; it stays as a guard. `boardView.ts` was committed in the RED commit as an inert skeleton so the tests compile and fail on assertions instead of on a missing module.
- **Task 2 RED:** 12 of 24 failed (prompts, stale, offline, secret, no-key, detail, missing card). Tests for hold/release, visibility, throttle, hostile messages and page commands passed at RED because Task 1 already implemented that behaviour; they stay as guards.
- **Task 3 RED:** 5 solo/manifest tests and 3 team command tests failed (commands not registered, view absent).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The tests use plan:90-02 as the ready card, not plan:90-01**
- **Found during:** Task 1 (GREEN)
- **Issue:** The plan text names plan:90-01 as ready in the fixture roadmap, but 90-01 has a SUMMARY file and imports as Done. 62-07's live test already treats 90-02 as the ready plan.
- **Fix:** `READY_PLAN = 'plan:90-02'` in the tests, with a comment. Cancelling 90-02 has one dependent (91.1-01), which the cancel test uses for the second modal.
- **Files modified:** src/test/teamBoardView.test.ts
- **Committed in:** 22a5101

**2. [Rule 3 - Blocking] The vscode stub could not model modal buttons with a close affordance**
- **Found during:** Task 2
- **Issue:** UI-SPEC wants `Not yet` and `Keep item` as the close affordance. The stub dropped MessageItem objects and mistook the first one for the options object.
- **Fix:** The stub now accepts strings or `{ title, isCloseAffordance }`, records titles in `notificationActions` and answers a MessageItem action with the item itself, as VS Code does. Existing string callers behave as before (the 79 non-team stub-using tests and 905 team tests pass).
- **Files modified:** src/test/helpers/vscodeStub.ts
- **Committed in:** c19a59d

**3. [Rule 3 - Blocking] The solo parity and manifest tests pinned the old command list**
- **Found during:** Task 3
- **Issue:** `teamSoloParity` asserted exactly seven commands and `teamManifest` the seven contributed ids.
- **Fix:** Both lists gained the two new commands. The allowlist of two command modules that may be loaded in a solo project is unchanged.
- **Files modified:** src/test/teamSoloParity.test.ts, src/test/teamManifest.test.ts
- **Committed in:** ade1b2d

**4. [Rule 2 - Missing critical] Authored copy the UI-SPEC does not list**
- **Found during:** Tasks 2 and 3
- **Issue:** Four cases had no sentence: no session yet ("The Team Board is not ready yet. Nothing was moved."), a log that declined an append ("The team log did not accept this change. Nothing was moved."), any other failed write ("The change could not be saved. Nothing was moved."), and a paused board ("The board shows the last update and cannot be changed until team sync resumes."). The cancel modal also needed singular wording ("1 plan waits for this card. It stays waiting ...").
- **Fix:** Plain, dash-free sentences ending in "Nothing was moved." where a move failed; they live as constants at the top of `boardView.ts` for the copy review.
- **Files modified:** src/services/team/boardView.ts
- **Committed in:** 34d08eb, 22a5101

**5. [Rule 2 - Missing critical] `guarded` did not forward command arguments**
- **Found during:** Task 3
- **Issue:** Import Plans receives `{ milestone: 'current' }` from the page, but the wrapper dropped arguments.
- **Fix:** `guarded` forwards `...args`; the existing commands ignore them.
- **Files modified:** src/services/team/teamCommands.ts
- **Committed in:** ac2ce6b

---

**Total deviations:** 5 auto-fixed (1 bug in the plan text, 2 blocking, 2 missing critical)
**Impact on plan:** No scope change. Item 4 adds sentences for the owner's copy review.

## Issues Encountered

- A session restart is handled (`restartSession` calls `bringUpBoard`, which only calls `controller.sessionChanged()` after the first time), but no test drives a real restart through a join; the idempotence is covered by repeated starts and two Open Team Board runs. The member-command flows that restart are tested elsewhere without a board.
- The e2e suite (real editor) was not run here. It asserts every contributed command is registered; both new commands are registered at activation.

## Known Stubs

- `src/services/team/boardView.ts` line 25: `BOARD_SCRIPTS` and `BOARD_STYLES` name files under `media/board` that plans 62-09 to 62-13 create. Until then the page loads with a root element and live region but no client, so the sidebar view and panel are empty. Intentional per the plan; recorded in `.planning/WINDOWS.md`.

## Threat Flags

None beyond the plan's register. The new surface (webview, page-to-host messages) is the one T-62-27 to T-62-31 cover: exact-key parsing, planning again inside the append, nonce CSP with `localResourceRoots` limited to `media/board`, throttled posting, dynamic import only.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 62-09 can build `board.js` against the fixed protocol: out `ready`, `visible`, `move`, `detail`, `import-plans`, `open-board`, `retry`, `show-details`, `new-item`, `edit-item`; in `state`, `refused`, `detail`, `host-request`. `notice` is in the contract but this plan sends none.
- The page needs `#root` and `#live` (provided by `boardHtml`), `body[data-surface="view"|"panel"]`, and must re-post `host-request` payloads unchanged.
- `boardTap.toView`, `boardTap.fromView` and `boardTap.request` are the hooks for the 62-14 end-to-end proof.

## Self-Check: PASSED

- Files found: boardView.ts, teamCommands.ts, teamBoardView.test.ts, vscodeStub.ts, teamSoloParity.test.ts, teamManifest.test.ts, package.json.
- Commits found on the branch: c19a59d, 22a5101, a389f83, 34d08eb, ade1b2d, ac2ce6b; measured count `6` from the ledger base `6ad7fd4`.
- Acceptance criteria re-run: CSP grep, `registerWebviewViewProvider` and `createWebviewPanel` in the stub, no `retainContextWhenHidden: true`, "already changed this card" in the test, "Mark done" and "Not yet" in the host, `nearAiTeamBoardView` and `nearAi.team.openBoard` in `package.json`, `import('./boardView')` present and no static boardView import, empty `dependencies`.
- `npm run lint` exits 0. `node --test dist/test/team*.test.js`: 905 tests, 903 pass, 0 fail, 2 skipped (pre-existing). Stub-using non-team tests: 79 pass.

---
*Phase: 62-work-model-gsd-import-team-board-live-read-and-move*
*Completed: 2026-11-02*
