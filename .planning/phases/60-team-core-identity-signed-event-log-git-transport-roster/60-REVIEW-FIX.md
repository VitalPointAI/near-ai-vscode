---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
fixed_at: 2026-11-01T16:57:53Z
review_path: .planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 60: Code Review Fix Report (incremental review of plan 60-12)

**Fixed at:** 2026-11-01T16:57:53Z
**Source review:** .planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-REVIEW.md (incremental review of gap plan 60-12, G-60-1)
**Iteration:** 1

> This report replaces the earlier fix report for the full-phase review (CR-01, WR-01 to WR-12 under the same IDs). That report is in git history at commit `69f2e0e` (`git show 69f2e0e:.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-REVIEW-FIX.md`).

**Summary:**
- Findings in scope: 6 (scope `all`: CR-01, WR-01, WR-02, IN-01, IN-02, IN-03)
- Fixed: 6, one commit each
- Skipped: 0

**Verification (ran in the linked worktree `.claude/worktrees/team-mode`, on branch `gsd/phase-60-team-core-identity-signed-event-log-git-transport-roster`, not in a nested review-fix worktree, as the orchestrator instructed):**
- `./node_modules/.bin/tsc -p tsconfig.json` (the project's own tsc): exit 0.
- `node --test dist/test/teamScheduler.test.js dist/test/teamSession.test.js`: 44 tests, 44 pass, 0 fail (39 before this pass, plus 5 new: 1 for CR-01, 3 for WR-01, 1 for IN-03).
- `npm run lint` (`tsc -p tsconfig.json --noEmit`): exit 0, no output.
- `npm test`: exit 0. 953 tests, 945 pass, 0 fail, 0 cancelled, 8 skipped (the same environment skips as before).
- The CR-01 and WR-01 regression tests were run against the unfixed code first and failed (CR-01: `got 3710000`; WR-01: each test failed with the injected `focused failed`, `now failed` or `pollSeconds failed` escaping as a rejection).
- WR-02 was probed by injecting `assert.fail` right after the first fetch was held: only that test failed, with no unhandled rejection or failure in any other test. The probe was reverted with `git checkout --` and never committed.
- Every stub consumer (`teamSession`, `teamCommands`, `teamSoloParity`, `teamManifest`, plus `teamScheduler`) was run after IN-03: 69 tests, 69 pass.

Unchanged: the D-19/D-25 constants (`UNFOCUSED_POLL_MS`, `MAX_BACKOFF_MS`, `MIN_POLL_SECONDS`, `MAX_POLL_SECONDS`, `DEFAULT_POLL_SECONDS`) and the doubling rule in `nextDelay()`. `src/team/syncScheduler.ts` still imports nothing from vscode (its only import is `node:perf_hooks`). No catch block added in this pass is empty. No package.json or package-lock.json change.

## Fixed Issues

### CR-01: The anchored focus-loss re-arm has no upper bound and uses a clock that can go backward, so a focus loss can postpone a poll by any amount

**Files modified:** `src/team/syncScheduler.ts`, `src/test/teamScheduler.test.ts`
**Commit:** 03a4ded
**Status:** fixed: requires human verification (logic change to the focus-loss wait)
**Applied fix:** The default timers' `now()` and the `clock()` fallback use the monotonic `performance.now()` (from `node:perf_hooks`) instead of `Date.now()`. The focus-loss branch computes `full = nextDelay()` and `remaining = lastRunEndedAt + full - clock()`, and arms `Math.min(full, Math.max(0, remaining))`. A non-finite remainder falls back to `full`, which goes slightly beyond the review's suggestion so that a broken clock also cannot produce a wait that is not the bounded one.
**Regression test:** 'a clock that steps backward before a focus loss never pushes the next poll past the unfocused delay (CR-01)'. After a focused run, the fake clock advances to 10 s and then steps back one hour before `focusChanged(false)`. The test asserts the armed delay is at most, and exactly, `UNFOCUSED_POLL_MS`. Before the fix it armed 3,710,000 ms.

### WR-01: The new `focused()` and `now()` calls in `cycle()` are outside the error handling, so a throw rejects the scheduler promise unhandled and stops polling for good

**Files modified:** `src/team/syncScheduler.ts`, `src/test/teamScheduler.test.ts`
**Commit:** 74d7121
**Status:** fixed: requires human verification (new error path in the scheduler loop)
**Applied fix:** The bookkeeping after a run moved out of `cycle()` into `armAfterRun()`. Each step that calls an injected callback has its own guard that reports through `report()` (and so `onError`):
- `clock()`: on a throw the previous anchor stays. It is earlier, so a later focus loss can only poll sooner.
- `focused()`: on a throw the last known focus stays and sets the cadence.
- `nextDelay()` (which calls `pollSeconds()`): on a throw the poll is armed at `MAX_BACKOFF_MS`, the wait a failing remote settles at.
- `schedule()` (which calls `timers.set()`): on a throw the error is reported. No poll can be armed then, but a nudge, a focus gain or `start()` still runs a sync.

The guards are separate, rather than the single combined try the review suggested, so a failing clock does not also skip the focus refresh. They also cover `schedule()`, as the review recommended. `cycle()` can no longer reject, so its "Never rejects" comment holds.
**Regression tests:** three tests share an `afterRunFailure` helper that makes one callback throw once the first run has begun, fires the armed poll, and records `unhandledRejection` during the test:
- 'a focused() that throws after a run is reported to onError and polling is still re-armed (WR-01)': no unhandled rejection, every error reached `onError`, the poll was armed at 15 000 ms and the second run ran.
- 'a clock that throws after a run is reported to onError and polling is still re-armed (WR-01)': the same, armed at 15 000 ms.
- 'a pollSeconds that throws after a run is reported to onError and a poll is still armed at the backoff cap (WR-01)': the same, armed at `MAX_BACKOFF_MS`.

### WR-02: The blocked-first-sync session test leaks the starting session and its promise when it fails

**Files modified:** `src/test/teamSession.test.ts`
**Commit:** 1cf88f3
**Applied fix:** A rejection handler (`settled = starting.then((session) => session, () => undefined)`) is attached as soon as `starting` is created, so a rejection while the test is still in `until()` is never unhandled. The `finally` releases the gate, awaits `settled`, disposes `context.subscriptions`, and then disposes the session itself. This covers a session that resolved after a failure, before it was pushed to the subscriptions. `TeamSession.dispose()` is idempotent, so the double dispose on the success path is harmless. `withRig` therefore never deletes the fixtures while the first sync is still running. Test-only change, so no separate regression test. The failure-path probe described under Verification confirms the behaviour.

### IN-01: Comments now misstate focus behaviour

**Files modified:** `src/team/syncScheduler.ts`
**Commit:** 4743a0c
**Applied fix:**
- Header line 2 now says "a real focus gain or a nudge runs at once".
- The focus-loss comment now says the loss switches the wait to the unfocused delay counted from the end of the last run (shorter when pollSeconds exceeds 120 s, and at once when that delay has already passed).

### IN-02: `SchedulerTimers.now` is optional, so injected timers without it silently mix a fake `set` clock with the real `Date.now()`

**Files modified:** `src/team/syncScheduler.ts`, `src/test/teamSession.test.ts`
**Commit:** a554f6f
**Applied fix:** Both of the review's options:
- `SchedulerTimers.now()` is now required, so the compiler rejects injected timers without a clock. `clock()` has no fallback, and the default timers still supply `performance.now()`.
- The session-test `FakeTimers` gets a constant `now()` (0). The G-60-1 activity-only test now asserts `unfocused.ms === UNFOCUSED_POLL_MS` exactly instead of `UNFOCUSED_POLL_MS - 10_000 <= ms <= UNFOCUSED_POLL_MS`.

The only `SchedulerTimers` implementations are the two test `FakeTimers` classes and the default timers. `teamSession.ts` only passes the type through.

### IN-03: The stub delivers combined and no-change window-state events that VS Code never sends

**Files modified:** `src/test/helpers/vscodeStub.ts`, `src/test/teamSession.test.ts`
**Commit:** 299de97
**Applied fix:** `fireWindowState(focused, active = focused)` now behaves like VS Code's `ExtHostWindow`. It fires one `onDidChangeWindowState` event per property that actually changed (focused first, then active). Each event carries the whole state after that change. Nothing fires when the state is unchanged. The interface comment says so. A new test, 'the vscode stub fires one window-state event per changed property and none when nothing changes, as VS Code does (IN-03)', pins this:
- no event for an unchanged state
- two events, `{false,true}` then `{false,false}`, for a change to both properties
- one event each for an activity-only change and a focus-only change

The review's optional alternative, a separate `fireWindowProperty` helper, was not needed: the orchestrator asked for `fireWindowState` itself to match VS Code.

**Call sites (all in `src/test/teamSession.test.ts`; line numbers at 299de97).** No call site needed a code change. Each assertion keeps its intent:
- **L98 `resetStub`, `fireWindowState(true, true)`:** now fires nothing when the state is already `{true,true}`, and only the changed properties otherwise. Intent ("one test's window focus must never leak into the next") is kept, because the state is still reset.
- **L486-487 wiring test, `fireWindowState(false)` then `fireWindowState(true)`:** from `{true,true}` these now deliver four events: focus loss, activity loss, focus gain, activity gain. The real focus gain still syncs at once, so the assertion (the first forgery is rejected after a focus event) keeps its intent.
- **L546 G-60-1 loop, `fireWindowState(true, index % 2 === 1)`:** active alternates from `{true,true}`, so each of the 36 iterations is exactly one activity-only event, as before. The per-iteration assertions (no timer requested, pending poll not cleared) are unchanged and now test the exact shape VS Code sends.
- **L551 `fireWindowState(false, true)`:** the loop ends at `{true,true}`, so this is one focus-only event, as before. "losing focus re-arms exactly once" is unchanged.
- **L557 `fireWindowState(false, false)`:** before, this was one combined event with focus repeated as false. Now it is one activity-only event. That is closer to the assertion's intent ("an activity-only change after the loss requests no timer").
- **L563 `fireWindowState(true, true)`:** from `{false,false}`, this was one combined event and is now two: a focus gain, then an activity-only event. The gain still syncs at once and the activity event is ignored, so "a real focus gain to sync at once" and "the gain run to settle" (exactly one live timer) keep their intent.
- **L576 blocked-first-sync setup, `fireWindowState(startFocused, startFocused)`:** for `false` this is two events and for `true` no event. No listener is subscribed yet, so only the resulting state matters, and it is the same.
- **L595 `fireWindowState(!startFocused, !startFocused)` during the blocked first sync:** now two events instead of one. The session's listener is not subscribed yet, so the events are still missed, and the test still checks that the cadence comes from `focused()` after the run.
- **L518-524:** these are the new IN-03 stub test itself.

## Deviations

- **No nested worktree.** The orchestrator said to run every command in the linked worktree `.claude/worktrees/team-mode` and not switch branches. So no `gsd-reviewfix/*` worktree, temp branch or recovery sentinel was created, and the cleanup tail did not apply. The fixes are committed directly on `gsd/phase-60-team-core-identity-signed-event-log-git-transport-roster`.
- **Plain `git commit`.** Commits were made with `git commit -- <paths>` and a Co-Authored-By trailer, matching the phase's earlier fix commits, instead of `gsd-tools query commit`. Only the listed files went into each commit. `.planning/config.json` and `.planning/state.json` were left uncommitted and untouched.

---

_Fixed: 2026-11-01T16:57:53Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
