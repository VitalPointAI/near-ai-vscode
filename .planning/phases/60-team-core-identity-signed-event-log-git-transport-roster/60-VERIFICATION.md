---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
verified: 2026-11-01T17:30:00Z
status: human_needed
score: 11/11 must-haves verified
covered_files:
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-01-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-01-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-02-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-02-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-03-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-03-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-04-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-04-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-05-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-05-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-06-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-06-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-07-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-07-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-08-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-08-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-09-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-09-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-10-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-10-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-11-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-11-SUMMARY.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-12-PLAN.md"
  - ".planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-12-SUMMARY.md"
  - "package.json"
  - "src/domain/approval.ts"
  - "src/domain/team/canonical.ts"
  - "src/domain/team/materialize.ts"
  - "src/domain/team/permissions.ts"
  - "src/domain/team/policy.ts"
  - "src/domain/team/secrets.ts"
  - "src/domain/team/types.ts"
  - "src/domain/team/validate.ts"
  - "src/extension.ts"
  - "src/services/auditStore.ts"
  - "src/services/team/teamCommands.ts"
  - "src/services/team/teamSession.ts"
  - "src/services/team/teamStatusBar.ts"
  - "src/team/auditMirror.ts"
  - "src/team/enable.ts"
  - "src/team/eventLog.ts"
  - "src/team/gitTransport.ts"
  - "src/team/identity.ts"
  - "src/team/runGit.ts"
  - "src/team/syncScheduler.ts"
  - "src/team/teamFile.ts"
  - "src/team/transport.ts"
  - "src/test/helpers/vscodeStub.ts"
  - "src/test/teamRunGit.test.ts"
  - "src/test/teamScheduler.test.ts"
  - "src/test/teamSession.test.ts"
covered_digest: "v4:sha256:088b8f3b1ce15ed517c1a6db35336690359a66f31519f52730d037c32441bcde"
behavior_unverified: 0
overrides_applied: 0
coincidental_reliance_items: []
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed:
    - "G-60-1 (60-UAT.md test 1): activity-only window-state events starved team sync polling; the poll cadence now ignores unchanged focus, anchors a focus-loss re-arm to the last run and follows the live focused() value"
    - "All 6 findings of the incremental 60-12 review (CR-01, WR-01, WR-02, IN-01, IN-02, IN-03) are fixed in the code as it stands"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Repeat 60-UAT.md test 1 in two real VS Code windows, this time with the window that is being watched actually focused (clone-b), using the 0.6.0 team VSIX rebuilt from this branch (the existing near-ai-vscode-0.6.0-team-uat.vsix was built before the 60-12 fix). Enable Team Mode in A and push, git pull and Verify Team Log in B, then in clone-b point origin at http://127.0.0.1:9/x.git (refused), then http://10.255.255.1/x.git (stalled), then back at the good remote."
    expected: "Window B shows 'Team: <name>' and Verify Team Log lists the owner with 0 rejected events. With the refused remote the status bar reads 'Team sync paused: remote unreachable' within one poll (pollSeconds while focused, 15 s by default). With the stalled remote it ends at 'Team sync paused: remote unreachable' within about 60 s plus one poll and the window stays responsive. After the good remote is restored it returns to 'Team: <name>' within a poll or two. The result is the same on every repeat; the earlier 'paused in 5 s once, never within 90 s the next time' behaviour does not recur. A window that is not focused polls only every 120 s (D-19), so wait that long, or hold focus, before judging."
    why_human: "G-60-1 came out of a real two-window run, and the cause was only reproduced under a fake clock and a vscode stub. No automated test opens real editor windows or delivers real onDidChangeWindowState events (focused and active) from the host, so the real-window outcome of the fix is unproven. The UAT runner also could not hold OS focus, which is part of what the gap recorded."
---

# Phase 60: Team core: identity, signed event log, git transport, roster Verification Report

**Phase Goal:** A lead can turn on Team Mode for a project, and two clones of it share one signed, append-only coordination log over the project's own git remote in which every client verifies every event, roles are enforced and no secret is ever written.
**Verified:** 2026-11-01
**Status:** human_needed
**Re-verification:** Yes. The previous report predates gap plan 60-12 (commits `75da082` to `b6c3c64`: the plan, the incremental review, and the fixes for all 6 review findings). Five source files changed since then. I re-read each of them, re-ran the new tests against the old scheduler to prove they discriminate, and re-ran lint, tsc and the full suite. Everything else in the phase is unchanged since the last verification (`git diff 1617581 HEAD` outside `.planning` touches exactly `src/team/syncScheduler.ts`, `src/services/team/teamSession.ts`, `src/test/helpers/vscodeStub.ts`, `src/test/teamScheduler.test.ts` and `src/test/teamSession.test.ts`).

## Verdict

The goal is achieved in code and nothing regressed. All 5 ROADMAP success criteria hold and all 6 plan 60-12 must-have truths hold in the code as it stands after the review fixes. Evidence of this run: `./node_modules/.bin/tsc -p tsconfig.json` exits 0, `npm run lint` exits 0, and `npm test` reports 953 tests, 945 pass, 0 fail, 0 cancelled, 8 skipped (the same environment skips as before). The status is `human_needed` for one reason: G-60-1 was found in a real-window UAT and the fix is proven only against the stub and a fake clock, so UAT test 1 needs a human re-check (see the human item).

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Lead runs `NEAR AI: Enable Team Mode` and gets a team, owner key only in SecretStorage, orphan branch, committed team.json; canaries never appear anywhere (TEAM-01, SEC-01) | VERIFIED | Files unchanged since the last verification (`enable.ts`, `teamFile.ts`, `eventLog.ts`, `auditMirror.ts`, `identity.ts` not in the 60-12 diff). Enable and both SEC-01 canary tests pass in the full run. |
| 2 | Two clones share one coordination branch and materialise identically; replay deterministic (TEAM-04) | VERIFIED | Convergence and seeded determinism property tests pass in the full run; `materialize.ts` and `eventLog.ts` unchanged. |
| 3 | Forged event (bad signature, unbound key, insufficient role) is rejected by both clients and listed with a reason; roles enforced on write and on read (TEAM-04, SEC-04) | VERIFIED | Forgery suite and permission matrix pass in the full run; `permissions.ts` and `materialize.ts` unchanged. The session wiring test still rejects a forged event after a real focus transition. |
| 4 | Concurrent appends never lose an event, no force-push (TEAM-04) | VERIFIED | `teamConcurrency.test.ts` passes in the full run; `gitTransport.ts` unchanged. |
| 5 | Solo projects behave exactly as 0.4.8; lint and full test pass | VERIFIED | Solo-parity test passes; `src/extension.ts` and `teamCommands.ts` unchanged (`git diff --quiet 1617581 -- src/services/team/teamCommands.ts` exits 0, so the 4-argument caller still compiles); `package.json` and `package-lock.json` unchanged since `1617581`. |

### Observable Truths (plan 60-12 must_haves, G-60-1)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 6 | A window-state event that does not change focus neither clears nor re-arms the pending poll and never starts a sync, at the session listener and in `SyncScheduler.focusChanged` | VERIFIED | `syncScheduler.ts:94` returns at once when `focused === this.focusedNow`, before any clear, re-arm or run. `teamSession.ts:391-398` `focusTransitions(initialFocused, forward)` forwards only when `state.focused` differs from the last value; `createVscodeTeamSession` (line 430) wires `onDidChangeWindowState` through it. Tests: 'a focus event that does not change focus neither re-arms the wait nor starts a run', 'focusTransitions forwards only real focus changes', and the session test 'window-state events that only change activity neither re-arm the poll nor sync, and real focus changes still do (G-60-1)' (36 activity-only events through the stub, no new timer, no clear, no fetch). All pass. |
| 7 | Under a fake clock, unchanged-focus events every 100 s for one hour give the same number of polls as no events; the same for a failing remote with events every 200 s | VERIFIED | Tests 'unchanged focus events every 100 s for an hour still give every 120 s poll (G-60-1)' (baseline at least 30) and '... every 200 s with a failing remote ...' (baseline at least 6) assert `withEvents === baseline`. They pass. **Discrimination proof:** I replaced `syncScheduler.ts` with the `1617581` version (git show), rebuilt, and ran `teamScheduler.test.js`: both starvation tests FAIL (plus 7 other new tests, 9 failures in all), then I restored the file (`git diff --quiet` clean) and all 23 scheduler tests pass again. So the tests do detect the original defect. |
| 8 | Losing focus moves the pending poll to the unfocused delay counted from the end of the last run, never later; gaining focus still syncs at once (D-19, D-25) | VERIFIED | `syncScheduler.ts:92-110`: gain calls `requestRun()`; loss with no run in flight arms `min(full, max(0, lastRunEndedAt + full - clock()))`, with a non-finite remainder falling back to `full`. Tests 'losing focus moves the next poll to 120 s after the last run, not after the event' (delays [15000, 110000], no run at 119 999, one at 120 000), 'losing focus after more than 120 s since the last run polls at once' (delay 0), and the CR-01 test 'a clock that steps backward before a focus loss never pushes the next poll past the unfocused delay' (armed delay exactly `UNFOCUSED_POLL_MS`). The default clock is now monotonic (`performance.now()`, line 44) and `SchedulerTimers.now()` is required (IN-02). All pass. |
| 9 | The poll cadence follows the live `focused()` value each time a poll is armed after a run, so a focus change during a blocked first sync is not lost (5 s with pollSeconds 5, not 120 s) | VERIFIED | `armAfterRun()` (line 168) re-reads `this.focusedNow = this.options.focused()` after each run and arms `nextDelay()`; it never starts a run. Tests 'the cadence follows focused() after each run even when no focus event arrived' (both directions) and the session test 'a focus change while the first sync is blocked still sets the cadence of the first poll (G-60-1)' (first poll 5 000 ms, never 120 000, and the mirror case arms 120 000). All pass. |
| 10 | D-19/D-25 cadence unchanged: focused polls pollSeconds clamped 5..3600, unfocused 120 s, delay doubles per failure to 600 s, a healthy run resets it; every pre-existing delay assertion holds | VERIFIED | Constants unchanged (`UNFOCUSED_POLL_MS = 120_000`, `MAX_BACKOFF_MS = 600_000`, `MIN/MAX/DEFAULT_POLL_SECONDS = 5/3600/15`), `nextDelay()` doubling rule unchanged (lines 114-118). `git diff 1617581 HEAD` of the two test files removes no assertion line (only a type declaration, a harness signature and an import line were replaced). The three pre-existing 'focus gain' call sites that delivered focus already true were rewritten to a loss followed by a gain (`teamSession.test.ts` lines 398-399, 404-405, 486-487) with assertions untouched, as the plan directed and the SUMMARY lists under Deviations. |
| 11 | `npm run lint` and full `npm test` pass, 0 failures, no package.json or package-lock.json change | VERIFIED | `npm run lint` exit 0; `npm test` exit 0 with 953 tests, 945 pass, 0 fail, 0 cancelled, 8 skipped; `git diff --quiet 1617581 HEAD -- package.json package-lock.json` exits 0. |

**Score:** 11/11 truths verified (0 present, behavior-unverified)

The behavior-dependent truths (6 to 9: state and ordering invariants of a timer loop) are each backed by a named test that exercises the transition, and the discrimination run shows those tests fail against the pre-fix scheduler. They are VERIFIED on behavior, not on presence.

### Review fix verification (incremental review of 60-12, `60-REVIEW.md`, 6 of 6 fixed)

| Finding | Fix confirmed in the current code | Regression test |
|---------|-----------------------------------|-----------------|
| CR-01 (focus-loss wait unbounded, wall clock can step back) | `syncScheduler.ts:105-108` clamps the wait to `0..full`; default `now` is `performance.now()` (line 44) | 'a clock that steps backward before a focus loss ...' passes |
| WR-01 (post-run callbacks outside error handling) | `armAfterRun()` (lines 168-196) guards `clock()`, `focused()`, `nextDelay()` and `schedule()` separately, each reporting via `report()`; `cycle()` can no longer reject | three WR-01 tests (throwing `focused`, clock, `pollSeconds`) pass; they FAIL against the old scheduler in my discrimination run |
| WR-02 (blocked-first-sync test leaked its session on failure) | `1cf88f3`, test-only: rejection handler attached at creation, `finally` releases the gate, awaits and disposes | the failure-path probe is recorded in `60-REVIEW-FIX.md`; the test passes |
| IN-01 (comments misstate focus behaviour) | Header and focus-loss comments (lines 1-8, 101-104) now match the behaviour | n/a |
| IN-02 (`SchedulerTimers.now` optional) | `now(): number` required (line 23); `clock()` has no fallback; the session-test `FakeTimers` has a constant `now`; exact `UNFOCUSED_POLL_MS` assertion | compiles under tsc; tests pass |
| IN-03 (stub fired events VS Code never sends) | `fireWindowState(focused, active = focused)` fires one event per changed property, none when unchanged | 'the vscode stub fires one window-state event per changed property and none when nothing changes' passes |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/team/syncScheduler.ts` | Ignores unchanged focus, anchors focus-loss re-arm, refreshes focus after each run | VERIFIED | 217 lines, substantive; imports only `node:perf_hooks`, no vscode; used by `teamSession.ts` (line 172) |
| `src/services/team/teamSession.ts` | `focusTransitions`, `createVscodeTeamSession` with `overrides` | VERIFIED | Exports present (lines 393, 404); `teamCommands.ts` still calls it with 4 arguments |
| `src/test/helpers/vscodeStub.ts` | `fireWindowState(focused, active)` | VERIFIED | Present, matches VS Code per-property firing |
| `src/test/teamScheduler.test.ts` | Unchanged-focus, one-hour, anchored, self-correction, CR-01, WR-01 tests | VERIFIED | 23 tests pass; the new ones fail against the old scheduler |
| `src/test/teamSession.test.ts` | Session-level activity-only, real-transition, blocked-first-sync tests | VERIFIED | Phase total with the scheduler file: 44 tests, 44 pass |
| All earlier Phase 60 artifacts | per the previous report | VERIFIED | Unchanged in this round; full suite green |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `teamSession.ts` | `syncScheduler.ts` | `onDidChangeWindowState` -> `focusTransitions` -> `session.focusChanged` -> `scheduler.focusChanged`, only on real change | WIRED | `teamSession.ts:430`, `:221-222`; exercised by the session test through the stub |
| `syncScheduler.ts` | `options.focused()` | re-read in `armAfterRun()` after every run | WIRED | line 177; `deps.focused` passed at `teamSession.ts:175` and set to `vscode.window.state.focused` |
| `teamSession.test.ts` | `vscodeStub.ts` | `stub.fireWindowState(focused, active)` into `createVscodeTeamSession` | WIRED | 14 call sites |
| Earlier links (extension -> registerTeamMode, write/read -> `decideTeamAction`, write sites -> `assertNoSecrets`, session -> status bar, transport 124 -> unreachable) | | | WIRED | files unchanged; suites pass |

### Data-Flow Trace (Level 4)

The scheduler's delay is derived from `deps.pollSeconds` (live VS Code configuration) and `deps.focused` (live `vscode.window.state.focused`), not from literals; status text derives from real `TeamLog.state()` and transport status as before. FLOWING.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Type check | `./node_modules/.bin/tsc -p tsconfig.json` | exit 0 | PASS |
| Lint | `npm run lint` | exit 0 | PASS |
| Scheduler and session tests | `node --test dist/test/teamScheduler.test.js dist/test/teamSession.test.js` | 44 tests, 44 pass, 0 fail | PASS |
| New tests detect the defect | `1617581` `syncScheduler.ts` swapped in, rebuilt, scheduler tests run, then restored | 9 failures including both one-hour starvation tests; restored, 23 of 23 pass | PASS |
| Full suite (run once) | `npm test` | 953 tests, 945 pass, 0 fail, 0 cancelled, 8 skipped (environment) | PASS |
| Debt markers | grep `TBD|FIXME|XXX` in the changed source and the stub | none | PASS |

### Probe Execution

No probes declared by the phase. Skipped.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| TEAM-01 | 60-06, 60-08, 60-11 | Lead can enable Team Mode; solo projects unchanged | SATISFIED | Truths 1 and 5 |
| TEAM-04 | 60-01, 03, 04, 05, 07, 09, 10, 12 | Every client verifies every event's signature and author permission at that log point; an unreachable remote shows a visible paused state | SATISFIED in code | Truths 2, 3, 4, 6-10. The polling that drives the visible paused state is now correct under the fake clock; the real-window re-check is the open human item |
| SEC-01 | 60-02, 06, 07, 08, 09, 11 | No secret written to log, team.json, settings or audit | SATISFIED | `assertNoSecrets` sites unchanged; canary tests pass |
| SEC-04 | 60-02, 05, 07 | Role permissions enforced on write and on read | SATISFIED | One shared `decideTeamAction`; forgery suite passes |

All four IDs from the ROADMAP and the PLAN `requirements:` frontmatter (60-01 to 60-12) appear in REQUIREMENTS.md; no orphaned requirement for Phase 60. REQUIREMENTS.md still lists TEAM-01 as `Pending` and SEC-01 and SEC-04 as `In Progress`; updating that table is bookkeeping for the orchestrator.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| none in the files changed by 60-12 | | no debt markers, no empty catch (every catch in `armAfterRun` and `report` reports), no `any`, no em-dash in code comments | n/a | n/a |

Residual notes (not gaps):
- `createVscodeTeamSession` registers its window-state listener after the awaited start, seeded from the live `vscode.window.state.focused`. A focus change that lands in the few microtasks between `armAfterRun()` and that registration would be absorbed by the seed without a forward. The cadence is corrected the next time a poll is armed after a run, and a gain only skips one immediate sync, so the effect is at most one cadence step. It does not touch any must-have.
- The six open info items IN-01 to IN-06 of the earlier full-phase review remain open by that review's scope (`60-REVIEW-DISPOSITION.md` in git history at `e2b04fa`) and bear on no success criterion.
- `60-UAT.md` still shows test 1 as `issue` and G-60-1 as `failed`, status `diagnosed`. Closing it depends on the human re-check below. Also from the gap's `missing` list: the UAT harness item (hold OS focus, log `window.state` and the scheduler delay, state a focused window in the test wording) is outside plan 60-12's file list and was not done in code; the human item above states the focus requirement.

### Human Verification Required

#### 1. Re-run UAT test 1 in two real windows with the watched window focused

**Test:** Install a VSIX built from this branch (the existing `near-ai-vscode-0.6.0-team-uat.vsix` predates the fix), open clone-a and clone-b in two windows, Enable Team Mode in A and push, `git pull` and Verify Team Log in B. Then in clone-b set origin to `http://127.0.0.1:9/x.git`, then to `http://10.255.255.1/x.git`, then back to the good remote, keeping window B focused throughout.
**Expected:** B shows `Team: <name>` and 0 rejected events; refused remote shows `Team sync paused: remote unreachable` within one poll; stalled remote ends at the same text within about 60 s plus one poll with the window responsive; the good remote returns it to `Team: <name>` within a poll or two; repeated runs give the same result. An unfocused window legitimately polls only every 120 s.
**Why human:** G-60-1 was observed in real windows and reproduced only under a fake clock and a stub; no automated test delivers real host `onDidChangeWindowState` events.

### Gaps Summary

No must-have failed and there are no `gaps:` for gap-closure planning. G-60-1 is closed in code: unchanged-focus events are ignored at the session and the scheduler, a focus loss re-arms from the last run with a bounded wait on a monotonic clock, the cadence follows the live focus value after each run, post-run callback failures are reported without stopping polling, and all six review findings are fixed with tests that fail against the pre-fix scheduler. The phase is ready to proceed once the real-window re-check of UAT test 1 is done (or explicitly waived by the owner).

---

_Verified: 2026-11-01_
_Verifier: Claude (gsd-verifier)_
