---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
reviewed: 2026-11-01T16:41:02Z
depth: standard
scope: incremental (plan 60-12, G-60-1; diff 75da082..HEAD)
files_reviewed: 5
files_reviewed_list:
  - src/team/syncScheduler.ts
  - src/services/team/teamSession.ts
  - src/test/helpers/vscodeStub.ts
  - src/test/teamScheduler.test.ts
  - src/test/teamSession.test.ts
findings:
  critical: 1
  warning: 2
  info: 3
  total: 6
status: issues_found
---

# Phase 60: Code Review Report (incremental, plan 60-12)

**Reviewed:** 2026-11-01T16:41:02Z
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

> This is an **incremental review of gap-closure plan 60-12** (G-60-1: window-state events that only change activity starved team sync polling). It covers only the diff `75da082..HEAD` in the five files listed above, plus the surrounding code needed to follow it. It replaces the earlier full-phase review in this file. That review is preserved in git history at commit `38e302f` (`git show 38e302f:.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-REVIEW.md`).

## Summary

The three G-60-1 defects are addressed:
- the equality guard in `SyncScheduler.focusChanged`
- the `focusTransitions` filter at the editor boundary
- re-reading `focused()` after each run

The one-hour fake-clock tests do lock out the starvation regression. I compiled and ran `teamScheduler.test.js` and `teamSession.test.js`: 39 tests, 39 pass.

Two problems remain in the new scheduler code, and I reproduced both with a probe script against the compiled `dist/team/syncScheduler.js`:

1. **Unbounded re-arm on a backward clock step.** The anchored focus-loss re-arm uses a wall clock (`Date.now()`) and has no upper bound. If the system clock steps backward, a focus loss can push the next poll later by the full size of the step. In the probe, a 1-hour backward step armed a 3,720,000 ms timer. This breaks the plan's must-have truth ("never later") and the module's own header comment, and it brings back the G-60-1 symptom of starved polling.
2. **Calls outside the error handling in `cycle()`.** The new `focused()` and `now()` calls sit after the `try/finally` in `cycle()`. If either throws, the scheduler's promise rejects unhandled and polling stops for good, without any report. This breaks the documented "Never rejects" contract.

The new blocked-first-sync session test also leaks a promise and a session on its failure paths.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: The anchored focus-loss re-arm has no upper bound and uses a clock that can go backward, so a focus loss can postpone a poll by any amount

**File:** `src/team/syncScheduler.ts:101` (also `:41`, `:120-122`, `:156`)
**Issue:** On a real focus loss the scheduler arms the timer with `Math.max(0, this.lastRunEndedAt + this.nextDelay() - this.clock())`. `clock()` falls back to `Date.now()`, and the default timers' `now` is also `Date.now()`. Both are wall-clock time, which jumps backward on NTP step corrections and on VM, WSL2 or container resync after a host sleep. The lower bound of 0 is clamped, but the upper bound is not. If the clock steps back by `S` ms between the end of the last run and the focus loss, the wait becomes `nextDelay() + S`.

I reproduced this with the compiled scheduler: after a focused run, a 1-hour backward step and then `focusChanged(false)` armed a timer of `3_720_000` ms instead of at most `120_000`. That breaks:
- the plan's must-have truth: "Losing focus moves the pending poll to the unfocused delay counted from the end of the last run, never later"
- the header comment at lines 5-6: "it never postpones a poll past that delay"

The failure mode is the same as G-60-1: no poll runs for an arbitrarily long time, and "Team sync paused" is not shown. Note that `setTimeout` itself counts time with a monotonic clock, so the delay goes wrong only because the anchor uses wall-clock time.
**Fix:** Use a monotonic default clock and clamp the result to the full delay, so no clock behaviour can produce a wait longer than `nextDelay()`:
```ts
import { performance } from 'node:perf_hooks';
// defaultTimers
now: () => performance.now()

private clock(): number {
  return this.timers.now === undefined ? performance.now() : this.timers.now();
}

// focusChanged, loss branch
const full = this.nextDelay();
const remaining = this.lastRunEndedAt + full - this.clock();
this.schedule(Math.min(full, Math.max(0, remaining)));
```
Add a fake-clock test that moves `clock` backward before `focusChanged(false)` and asserts the requested delay is at most `UNFOCUSED_POLL_MS`.

## Warnings

### WR-01: The new `focused()` and `now()` calls in `cycle()` are outside the error handling, so a throw rejects the scheduler promise unhandled and stops polling for good

**File:** `src/team/syncScheduler.ts:146-160`
**Issue:** `cycle()` is documented as "Never rejects: every failure of run or of the error handler ends up reported". Plan 60-12 added `this.lastRunEndedAt = this.clock()` and `this.focusedNow = this.options.focused()` after the `try/finally`. Both call injected callbacks. Before this change, `focused()` was called only in the constructor and `start()`, where a throw reaches the caller synchronously.

Now a throw from `focused()` or `timers.now()` rejects the promise stored in `inFlight`. Nothing awaits that promise, so it becomes an `unhandledRejection` in the extension host, `onError` is never called, and `schedule()` never runs. No further poll is ever armed, and no status or output line shows it.

I reproduced this: with a `focused()` that throws after the first run, the probe logged `unhandledRejection: focused failed`, `onError` was not called, and no timer was armed. The real `vscode.window.state.focused` getter is unlikely to throw. But this is the same kind of silent, permanent polling stop that G-60-1 was meant to close, and the scheduler is designed for injected callbacks.
**Fix:** Run the post-run bookkeeping inside a guard that reports any error and still arms a poll:
```ts
} finally {
  this.inFlight = undefined;
}
try {
  this.lastRunEndedAt = this.clock();
  this.focusedNow = this.options.focused();
} catch (error) {
  this.report(error);
}
this.schedule();
```
Ideally `schedule()`, which calls `pollSeconds()` and `timers.set()`, would be covered the same way.

### WR-02: The blocked-first-sync session test leaks the starting session and its promise when it fails

**File:** `src/test/teamSession.test.ts:550-586` (lines 567, 571-572, 580-583)
**Issue:** `starting` is created at line 567 and awaited only on the success path, at line 572. If `until(() => held, ...)` times out, or anything else throws before line 572:
- the `finally` releases the gate and disposes `context.subscriptions`, but that array is still empty, because subscriptions are pushed only after `TeamSession.start` resolves;
- the session is never added to `rig.sessions`, so `withRig` cannot dispose it;
- `withRig`'s `finally` then deletes the fixture directories while the first sync is still running git against them;
- `starting` is never awaited, so its later rejection, or a failure inside the running session, is an unhandled rejection. node:test reports it against whichever test is running at that moment, or as a process-level failure.

This turns one real failure into confusing failures elsewhere in the file.
**Fix:** Always settle and dispose the session in `finally`:
```ts
} finally {
  release();
  const settled = await starting.then((session) => session, () => undefined);
  settled?.dispose();
  for (const disposable of context.subscriptions) disposable.dispose();
}
```
Or push the session into `rig.sessions` once it resolves, so `withRig` disposes it before cleanup.

## Info

### IN-01: Comments now misstate focus behaviour

**File:** `src/team/syncScheduler.ts:2`, `src/team/syncScheduler.ts:98`
**Issue:**
- **Line 98** says "Losing focus only lengthens the wait". This is false when `pollSeconds` is above 120. The focused delay is then longer than the unfocused delay, so a loss shortens the wait. With the new anchoring it can even start a fetch at once (delay 0). The new test 'losing focus after more than 120 s since the last run polls at once' asserts exactly that.
- **Line 2** still says "a focus event or a nudge runs at once". After this plan, only a real focus gain runs at once.

**Fix:** Change line 98 to "Losing focus switches the wait to the unfocused delay counted from the end of the last run (shorter when pollSeconds exceeds 120 s)". Change line 2 to "a real focus gain or a nudge runs at once".

### IN-02: `SchedulerTimers.now` is optional, so injected timers without it silently mix a fake `set` clock with the real `Date.now()`

**File:** `src/team/syncScheduler.ts:19-20`, `src/test/teamSession.test.ts:56-72`, `src/test/teamSession.test.ts:533`
**Issue:** The `FakeTimers` in `teamSession.test.ts` has no `now()`. The anchored re-arm therefore subtracts real wall-clock time from a timer that never advances. The assertion at line 533 (`unfocused.ms >= UNFOCUSED_POLL_MS - 10_000`) passes only because less than 10 s of real time passes between the end of the run and the event. That holds today, but it depends on timing and is not what the interface comment says: "the same clock that set() counts against".
**Fix:** Either make `now()` required on `SchedulerTimers`, or give the session-test `FakeTimers` a clock that returns a constant, and assert `unfocused.ms === UNFOCUSED_POLL_MS` exactly.

### IN-03: The stub delivers combined and no-change window-state events that VS Code never sends

**File:** `src/test/helpers/vscodeStub.ts:137-141`
**Issue:**
- VS Code's `ExtHostWindow` fires `onDidChangeWindowState` once per property that actually changed, and fires nothing when the value is unchanged.
- `fireWindowState(false, false)` delivers one combined event with both properties changed.
- `fireWindowState(true, true)` fires even when the state is already `{ true, true }`. `resetStub` does this before every test.

The new tests therefore never model the real sequence of a focus change followed by a separate activity event. Both filters handle the stub's shapes, so nothing fails today. The risk is that a future change gets tested against event shapes that production never produces.
**Fix:** Optionally add a `fireWindowProperty('focused' | 'active', value)` helper that mirrors VS Code's per-property, change-only firing, and use it in the G-60-1 session test.

---

_Reviewed: 2026-11-01T16:41:02Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
