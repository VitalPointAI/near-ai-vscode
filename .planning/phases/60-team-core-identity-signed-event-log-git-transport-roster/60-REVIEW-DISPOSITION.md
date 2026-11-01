---
phase: 60
review: 60-REVIEW.md
titles: json
findings:
  - id: CR-01
    severity: critical
    disposition: fixed
    title: "The anchored focus-loss re-arm has no upper bound and uses a clock that can go backward, so a focus loss can postpone a poll by any amount"
  - id: WR-01
    severity: warning
    disposition: fixed
    title: "The new `focused()` and `now()` calls in `cycle()` are outside the error handling, so a throw rejects the scheduler promise unhandled and stops polling for good"
  - id: WR-02
    severity: warning
    disposition: fixed
    title: "The blocked-first-sync session test leaks the starting session and its promise when it fails"
  - id: IN-01
    severity: info
    disposition: fixed
    title: "Comments now misstate focus behaviour"
  - id: IN-02
    severity: info
    disposition: fixed
    title: "`SchedulerTimers.now` is optional, so injected timers without it silently mix a fake `set` clock with the real `Date.now()`"
  - id: IN-03
    severity: info
    disposition: fixed
    title: "The stub delivers combined and no-change window-state events that VS Code never sends"
open: 0
total: 6
recorded: 2026-11-01T16:57:53Z
---

# Phase 60: Code Review Disposition

This records the **incremental review of gap plan 60-12** (G-60-1) in `60-REVIEW.md`. That review reuses the IDs CR-01, WR-01, WR-02 and IN-01 to IN-03 for different findings. The earlier disposition of the full-phase review (CR-01, WR-01 to WR-12 fixed; IN-01 to IN-06 open) is in git history at commit `e2b04fa` (`git show e2b04fa:.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-REVIEW-DISPOSITION.md`).

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| CR-01 | critical | fixed | 60-REVIEW-FIX.md (commit 03a4ded; monotonic default clock, focus-loss wait clamped to 0..nextDelay(); backward-clock regression test) |
| WR-01 | warning | fixed | 60-REVIEW-FIX.md (commit 74d7121; post-run callbacks guarded and reported, poll still armed; throwing focused/clock/pollSeconds regression tests) |
| WR-02 | warning | fixed | 60-REVIEW-FIX.md (commit 1cf88f3; starting session settled and disposed on every test path) |
| IN-01 | info | fixed | 60-REVIEW-FIX.md (commit 4743a0c; scheduler comments corrected) |
| IN-02 | info | fixed | 60-REVIEW-FIX.md (commit a554f6f; SchedulerTimers.now required, session-test clock pinned, exact UNFOCUSED_POLL_MS assertion) |
| IN-03 | info | fixed | 60-REVIEW-FIX.md (commit 299de97; fireWindowState fires per changed property and not on no change; call sites recorded) |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row (the id is taken) and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
