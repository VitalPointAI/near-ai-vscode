---
phase: 33-live-multi-user-staff-projects
plan: 08
status: complete
subsystem: client side of the wave 3 wire
tags: [staff, replica, hub, post-01, presence, restore, readmit, late-joiner]
requires: [33-03, 33-07, 33-18]
provides: [HubTransportOptions.features, HubTransport.postPresence, HubTransport.leavePresence, PRESENCE_BODY_MAX_BYTES, SyncOutcome needs-update, RESTORING_SENTENCE, RETRY_REFUSALS blob-missing, the readmit step, the distrusted roster read, SyncOptions.startFromBase]
affects: [33-09, 33-12, 33-14, 33-22, 33-24]
tech-stack:
  added: []
  patterns: [one transport for every call, plain outcome per answer, read roster changes even from a distrusted server]
key-files:
  created:
    - src/test/staffHubSyncLive.test.ts
  modified:
    - src/staff/replica/hubTransport.ts
    - src/staff/replica/hubSync.ts
    - src/test/helpers/fakeHubServer.ts
    - src/test/staffHubTransport.test.ts
requirements: [POST-01, MUS-09]
requirements-completed: []
actuals:
  tokens: 21000
  tasks: 3
  commits: 1
completed: 2026-11-24
plan_head_before: 714be388
plan_head_after: f4fbe724
---

# Phase 33 Plan 08: Client side of the wave 3 wire Summary

The client now speaks the wave 3 wire exactly as the hub does. Every session answer announces this build's features. Presence travels on the same pinned connection as every other call. `restoring`, `needs-update` and a per-entry `blob-missing` each end in a plain outcome. The lead's `hub.readmit` clears a distrusted server on every member's computer. A late joiner can start each writer's log at a trusted checkpoint head.

## Outcome mapping as built

| Hub answer | `syncOnce` outcome | reason | message |
|---|---|---|---|
| 503 `restoring` (append) | `offline` | `restoring` | `RESTORING_SENTENCE`: "Your organization's server is being restored. Your changes are kept here.", with `retryAfterSeconds` from Retry-After. The checkpoint ask still goes. |
| 403 `needs-update` (append, hub-error) | `needs-update` | `needs-update` | `UPDATE_SENTENCE` |
| 403 `session-refused` with reason `needs-update` | `needs-update` | `needs-update` | `UPDATE_SENTENCE` |
| 403 `session-refused` with any other reason | `refused` (as before) | the reason | |
| 200 with an entry refused `blob-missing` | The transport puts the batch's blobs and sends the batch once more (33-07). `blob-missing` is also a retry reason on the next push pass. | | |
| Any other `hub-error` | `attention` (as before) | | |

## hubTransport.ts

It went from 1111 lines to 1147, under the 1200 limit. The changes:
- `features` option, which defaults to `KNOWN_REPLICA_FEATURES`.
- `postPresence(cell, sealed)` and `leavePresence(cell)`. A body over the hub's 2 KiB presence limit is refused before it is sent. A 403 is `hub-error` with reason `not-on-access-list`.
- A 503 `restoring` answer is `hub-error` with reason `restoring` and the Retry-After time.

## Deviations from Plan

1. **[Rule 1, D-42] A distrusted server's roster changes are still read.** In the plan's design the lead's `hub.readmit` could never reach a member whose witness distrusts the hub. The exchange stopped at the forked-view check, before any pull. Now, when the witness is distrusted, `syncOnce` pulls the base stream first. Every change in it is still checked against the roster's signatures, and the server cannot forge one. It then refolds the roster and applies `readmitWitness` before the checkpoint check. If no re-admission is there, the exchange stops on forked-view as before. A test covers it: the re-admission arrives through the distrusted server and clears the mark in the same exchange.
2. **[Rule 2, D-32] The checkpoint ask still goes after a `restoring` answer.** Restore mode ends only when every person device has asked since the restart (33-07). A member whose push met `restoring` would otherwise never ask, so the mode could never end on its own.
3. **The late-joiner test with real text equality is left to 33-14.** That is the real-hub late-joiner scenario, which 33-06's summary already gives to 33-14. This plan tests `startFromBase` on the exchange itself:
   - the pull starts at seq 61 for a base at 60;
   - the checkpoint is kept first;
   - a log that does not run through the base head is not taken;
   - with no checkpoint, an unverified one, or the option off, the pull starts at 0.
4. **The fake server's presence route.** The scripted fake answers the presence route the way the 33-07 hub does: 200 with `{ project, cell }`, and 403 for a cell the device is not on the access list of.

## Verification

All runs used the shared heavy lock, MemoryMax=6G and choom. `npx tsc -p tsconfig.json` was clean.

| Run | Result |
|-----|--------|
| staffHubSyncLive, staffHubTransport, replicaHubWitness, replicaCheckpointHeads, replicaBoundaries, architecture and copyLint (with the staffLiveTracer and staffLiveSentences files in the same run) | Every staffHubSyncLive test passed. One new presence test failed: it did not wait for the client to see the close, so the file hung and the run was stopped. Fixed with the same 50 ms wait the existing new-session test uses. |
| Re-run of staffHubTransport, architecture and copyLint with the wave 4 files | 162 passed, 0 failed, 3 skipped (the real-hub tracer tests, which need `NEAR_AI_HUB_NODE`) |
| Hub clientSync, restoreDrill, noOutbound, maliciousHub, presence, liveReplicator and restoreMode on Node 26.13.1, with this plan's hubSync | 46 passed, 0 failed |
| `npx tsc -p tsconfig.json --noEmit` | clean |

- **Tests added: 19.**
  - staffHubTransport gained 6: features 2, presence 3 and restoring 1. Its per-entry blob-missing test is counted in 33-07.
  - staffHubSyncLive.test.ts is new with 13: restoring 2, needs-update 2, blob-missing 1, other errors 1, readmit 4 (one of them the distrusted roster read) and startFromBase 3.
- **Tests changed: 0.**

## Known Stubs

None. The native engine (33-24) passes `startFromBase` for a joining device.

## Threat Flags

None beyond T-33-31 to T-33-34. The distrusted-server read takes only signed changes in the base stream, each checked like any other pull.

## Self-Check: PASSED

- `src/test/staffHubSyncLive.test.ts` exists.
- The commit `f4fbe724` is in HEAD.
- `hubTransport.ts` has 1147 lines.
