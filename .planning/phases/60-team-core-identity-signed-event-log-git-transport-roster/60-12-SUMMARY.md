---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 12
subsystem: team
tags: [sync-scheduler, window-state, focus, polling, starvation, gap-closure, g-60-1]
gap_ids: [G-60-1]

requires:
  - phase: 60-09
    provides: "SyncScheduler, TeamSession, createVscodeTeamSession and the vscode stub this plan corrects"
  - phase: 60-11
    provides: "teamCommands.ts, the single production caller of createVscodeTeamSession (left unchanged)"
provides:
  - "SyncScheduler.focusChanged ignores a call that does not change focus: no clear, no re-arm, no run"
  - "A real focus loss re-arms the pending poll to lastRunEndedAt plus the unfocused delay (never later); a real gain still syncs at once"
  - "The scheduler reads focused() every time it arms a poll after a run, so a focus change during the awaited first sync is not lost"
  - "SchedulerTimers.now(), focusTransitions() and createVscodeTeamSession overrides for tests, vscodeStub fireWindowState(focused, active)"
affects: [60-verify-work]

actuals:
  tokens: 4610
  tasks: 2
  commits: 5
plan_head_before: 75da082fb061766d64dae815cc8461fe0b261050
plan_head_after: 553e0d714ea86dd35c2de1f9452c82f1308189a9

tech-stack:
  added: []
  patterns:
    - "Event filters at the editor boundary (focusTransitions) plus an idempotence guard in the scheduler, so no event stream can restart a wait"
    - "Re-arm anchored to a recorded timestamp rather than to the event time"
    - "Cadence inputs re-read from the live callback at the moment a timer is armed, not only from events"
    - "Fake clock in the timer double so starvation is proven over one simulated hour"

key-files:
  created: []
  modified:
    - src/team/syncScheduler.ts
    - src/services/team/teamSession.ts
    - src/test/helpers/vscodeStub.ts
    - src/test/teamScheduler.test.ts
    - src/test/teamSession.test.ts

key-decisions:
  - "Owner decision 2026-11-01 honoured: a focused window becoming active again does not sync; it already polls at pollSeconds"
  - "D-19/D-25 constants and the doubling rule are unchanged; no throttle was added to real focus gains"
  - "A refreshed focus gain after a run only shortens the next wait and never starts a run; only a real focusChanged(true) runs at once"

requirements-completed: [TEAM-04]

duration: about 25 min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 12: G-60-1 polling starvation Summary

Window-state events that change nothing can no longer starve or multiply sync polls: the scheduler ignores unchanged focus, a focus loss is counted from the last run, and the poll cadence is re-read from the live window focus after every run.

## What was built

Three defects behind G-60-1 are fixed, with the D-19/D-25 cadence untouched (focused every pollSeconds clamped 5..3600, unfocused 120 s, doubling per failure to 600 s, immediate run on a real focus gain).

1. `SyncScheduler.focusChanged` returns at once when the value equals the current focus. Before, every call cleared and re-armed the pending timer from now (one run per hour under a 100 s event stream) and a repeated `focusChanged(true)` started a run per call.
2. `createVscodeTeamSession` registers `onDidChangeWindowState` through the new exported `focusTransitions(initialFocused, forward)`, which forwards only real focus changes. VS Code also fires the event for activity-only changes.
3. The scheduler records `lastRunEndedAt` when a cycle ends and reads `options.focused()` again before arming the next poll. A real focus loss re-arms with `max(0, lastRunEndedAt + nextDelay() - now)`. `SchedulerTimers` gained an optional `now()` (default timers provide `Date.now`).

`createVscodeTeamSession` takes an optional fifth parameter `overrides: Pick<TeamSessionDeps, 'timers' | 'git'>` so tests inject timers and a git runner. `teamCommands.ts` still calls it with 4 arguments and is byte-identical to 1617581.

## Tasks and commits

| Step | Commit | Subject |
| ---- | ------ | ------- |
| T1 seam | f8825b2 | refactor(60): G-60-1 add focusTransitions helper and test overrides to createVscodeTeamSession |
| T1 red | fdf7f4f | test(60): G-60-1 failing tests for activity-only window-state events |
| T1 fix | 1fb8bc3 | fix(60): G-60-1 ignore window-state events that do not change focus |
| T2 red | 31cf17a | test(60): G-60-1 fake-clock starvation, anchored focus loss and focus self-correction tests |
| T2 fix | 553e0d7 | fix(60): G-60-1 anchor focus-loss re-arm to the last run and follow focused() after each run |

Red state before each fix, observed:

- After fdf7f4f: 33 tests, 31 pass, 2 fail ('a focus event that does not change focus neither re-arms the wait nor starts a run': "the pending timer was not cleared, true !== false"; 'window-state events that only change activity ...': "activity-only event 0 left the pending poll alone, true !== false"). After 1fb8bc3: 33 of 33 pass.
- After 31cf17a: 39 tests, 35 pass, 4 fail (anchored loss expected [15000, 110000]; overdue loss expected [3600000, 0]; focused() after each run expected [5000]; blocked first sync "120000 !== 5000"). The two starvation tests passed already, as the plan predicted, and are proven below. After 553e0d7: 39 of 39 pass.

## Defect-present check of the starvation tests

State used: `src/team/syncScheduler.ts` replaced with `git show 1617581:src/team/syncScheduler.ts` (no guard, no anchoring), with the working tree clean before (`git diff --quiet` exit 0). The tests compiled against it (`tsc` exit 0).

`node --test --test-name-pattern "unchanged focus events every" dist/test/teamScheduler.test.js` with the 1617581 scheduler: 2 tests, 0 pass, 2 fail.

```
✖ unchanged focus events every 100 s for an hour still give every 120 s poll (G-60-1)
  AssertionError: Expected values to be strictly equal:  1 !== 31   (teamScheduler.test.js:326)
✖ unchanged focus events every 200 s with a failing remote still give every backed-off poll (G-60-1)
  AssertionError: Expected values to be strictly equal:  1 !== 7    (teamScheduler.test.js:332)
```

After `git checkout -- src/team/syncScheduler.ts`, recompile and the same command: 2 tests, 2 pass, 0 fail. `git diff --quiet -- src/team/syncScheduler.ts` exits 0. The healthy baseline is 31 polls (start run plus one every 120 s) and the failing baseline is 7.

## Verification results

- `./node_modules/.bin/tsc -p tsconfig.json && node --test dist/test/teamScheduler.test.js dist/test/teamSession.test.js`: 39 tests, 39 pass, 0 fail (30 at 1617581, plus 3 for Task 1 and 6 here).
- `npm run lint` (`tsc --noEmit`): exit 0, no output.
- `npm test` (compile plus all `dist/test/*.test.js`): 948 tests, 940 pass, 0 fail, 8 skipped (the same environment skips as 60-REVIEW-FIX, which had 939 tests; 939 plus 9 new is 948).
- Acceptance greps: `now?(): number` 1 match; `UNFOCUSED_POLL_MS = 120_000` and `MAX_BACKOFF_MS = 600_000` one line each; `fireWindowState(focused: boolean, active?: boolean)` 1; `export function focusTransitions` 1; `focusTransitions(vscode.window.state.focused` 1; no vscode import in syncScheduler.ts; no empty catch blocks; no em-dash characters in the checked files.
- `git diff --quiet 1617581 -- package.json package-lock.json src/services/chat.ts src/services/team/teamCommands.ts` exits 0.
- `.planning/config.json` and `.planning/state.json` still show the same two uncommitted modifications; `dist/test/e2e/teamUat.js` still exists.

## Deviations from Plan

### Auto-fixed Issues

None.

### Plan-directed rewrites

**1. Three existing focus-gain call sites rewritten (owner_rules).** These delivered a "focus gain" with focus already true, which is exactly the defect fixed, so under the new rule they would do nothing. Each now delivers a real gain, a loss followed by a gain. Their assertions are unchanged.

- `started.session.focusChanged(true)` in the unreachable-remote test (first site, retry at once): now `focusChanged(false)` then `focusChanged(true)`.
- `started.session.focusChanged(true)` in the same test (second site, recovery): same rewrite.
- `stub.fireWindowState(true)` in the createVscodeTeamSession wiring test: now `stub.fireWindowState(false)` then `stub.fireWindowState(true)`.

### Process notes

**2. Task 1 split into a seam commit, a red test commit and a fix commit.** The new session tests call `focusTransitions` and the `overrides` parameter, so they could not compile (and could not show red) without them. The helper and parameter were committed first (f8825b2) unwired, then the failing tests (fdf7f4f), then the wiring and scheduler guard (1fb8bc3). The plan lists these as one task; the split keeps every commit compiling while still committing red tests before the fix.

**3. Task 2 scheduler and session commit subjects use `fix(60): G-60-1` and `test(60): G-60-1` as the plan's owner_rules require, plus one `refactor(60): G-60-1` for the seam.** No `(60-12)` scope was used because the plan overrides the commit format.

**4. Worktree branch guard.** The task-commit worktree allow-list (`agent-*` branches) does not apply: the orchestrator dispatched this plan onto its own linked worktree on the configured phase branch `gsd/phase-60-...`, which is not a protected branch. HEAD stayed on that branch throughout.

## Known Stubs

None.

## Threat Flags

None. The only new surface is the optional `overrides` parameter (T-60-53, accepted): reachable from code only, and the single production caller passes none.

## Notes for the orchestrator's real-window UAT re-run

Window B should be focused, or a sync nudged after each `git remote set-url` by changing `nearAi.team.pollSeconds`. With pollSeconds 5 and a focused window a refused remote pauses within about 5 to 10 s, a stalled remote after the 60 s git timeout, and recovery follows within one or two backed-off polls. An unfocused window keeps the designed 120 s base.

## Self-Check: PASSED

- FOUND: src/team/syncScheduler.ts, src/services/team/teamSession.ts, src/test/helpers/vscodeStub.ts, src/test/teamScheduler.test.ts, src/test/teamSession.test.ts
- FOUND commits: f8825b2, fdf7f4f, 1fb8bc3, 31cf17a, 553e0d7
