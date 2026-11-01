---
status: complete
phase: 60-team-core-identity-signed-event-log-git-transport-roster
source: [60-VERIFICATION.md]
started: 2026-11-01T14:09:01Z
updated: 2026-11-01T18:57:20.765Z
---

## Current Test

[testing complete]

## Tests

### 1. Two real VS Code windows on two clones share the team, and an unreachable or stalled remote shows Team sync paused
expected: Setup: install /home/aaron/projects/near-ai-team-uat/near-ai-vscode-0.6.0-team-uat.vsix (Extensions: Install from VSIX; reinstall 0.4.9 from the Marketplace afterwards). Open /home/aaron/projects/near-ai-team-uat/clone-a in one window and /home/aaron/projects/near-ai-team-uat/clone-b in a second window. In window A run NEAR AI: Enable Team Mode, accept the defaults, then click Push when offered (that pushes the commit holding team.json). In window B run git pull, then NEAR AI: Verify Team Log. Expected: window B's status bar reads "Team: <name>" and Verify Team Log lists the owner in the roster with no rejected events. Then in clone-b run git remote set-url origin http://127.0.0.1:9/x.git (refused): within one poll the status bar reads "Team sync paused: remote unreachable". Then git remote set-url origin http://10.255.255.1/x.git (stalled, no answer): within about 60 s the status bar still ends at "Team sync paused: remote unreachable" rather than staying on the healthy text, and the window stays responsive. Then git remote set-url origin /home/aaron/projects/near-ai-team-uat/remote.git: within a poll or two it returns to "Team: <name>".
result: issue
reported: "Automated real-window runs (two VS Code 1.144.0 instances, separate user-data dirs, scratch repos in ~/projects/near-ai-team-uat): Enable in A passed (team created, team.json committed and pushed, status Team: clone-a); B synced (Team: clone-a; Verify Team Log 2 events, 1 member, 0 rejected); a stalled remote paused after 65 s with the window responsive (2-5 ms command round trips). But status transitions are unreliable: in one run a refused remote paused in 5 s and recovered in 10 s, in the next it never paused within 90 s; after a stall the restored remote stayed paused for 180 s. No stale lock files in the mirror; a manual fetch into it succeeded."
severity: major

### 2. Decide whether code review finding CR-01 is accepted for Phase 60 or fixed before closing
expected: Either an explicit accept with reason, or a fix (settle from the timer and kill the process group) with a regression test that a timed-out git whose helper holds the pipes still settles.
result: pass
reason: "Owner chose fix; fixed in 53b3fc6 (process-group kill, settle from timer) with regression test teamRunGit.test.ts; re-verified 2026-11-01"

### 3. Re-test of test 1 after gap plan 60-12 (G-60-1) and its review fixes
expected: Same steps as test 1, on a VSIX/dev build from the phase-60 branch at a37d410. Window B shows "Team: <name>" and Verify Team Log reports 0 rejected events; a refused remote shows "Team sync paused: remote unreachable" within one poll; a stalled remote ends at the same text within about 60 s plus one poll with the window responsive; restoring the good remote returns to "Team: <name>" within a poll or two. Polls happen at the documented cadence (focused 5 s, unfocused 120 s, doubled per failure) and window-state events that do not change focus never postpone a poll.
result: pass
source: automated real-window run (Claude, at the owner's request), 2026-11-01
evidence: |
  Two real VS Code 1.144.0 windows (separate user-data dirs) on fresh repos in ~/projects/near-ai-team-uat/run-60-12, extension from the worktree build of a37d410, harness dist/test/e2e/teamUat.js with window-state logging added.
  A: Enable answered 3 prompts, team.json committed and pushed to main, near-ai/coordination created, status "Team: clone-a".
  B (NEAR AI Team channel): Verify Team Log Status ok, Events 2 (2 accepted, 0 rejected), Members 1 (UAT clone-a, owner), Rejected events 0; status "Team: clone-a" at once.
  Window B was focused at start but lost OS focus 2 s later (the desktop was in use), so most of the run exercised the unfocused cadence:
  - refused (127.0.0.1:9) at 18:48:13: paused at 18:50:14, exactly one unfocused poll (120 s) after the last run, although an activity-only event (focused=false active=false) arrived at 18:49:22. Before the fix that event re-armed the timer and starved polling.
  - restored at 18:50:14: focus gain at 18:51:01 synced at once, "Team: clone-a" (48 s).
  - stalled listener at 18:51:01: focus gain at 18:51:34 started a sync that hung; git timed out after 60000 ms and the bar read "Team sync paused: remote unreachable" at 18:52:34 (93 s); 1 connection held; slowest command round trip 13 ms.
  - restored at 18:52:34 (unfocused, 1 failure): "Team: clone-a" at 18:56:34, exactly 240 s (120 s doubled once, D-19/D-25); an activity-only event at 18:52:55 did not postpone it. No git processes left running.
note: The focused 5 s cadence was not held for the whole run because the real window lost focus; the unfocused path, which is what G-60-1 starved, ran on schedule, and every focus gain synced at once.

## Summary

total: 3
passed: 2
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-60-1
  truth: "The Team status bar reliably moves to Team sync paused when the remote is refused or stalled, and back to Team: <name> once the remote returns"
  status: resolved
  reason: "Automated real-window UAT: Automated real-window runs (two VS Code 1.144.0 instances, separate user-data dirs, scratch repos in ~/projects/near-ai-team-uat): Enable in A passed (team created, team.json committed and pushed, status Team: clone-a); B synced (Team: clone-a; Verify Team Log 2 events, 1 member, 0 rejected); a stalled remote paused after 65 s with the window responsive (2-5 ms command round trips). But status transitions are unreliable: in one run a refused remote paused in 5 s and recovered in 10 s, in the next it never paused within 90 s; after a stall the restored remote stayed paused for 180 s. No stale lock files in the mirror; a manual fetch into it succeeded."
  severity: major
  test: 1
  resolved_by: 60-12-PLAN.md
  resolved_at: 2026-11-01
  root_cause: "Polling stops, the status text is correct. Poll cadence follows a cached focus flag (syncScheduler.ts:49) written only by onDidChangeWindowState events (teamSession.ts:413). focusChanged() has no change check, so every window-state event with unchanged focus (e.g. active=false) clears and re-arms the poll timer from now (syncScheduler.ts:81-92); a stream of events closer than the delay starves polling (fake clock: 1 run in 1 h). Repeated focusChanged(true) runs an unthrottled sync each time. The listener is registered after the awaited first sync (teamSession.ts:395-413), so a focus change during it is lost and focused() is never re-read. Unfocused 120 s base, doubled per failure up to 600 s, is by design (D-19/D-25). The UAT harness could not hold focus (UAT_FORCE_FOCUS only replaced window.state) and waited less than the unfocused cadence."
  artifacts:
    - path: "src/team/syncScheduler.ts"
      issue: "focusedNow cached and event-written only; focusChanged re-arms the timer on unchanged focus and starts an extra run on repeated true"
    - path: "src/services/team/teamSession.ts"
      issue: "forwards activity-only window-state events as focus changes; registers the listener after the awaited first sync; never re-reads focused()"
    - path: "src/test/helpers/vscodeStub.ts"
      issue: "fireWindowState(focused) has no active flag, so tests cannot deliver an unchanged-focus event"
    - path: "src/test/teamScheduler.test.ts"
      issue: "no test for repeated focusChanged with unchanged focus or for starvation"
  missing:
    - "Scheduler: ignore focusChanged(x) when x equals the current focus; anchor the next poll to the last run so a transition cannot postpone a pending poll; let the cadence follow the live focused() value"
    - "Session: forward only real focus transitions; register onDidChangeWindowState before the first sync (or re-read focused() after it)"
    - "Regression tests: repeated unchanged focus events neither re-arm nor add runs (unit and fake-clock 1 h starvation case); session test with {focused:false,active:true} then {focused:false,active:false}; focus gain during a blocked first sync keeps the 5 s cadence; vscodeStub fireWindowState(focused, active)"
    - "UAT harness: hold OS focus or nudge a sync after each remote change, log window.state and the scheduler delay; Test 1 wording states a focused window"
  debug_session: ".planning/debug/team-status-paused-recovery.md"
