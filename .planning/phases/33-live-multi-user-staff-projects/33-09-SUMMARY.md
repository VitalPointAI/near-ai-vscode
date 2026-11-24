---
phase: 33-live-multi-user-staff-projects
plan: 09
status: complete
subsystem: the live replicator in full and the words of every sync state
tags: [staff, replica, live, sync, d-09, d-12, d-13, d-14, d-32, d-67, d-69]
requires: [33-07, 33-08]
provides: [readLiveFrame, LiveFrame, PresenceFrame, LiveReplicator.updated, LiveReplicatorOptions.isLeadDevice, LiveReplicatorOptions.networkProbe, LiveReplicatorOptions.resumeGapMs, ESCALATING_FINDINGS, LEAD_PROBE_MS, RESUME_GAP_MS, TICK_MS, SYNC_WORDS, SYNC_ACTIONS, syncSentence, syncAction, syncAccessibleName, findingSentence, refusalSentence, RESTORING_TEXT, QUARANTINE_TEXT, FINDING_TEXT, liveClient]
affects: [33-12, 33-24, 33-26, 33-28]
tech-stack:
  added: []
  patterns: [strict frame reading before use, escalate findings at the replicator, a probe timer for states that wait on a person]
key-files:
  created:
    - src/staff/replica/hubLive.ts
    - src/domain/staff/liveSentences.ts
    - src/test/staffLiveReplicator.test.ts
    - src/test/staffLiveSentences.test.ts
    - hub/test/liveReplicator.test.ts
    - hub/test/helpers/liveClient.ts
  modified:
    - src/staff/replica/liveReplicator.ts
requirements: [MUS-09, POST-01]
requirements-completed: []
actuals:
  tokens: 24000
  tasks: 3
  commits: 1
completed: 2026-11-24
plan_head_before: ff95ad58
plan_head_after: f79ffc65
---

# Phase 33 Plan 09: The live replicator in full Summary

Every connection state can now be reached, and every state is left again by a timer, an action, the lead or an update. Each state has one plain word, one sentence, one action and an accessible name, written in your organization's words. The 33-01 public surface of `LiveReplicator` is unchanged. The new options are optional, the one new method is `updated()`, and `onJoinRequest` now also receives the invitation id.

## Measured loopback latency

On the real in-process hub, a change took **529 ms** from A's `localAppended()` to B holding it, under the 1000 ms bound. B was woken by the hub's heads frame.

## Finding to state, as built

| Finding | State | Notes |
|---|---|---|
| rolled-back, forked-view, wrong-project | attention | from syncOnce, as before |
| injected, corrupt-blob, withheld | attention | escalated from a synced exchange (`ESCALATING_FINDINGS`) |
| delayed, replayed | live | the finding stays listed in `status.findings` as a detail line |
| restoring (the server's answer) | offline, reason `restoring` | the retry follows the server's Retry-After, and the sentence is `RESTORING_TEXT` |
| needs-update (from the exchange, or a fold that stopped with `needs-update`) | needs-update | nothing is tried until `updated()` |
| session refused (revoked, not-admitted, quarantined) | refused, with the reason | |

Attention and refused look again every `LEAD_PROBE_MS` (60 s) with `lead-acted`. This is how the lead's `hub.readmit`, or a fresh admission, reaches a member, and it was tested: forked view, then the re-admission folds, then live.

## State words, as built (liveSentences.ts)

| State | Word | Action |
|---|---|---|
| single-machine | This computer only | share |
| connecting, authenticating | Connecting | show-details |
| catching-up | Catching up (the sentence names the changes left) | show-details |
| live | Synced | sync-now |
| offline | Offline (last synced HH:MM, or `RESTORING_TEXT`) | sync-now |
| refused | Not accepted (the reason, and who to ask, with `term('lead')`) | show-details |
| attention | Needs attention (the finding's sentence) | readmit, only for a lead device and only for rolled-back or forked-view; show-details otherwise |
| needs-update | Needs an update (`UPDATE_SENTENCE`) | update-extension |

`QUARANTINE_TEXT` is D-14's sentence, with the lead word from `term()` in the mode of the shared work. No sentence in the file calls shared work a project (D-69), and a test checks this. The copy-lint scanner finds no hit in the file, and that is asserted through the scanner itself.

## Deviations from Plan

1. **[Rule 1] Attention and refused now have a probe timer.** The machine has no timer for these states, and while in them the replicator holds no connection. So the roster frame the plan relied on ("a roster frame while refused or attention is lead-acted") can never arrive. A `LEAD_PROBE_MS` timer fires `lead-acted`. The machine table is unchanged.
2. **Network change (re-aim D-09).** `networkProbe` is optional and has no default. The session backend has no network-change event, so production code passes no probe. The test passes one.
3. **The resume gap** is checked by a `TICK_MS` (5 s) tick, which runs only while the replicator is started. `stop()` clears it, and the existing "stop leaves no timer" tests pass.
4. **Hub-side tests: 4, not 8.** The four cover the latency tracer, restore mode, needs-update and refused, all over the real hub. Join-request, quarantine, readmit, resume and network are covered on the manual clock in `staffLiveReplicator.test.ts`, with 15 tests. The fork through the fault proxy is covered by the existing malicious-hub suite and by the readmit tests of 33-08 and of this plan.
5. **The presence hook** (`onPresence`) receives the checked frame rebuilt as `{ project, cell, devices, left }`, so its 33-01 type is unchanged.

## Verification

All runs used the shared heavy lock, MemoryMax=6G and choom.

| Run | Result |
|-----|--------|
| Extension: staffLiveReplicator, staffLiveSentences, replicaSyncMachine, staffLiveTracer, architecture, copyLint and staffHubTransport, with 33-12's new files | 162 passed, 0 failed, 3 skipped (real-hub tracer tests without `NEAR_AI_HUB_NODE`) |
| Hub (Node 26.13.1): liveReplicator, clientSync, restoreDrill, noOutbound, maliciousHub, presence and restoreMode | 46 passed, 0 failed |
| `npx tsc --noEmit` | clean |

The copy-lint and architecture baselines are unchanged.

- **Tests added: 31.** `staffLiveReplicator.test.ts` has 15, `staffLiveSentences.test.ts` has 12, and the hub's `liveReplicator.test.ts` has 4.
- **Tests changed: 0.**

## Known Stubs

None. The native engine (33-24) constructs the replicator, passes `isLeadDevice`, and shows the sentences.

## Threat Flags

None beyond T-33-35 to T-33-39.

## Self-Check: PASSED

- The new files exist: hubLive.ts, liveSentences.ts, the two src tests, the hub test and liveClient.ts.
- The commit `f79ffc65` is in HEAD.
