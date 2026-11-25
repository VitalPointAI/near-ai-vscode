---
phase: 33-live-multi-user-staff-projects
plan: 07
status: complete
subsystem: hub rules for required features, per-entry blob-missing and restore mode
tags: [hub, post-01, d-07, d-28, d-32, d-45, restore]
requires: [33-03, 33-18]
provides: [APPEND_REFUSALS needs-update, APPEND_REFUSALS restoring, APPEND_STATUS 403 and 503, SESSION_REFUSALS needs-update, per-entry blob-missing, RESTORE_MARKER, RestoreMode, RESTORE_LOG_EVENTS, LIMITS.restoreRetrySeconds, HubStore.projectIds, composeHub stateDir]
affects: [33-08, 33-09, 33-14, 33-15]
tech-stack:
  added: []
  patterns: [batch refusal for a fault the hub can prove, per-entry refusal with the head left unmoved, marker file read once at start and looked at again on a bound]
key-files:
  created:
    - hub/src/restore.ts
    - hub/test/require.test.ts
    - hub/test/blobMissingPerEntry.test.ts
    - hub/test/restoreMode.test.ts
  modified:
    - hub/src/append/checks.ts
    - hub/src/http/routes.ts
    - hub/src/http/session.ts
    - hub/src/limits.ts
    - hub/src/main.ts
    - hub/src/store/hubStore.ts
    - hub/test/api.test.ts
    - hub/test/append.test.ts
    - hub/test/helpers/hubHarness.ts
    - hub/test/restoreDrill.test.ts
    - relay/README.md
    - src/staff/replica/hubTransport.ts
    - src/test/staffHubTransport.test.ts
requirements: [POST-01, MUS-09]
requirements-completed: []
actuals:
  tokens: 26000
  tasks: 3
  commits: 1
completed: 2026-11-24
plan_head_before: dea4529e
plan_head_after: 91c99591
---

# Phase 33 Plan 07: Hub rules Summary

Your organization's server now obeys `roster.require` for appends and sessions. It answers a missing blob for that one entry, not the whole batch. A hub restored by the procedure starts in restore mode, so an honest restore no longer looks like a fork.

## Wire contract as built (shared with 33-08)

| Answer | Status | Body |
|---|---|---|
| The hub lacks a required feature | 403 | `{ error: 'needs-update', message }`. Nothing is stored. The message is "This shared work needs a newer version of your organization's server. Ask its operator to update it." |
| Restore mode, an append outside checkpoint coverage | 503 with `Retry-After: 30` | `{ error: 'restoring', message, retryAfterSeconds: 30 }` |
| A session whose features do not cover the project | **403** (see deviation 2) | `{ error: 'session-refused', reason: 'needs-update', message: UPDATE_SENTENCE }` |
| An entry whose named blob, or base-stream body blob, the hub lacks | 200 | The refusal list holds `{ index, hash, reason: 'blob-missing', message }`. The writer's later entries in the batch get `seq-gap`, and the rest are stored. The batch-level 409 is gone. |

`coversRequired` needs the feature both announced and known to the hub. So a hub that lacks a feature refuses every new session for that project. Sessions opened before the requirement arrived can still read.

## Restore-mode rule as built (A6, for the owner)

- **Marker.** The file `restore-mode` in the state directory, read once at start through `composeHub({ stateDir })`. A link is not a marker.
- **Accepted in restore mode.** A batch is accepted only when every entry is already held, or sits at a place covered by a checkpoint the hub kept or was handed back. This is the WR-02 `coveredBefore` rule, checked against `checkpoint_cover`. Any other batch gets 503 `restoring`.
- **How it ends.**
  - Every admitted person device of every project the hub holds has made one checkpoint ask since the start. Hubs and revoked devices are not counted. The hub then removes the marker and logs `hub.restore-ended` with reason `members-synced`.
  - Or the operator removes the marker. The hub looks again at most every `LIMITS.restoreRetrySeconds` (30) and then logs reason `marker-removed`.
- **Logs.** The two log lines carry only `reason` or `retryAfterSeconds`.
- **README.** `relay/README.md` writes the marker in step 3 of the restore procedure and says the hub leaves the mode by itself. The drill steps and the log table name the two events.

## Deviations from Plan

1. **[Rule 3] One code commit for the three tasks.** All three tasks change the same checks in `checks.ts` and `routes.ts`, so they landed as one commit (`91c99591`). The tests are split by task: `require.test.ts`, `blobMissingPerEntry.test.ts`, and `restoreMode.test.ts` plus the drill.
2. **[Rule 1] The session refusal stays 403, not the plan's 401.** Every hub session refusal is 403 `session-refused`, and `HubTransport` maps 403 `session-refused` to its `session-refused` failure. A 401 would have been read as an authentication refusal and lost the reason.
3. **[Rule 3] The client side of per-entry blob-missing came into this plan.** Without it, `HubTransport.append` no longer uploaded blobs, and the hub suite's client tests (noOutbound, clientSync and the drills) would have broken between 33-07 and 33-08. `append` now treats a per-entry `blob-missing` in a 200 like the old 409: it puts the batch's blobs and sends the batch once more. Entries already stored come back held, so the second answer is the whole answer. The Phase 32 409 path is kept.
4. **[Rule 3] Two small additions outside the file list.**
   - `HubStore.projectIds()`, a read-only SQL query that restore mode needs to know every project.
   - `hubHarness.ts` passes `stateDir` and collects `restoreLogs`, so the in-process hub runs restore mode as the binary does. Its `openSession` now announces `KNOWN_REPLICA_FEATURES`, as a current client does.
5. **The heads read in restore mode.** A member whose push meets `restoring` must still ask for a checkpoint, or the mode cannot end. That is the client's job and is done in 33-08: `syncOnce` asks once after a `restoring` answer.
6. **Two existing tests were changed for the new answer, without weakening them.** In `append.test.ts` and `api.test.ts` the blob-missing test now asserts the per-entry refusal and that nothing was stored, where it asserted the batch-level 409. Each test's message names Phase 33 D-28.

## Verification

All runs used the shared heavy lock, MemoryMax=6G and choom, with Node 26.13.1 for the hub.

| Run | Result |
|-----|--------|
| Focused hub run (require, blobMissingPerEntry, restoreMode, append, api, session, restoreDrill, clientSync, noOutbound) | 121 passed, 0 failed |
| **Full hub suite (`npm test`) on the committed state** | **418 passed, 0 failed, 3 skipped** |
| `npm run lint` in hub/ | exit 0 |
| Extension: staffHubTransport, hubIsolation and relayIsolation | 71 passed, 0 failed |

The 3 skipped hub tests are the existing older-Node refusal checks, which need `NEAR_AI_HUB_OLD_NODE`. The full hub suite also covers 33-03: the hub's roster cache folds `roster.require` and `hub.readmit`.

- **Tests added: 18.**
  - `require.test.ts`: 6.
  - `blobMissingPerEntry.test.ts`: 4.
  - `restoreMode.test.ts`: 6.
  - `restoreDrill.test.ts`: 1, "restore drill with the marker ... no forked-view finding on either member".
  - `staffHubTransport.test.ts`: 1 (per-entry blob-missing).
- **Tests changed: 2**, the batch-level blob-missing tests described above.

## Known Stubs

None.

## Threat Flags

None beyond T-33-26 to T-33-30. The hub gained no new route. The restore marker is read from the hub's own private state directory, and the hub removes only that one file.

## Self-Check: PASSED

- The new files exist: `hub/src/restore.ts`, `hub/test/require.test.ts`, `hub/test/blobMissingPerEntry.test.ts` and `hub/test/restoreMode.test.ts`.
- The commit `91c99591` is in HEAD.
