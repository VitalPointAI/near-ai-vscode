# Phase 62 deferred items

## teamBoardView.test.js runs out of memory when the whole file runs under the 1536 MB cap (found in 62-13, not caused by it)

- Symptom: `(ulimit -v 6000000; NODE_OPTIONS=--max-old-space-size=1536 timeout 300 node --test dist/test/teamBoardView.test.js)` passes 17 or 18 tests, then a child process dies with "Committing semi space failed. Allocation failed - JavaScript heap out of memory" while "a card that is not on the board is refused ..." runs. The same happens with `--max-old-space-size=3000`.
- It is not from 62-13: the identical run on the unchanged 62-12 boardView.ts (checked by building the old file) fails at the same test.
- Every test passes alone, and any run that skips either the first 4 or the 8 move-prompt tests passes (16 and 12 tests). The main process heap stays under 40 MB, so the growth is in a child process (git or a helper), and it only appears after about 17 real-git rigs in one file.
- Workaround used in 62-13: run the file in partitions with `--test-name-pattern` / `--test-skip-pattern` (all 27 tests pass that way).
- Suggested fix for a later plan: split teamBoardView.test.ts into two files, or find which helper process leaks per rig (suspect: fake NEAR server or an un-awaited git child in `closeRig`).

### Resolved (debug session `.planning/debug/team-board-view-test-oom.md`)

- Nothing leaked and nothing grew without bound. The process ran out of address space, not memory: `ulimit -v` limits reserved address space, and V8 reserves the whole growth range of a WebAssembly memory up front, 4 GiB for a memory that declares no maximum. Node's fetch makes undici's llhttp parser (a wasm module) on its first connection, and every rig-based test file fetches the fake NEAR server in `createRig`, so each of those processes reserved 4 GiB with nothing behind it. A node process already reserves about 1.4 GB, so under the 6,000,000 KB cap only about 270 MB was left. Around test 17-18 V8 grows its young generation to its normal working size (heapTotal 90 -> 150 MB), that mmap failed, and V8 reported it as "Committing semi space failed ... heap out of memory". At that moment the heap held 19 MB and RSS was 165 MB, which is also why `--max-old-space-size=3000` did not help. The "child process" in the note above is the per-file process `node --test` starts, not git or a helper.
- Heap snapshots after tests 2, 14 and 27 hold no disposed session, board, scheduler, transport or log; no handle survives a test; heap after a full GC goes 13.4 -> 16.9 MB over 27 tests (JIT code).
- Fix: `src/test/helpers/addressSpace.ts` sets `--wasm-max-mem-pages=2048` (128 MiB) at load, before anything can fetch, and `teamHarness.ts` and `fakeNear.ts` import it first. The parser works with 16 pages. Product code is unchanged; VS Code runs with no address-space cap, where the reservation costs nothing.
- Regression tests: `teamHarnessAddressSpace.test.ts` fails if a team test process holds a reservation of 1 GiB or more after its first fetch (it failed with "4096 MiB ---p" before the fix). The new last test in `teamBoardView.test.ts` checks that a replaced session is garbage-collected while the board stays open, with the session polling on real timers. It fails if dispose leaves the poll timer armed or the board keeps its subscription to the old session (both checked with mutants).
- Result: the exact command above passes all tests (27 then, 28 with the guard). Peak RSS is about 220 MB, and VmSize stays 1.8-2.0 GB instead of reaching the 5.9 GB cap. The file no longer needs partitions or splitting.
- Every `team*.test.js` file was run alone under the same caps (56 files). None comes near 1 GB: the highest peak RSS is 226 MB (teamBoardView), then 185 MB (teamImport) and 165 MB (teamMemberCommands). The highest peak address space is 2.0 GB, so no file is still near the 6 GB cap.

## teamBoardLive tracer can fail on a race between the state and the update listeners (found while checking the memory fix, not caused by it)

- Symptom: "tracer: member A blocks a card and member B sees it after exactly one poll interval and not before" failed once with `the listener got the one new entry` (actual 0, expected 1). The same file then passed 4 of 4 reruns under the same caps.
- Cause (from reading the code): `GitTransport` applies new entries to its current state (`src/team/gitTransport.ts:557`), then awaits `savePin(head)` (line 560), and only then calls the update listeners (line 561). The test polls `session.state()` with `until()` (`teamBoardLive.test.ts:100`), so it can see the block during the `savePin` write, before `TeamSession.onStateChange` listeners ran, and then checks the listener at line 103.
- Possible fixes: notify before the pin write, or apply the state after it so that the state and the notification change in the same turn. Alternatively, the test could wait for `received.length === 1` instead of for the state. In the product, the board reads the state when it is notified, a few milliseconds later, so users are not affected; only the test's ordering check is.

## teamSession "an unreachable remote pauses..." failed again in a full run (seen in 62-17, not caused by it)

- The full `npm test` run of 62-17 (MemoryMax=6G, with other agents' suites running on the machine) had 1830 tests, 1818 pass, 1 fail, 11 skipped. The one failure was `src/test/teamSession.test.ts` "an unreachable remote pauses with a redacted reason, backs off to 10 minutes, retries on focus and recovers": "the paused state is written once while it lasts: 3 !== 1".
- It passed 3 of 3 times alone (`--test-name-pattern`). 62-17 changed no session, transport or status code (only package.json views, boardView.ts, the board page and their tests).
- This is the same timing-sensitive test already logged in `61-invitations-joining-removal-near-org-and-key-integration/deferred-items.md` ("2 !== 1" there). It needs a look before the phase gate: the count of paused writes seems to depend on how many polls fit in the window under load.

### Resolved in 62-18

- Root cause: a real product race with the machine's load, not a test timer leak. git's reason for an unreachable remote is "fatal: unable to access '...': Failed to connect to 127.0.0.1 port 1 after 0 ms: Could not connect to server". The connect time in it moves with load (0 ms alone, 1 to 3 ms when other suites run). `TeamSession.showStatus` decided whether a status is new with the key `state:reason`, so a poll whose connect time differed looked like a new failure and wrote the paused line again (2 or 3 lines instead of 1). `reportIssue` had the same key problem.
- Fix (commit 9e49bc5): `sameFailureKey(reason)` in `src/services/team/teamSession.ts` leaves out time and byte figures ("after 7 ms", "30001 milliseconds", "with 0 out of 0 bytes") when deciding whether a failure is new, for the status line, `reportIssue` and the key-install warning. The line written is unchanged, and a different port, host or kind of failure is still new.
- Regression test (commit 35ac2b9): "a remote that stays down is written once even when git reports a different connect time on every try" wraps the session's git runner so every failed fetch reports a different time. It failed with 4 !== 1 before the fix. A unit test covers `sameFailureKey`. The original test is unchanged and passed 6 of 6 when run 6 at a time to load the machine.

## The width matrix leaves "ResizeObserver loop completed with undelivered notifications" page errors (seen in 62-23, not caused by it)

- In the full board e2e of 62-23, the page's error list held 8 copies of "ResizeObserver loop completed with undelivered notifications." before the first drag. The drag-only run (no width or theme matrix) had none, and the drags themselves add none (the 62-23 keyboard-path check now counts only errors written after the drag set-up).
- Likely source: `media/board/board.js` observes the header row with `new ResizeObserver(() => syncHeadHeight())`, and `syncHeadHeight` writes `--board-head-height` on the board region, which can resize the header row again within the same frame while `sizeTo` and `applyTheme` change the page size.
- Chromium reports this as a benign notice, and the probe found no layout problem in any frame. A follow-up could write the variable in the next animation frame or only when the value changes by at least 1 px (it already skips equal values), then assert no page error after the matrix.

## The kanban scrolls about 15 px sideways when nothing is wider than the board region (seen in 62-24, not caused by it)

- In the realistic board's frames at 1400 px, `board-dark-1400-scrolled.png` shows the board region scrolled 15 px sideways (the Backlog header's first letter is clipped) although the columns are narrower than the region, and a 15 by 35 px sliver of a lane title band shows at the right end of the header row after that scroll.
- 62-24 made the sticky header row at least as wide as the region (`.colheads { min-width: 100% }`), which removed the band that showed beside the last column (and, in one frame, a lane's card count). The remaining sliver is the sideways overflow itself.
- Likely source: `.lane-title { width: 100cqw }` sits inside the lanes and is as wide as the container query box; if anything in its row adds a few pixels (a border, the lane's own box or the vertical scrollbar's width), the lanes become wider than the region and the region scrolls sideways by that much.
- The layout probe found no problem (it allows sideways scroll inside the board region). A follow-up could size the lane title with `width: 100%` of a lanes box that is exactly the region's width, then add a probe rule: no sideways scroll when the columns fit.

## The invitee's "Join a team from the quiet line" click was refused once as hidden (seen in 62-24's first full e2e, not caused by it)

- The first full e2e of the 62-24 gate (default xvfb-run screen) failed in team-join: the probe read the quiet line with Join a team, then the click on it came back with error 'hidden'. In media/chat/team.js a quiet-line action is clicked only while none of its ancestors is hidden (`shown()`), and the line lives in #welcome, which chat.js hides during a conversation. team-confirm then timed out waiting for the joiner (3 + 3 failures), and the run stopped before the board launch.
- The invite launch alone (NEAR_AI_E2E_ONLY=invite) then passed 16 of 16, and the second full e2e passed (see 62-24-SUMMARY). 62-24 changed nothing in team.js, chat.js, the Team section host or the invite launch.
- Likely a short moment in which #welcome is hidden right after Just me for now or a profile refresh. A follow-up for the 61-26 code: have the test wait until the line is shown before it clicks (the facts could report whether the line is visible, not only drawn), or find what hides #welcome then.

## The drag set-up's second-client mirror folder is not removed after a board run (seen in 62-24, from 62-23)

- The 62-23 drag set-up makes `near-ai-e2e-board-second-*` under the system temp folder for the owner's second client and never removes it. It holds only a mirror of the test team's coordination record (signed events; no key, no invite text), but one is left per board run: 20 were on this machine during 62-24, 10 of them from 62-24's own runs, which were removed by hand.
- 62-24's own second client and both teammates' folders are listed in `windowFolders` and removed in `run()`'s finally ("teammate folders removed: 3" in every run). A follow-up: push the drag set-up's folder onto `windowFolders` too (one line in src/test/e2e/suite.ts). It was found after the final gate run, so it was not changed here.
