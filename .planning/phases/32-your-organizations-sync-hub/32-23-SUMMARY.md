---
phase: 32-your-organizations-sync-hub
plan: 23
subsystem: staff replica (client side of the sync hub)
status: complete
tags: [sync-hub, client, transport, tls-pin, session, sse, one-shot-sync, witness, rollback, hand-back, MUS-07, MUS-08]
requires: [32-07, 32-15, 32-16, 32-19, 32-20, 32-21]
provides:
  - "src/staff/replica/hubTransport.ts: HubTransport (ReplicaTransport kind hub, live, enforcesAppend; hubHeads, entries, append, putBlob, getBlob, grant, askCheckpoint, enrol, events, subscribe, pull, push, close), HubTransportError, HUB_TRANSPORT_FAILURES, HubTrust, appendBatches, parseHubAddress, CONNECT_TIMEOUT_MS, RESPONSE_MAX_BYTES, EVENT_FRAME_MAX_BYTES, HUB_EVENT_NAMES, EventReport, EventReader"
  - "src/staff/replica/hubSync.ts: SyncLocal, HubMemory, hubMemoryOf, hubWitnessKey, HUB_WITNESS_SECRET_PREFIX, syncOnce, SyncReport, SyncOutcome, SyncTransport"
  - "src/staff/replica/replicaProject.ts: heads, head, holds, entriesAfter, blob, wantedBlobs, blobsCitedBy, signedGrants, putCheckpoint, checkpoints, hubCells; syncLocalOf(project)"
  - "src/test/helpers/fakeHubServer.ts: FakeHubServer (scripted hub with the session protocol and a per-connection request log), fakeHubState, seedHub, seedGrants, hubRoutes"
  - "hub/test/helpers/memoryReplica.ts: memoryReplica(world, device) (a SyncLocal from hub-side modules only), MemorySecrets"
affects: [32-24, 32-25, 32-26, 32-27, Phase 33]
tech-stack:
  added: []
  patterns:
    - "one pre-checked TLS socket per connection, handed to an https.Agent that never makes another, so a request can only go where the pin was checked"
    - "the session token lives on the connection object it was issued on; a new connection always opens a new session first"
    - "byte cap and declared-length check before any JSON.parse; every answer's project, stream and writer compared with what was asked"
    - "pull per writer page by page from the stored head: sort, verify against the roster, check prev, ingest, re-read the head (delivered is not stored)"
    - "push in passes: refusals that depend on order (not-admitted, seq-gap, prev-mismatch and the like) are sent again while a pass still lands something"
key-files:
  created:
    - src/staff/replica/hubTransport.ts
    - src/staff/replica/hubSync.ts
    - src/test/staffHubTransport.test.ts
    - src/test/helpers/fakeHubServer.ts
    - hub/test/clientSync.test.ts
    - hub/test/helpers/memoryReplica.ts
  modified:
    - src/staff/replica/replicaProject.ts
decisions:
  - "syncLocalOf lives in replicaProject.ts, not hubSync.ts: the hub workspace test (32-14) follows type-only imports when it checks an @ext closure, and replicaProject.ts reaches Yjs through the fold, so hubSync.ts imports nothing from replicaProject.ts (neither a value nor a type)."
  - "Session refusals follow the wire 32-20 built: 403 session-refused with a reason, and 401 revoked or quarantined on a call; both end the exchange refused with the hub's reason id. 401 token-expired, unknown-token, other-connection and no-token get one new session on the same connection and one more try."
  - "Trust is a closed choice {pin} or {ca}. In pin mode no CA is given to TLS at all; in CA mode only your organization's CA. The trust check runs on secureConnect (pin from getPeerX509Certificate through certPinOf; in CA mode socket.authorized, which in Node already includes the host name check, and tls.checkServerIdentity again) before any request byte."
  - "The challenge must name the hub's writer id the project admitted, else wrong-hub (attention) and no answer is sent."
  - "A call that fails on a reused connection (the hub closed it while idle, 5 s) is tried once more on a new connection with a new session; a call on a fresh connection is not retried."
  - "append answers 409 blob-missing by putting every blob its blobRefs name that this computer holds (a lookup, so blobs are read only when the hub asks) and sending the batch once more. Batches stay within 200 entries, 64 grants and about 3 MiB, grants first."
  - "Outcome map: unreachable and rate-limited (with retryAfterSeconds) are offline; session-refused is refused; pin-mismatch, ca-refused, wrong-hub, wrong-project, too-large, malformed and any other hub error are attention; a rolled-back, forked-view or wrong-project finding turns a finished exchange into attention."
  - "A rolled-back hub (heads below the seen marks, or a checkpoint below the kept newest) is not pulled from; every entry and grant it lacks is pushed back (repushed: true) and newer held hub checkpoints are handed back first. A forked-view or a wrong-project answer stops the exchange where it was found."
  - "The heads of entries the hub accepted from this computer raise the witness seen marks, so a hub that later shows a copy without them is rolled-back even before 32-22 signs checkpoints."
  - "Hand-back runs when the kept newest checkpoint covers more than the hub's latest (or the hub showed a rollback): the held checkpoints that verify for this roster, are signed by this hub and cover more than the hub's latest, at most 16, most-covering first."
  - "Withheld uses the hub's heads (and the trusted checkpoint's heads) that this computer still does not hold as citations; a gap or a prev that does not follow the stored head stops that writer, so the hub's head waits and becomes withheld after WITHHELD_GRACE_MS."
  - "A writer the roster does not know is pulled only after the roster is folded again (a new member's admission arrives in the same exchange); one still unknown at the end is named injected (unknown-writer) and nothing from it is fetched."
  - "Findings are reported one per kind: the witness's own count for withheld, delayed and rolled-back, otherwise how many times the kind was seen in the exchange."
  - "The witness state is kept under nearAi.staff.hubWitness.<sha256(project, hub writer)>; a saved state that does not read back for this hub and project (another hub, another project, damaged) is replaced by a fresh witness."
metrics:
  duration: "about 65 min"
  completed: 2026-11-20
estimate:
  tokens: 90000
  tasks: 3
actuals:
  tokens: 47300
  tasks: 3
  commits: 3
plan_head_before: 1d470ad91ea2c9a3a93b19a174595e83e4d99c34
plan_head_after: d6e2591bd9a9c761db9235bd3ac722ac9d324a43
---

# Phase 32 Plan 23: Client hub transport and one-shot sync Summary

A computer can now sync a staff project with your organization's hub in one call over a TLS 1.3 connection it trusts only by the hub's pin (or your organization's CA), with a session bound to that very connection; the exchange verifies everything it receives, pushes back exactly what the hub lacks, and names plainly when the hub withholds, rolls back, forks, injects, corrupts, replays or answers for another project.

## What was built

- **Transport (`hubTransport.ts`).** One pinned TLS 1.3 socket per connection, checked on secureConnect before any byte is written (pin-mismatch or ca-refused closes it), then handed to an https.Agent with keepAlive and maxSockets 1 that never makes another socket. Each connection opens its own session (`POST /v1/session {project}`, then the answer from `buildSessionAnswer` over the hub's writer id, the project, the challenge and `exportKeyingMaterial(32, 'near-ai-hub-session/v1')` of that connection). Calls: heads, entries (one page, project, stream and writer checked), append (409 blob-missing puts the blobs and retries once), blob put and get (sha256 checked, `x-near-ai-project` checked), grants by hash through the blob route checked with `readGrant`, the checkpoint ask `{known}`, enrol without a session on a connection of its own, and the event reader on a connection and session of its own (frames in order, comments ignored, `retry` read, id gaps reported, 204 stopped, resync and end reported for catch-up, a frame for another project refused, a 1 MiB frame cap). `pull`, `push` and `subscribe` implement `ReplicaTransport`. Every answer is read with a byte cap (4 MiB plus 256 KiB; 8 MiB for blobs) before it is parsed.
- **One-shot sync (`hubSync.ts`).** `syncOnce(transport, local, memory)` runs heads (witnessResponse, witnessHeads, witnessCheckpoint), fetches grants the hub lists that this computer lacks, hands back newer hub checkpoints when the hub's latest is older than the kept newest, pulls per writer page by page (sorted, verified against the roster, prev checked against the stored head, ingested through the decode check, the head read back), cites the hub's heads for withheld, fetches blobs waiting entries need (witnessBlob), pushes every entry and grant the hub lacks with the blobs they cite, runs witnessOwn and a checkpoint ask, and saves the witness state. It ends in one of synced, offline, refused or attention with the findings and their sentences.
- **ReplicaProject read access.** heads, head, holds, entriesAfter, blob, wantedBlobs, blobsCitedBy (a body's blob and a compaction's state blob), signedGrants, putCheckpoint, checkpoints and hubCells, each inside `exclusive()`, and `syncLocalOf(project)`.
- **Test helpers.** A scripted hub (`fakeHubServer.ts`) with the real session protocol and an honest-by-default state with fault knobs; an in-memory replica for the hub workspace (`memoryReplica.ts`) built from hub-side modules only.

## Tests

| Suite | Result |
| --- | --- |
| staffHubTransport.test.js | 46 tests, 46 pass (26 transport, 20 sync) |
| staffHubTransport.test.js with staffReplicaProject.test.js | 61 tests, 61 pass |
| hub unit suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set, under the cap) | 290 tests, 290 pass, 0 skipped (288 before Task 3, 287 before this plan) |
| clientSync.test.js | 3 tests, 3 pass |
| `npm run lint` and `cd hub && npm run lint` | both exit 0 |

Acceptance greps: `exportKeyingMaterial` in hubTransport.ts 2 (at least 1); `getPeerX509Certificate` in hubTransport.ts 1; test names contain pin-mismatch, new session, wrong-project, 204, resync, injected, replayed, corrupt-blob, rolled-back, forked-view and re-push. `^import \{[^}]*ReplicaProject` in hubSync.ts is 0 as required; `^import type \{[^}]*ReplicaProject` is 0, not the planned 1 (see Deviations).

### Failing-first evidence

- **Task 1 (tracer):** the tracer and memoryReplica.ts built with the two new client modules moved aside: `ERR_MODULE_NOT_FOUND: Cannot find package '@ext/staff'`, tests 1, fail 1. With them: 1 of 1 pass, then the hub suite 288 of 288 (tracer gate: the `<verify>` ran end to end before Tasks 2 and 3).
- **Task 2 (D-66, stated mutations on the compiled transport, each alone, restored byte for byte):** T1 pin not compared: pin-mismatch fails. T2b CA chain not checked: the CA refusal test fails. T3 no streamed byte cap: too-large fails. T4 no blob-missing retry: the append test fails. T5b no second try on a dropped reused connection: that test fails. T6 project label not checked: wrong-project fails. T7 204 not a stop: the 204 test fails. T8 resync not reported: the resync test fails. Two mutations survived and are equivalent: T2 (dropping the explicit host name check, because Node's `socket.authorized` already includes it) and T5 (reusing a closed connection, because the retry path then opens the new connection and session anyway; T5b shows that path's teeth).
- **Task 3:** the sync tests compiled against the unchanged replicaProject.ts fail to build with 39 errors (TS2305 no exported member `syncLocalOf`; TS2339 for heads, head, holds, entriesAfter, blob, wantedBlobs, blobsCitedBy, signedGrants, putCheckpoint, checkpoints). Stated mutations on the compiled sync: S1 headers not verified: injected fails. S2 pages not sorted: the reverse-order test fails. S3 held entries not counted: replayed fails. S4 blob not witnessed: corrupt-blob fails. S5 accepted heads do not raise the marks: rolled-back heads fails. S6 no hand-back: hand-back and rolled-back (checkpoint) fail. S7 no push after a rollback: both re-push tests fail. S8 a fork does not stop the exchange: forked-view fails. S9 saved witness ignored: 6 tests fail. S10 prev not checked: the out-of-order test fails.
- Corrected on first run for test or helper reasons: `exportKeyingMaterial` needs its third argument under the hub's Node types (written as the hub's server.ts does); the event reader's close callback read its own variable before it existed on a 204 answer (now a holder); the grant test hashed `JSON.stringify` instead of the canonical bytes the hub serves; the restartable hub's state folder had to exist before `openHubStore`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] syncLocalOf in replicaProject.ts; no `import type ReplicaProject` in hubSync.ts**
- **Found during:** Task 1 design, checked with the closure helper before writing.
- **Issue:** the plan expects hubSync.ts to import `ReplicaProject` as a type only so the hub tests bundle without Yjs. The hub workspace test (`every @ext import under hub/test names a file whose own closure has no editor API, no Yjs ...`) follows type-only imports too, and replicaProject.ts reaches `domain/replica/doc.ts` (Yjs) through the fold, so that import would fail the hub suite.
- **Fix:** hubSync.ts defines `SyncLocal` and imports nothing from replicaProject.ts; `syncLocalOf(project)` is exported from replicaProject.ts, which imports `SyncLocal` as a type. The acceptance grep for `import type ... ReplicaProject` in hubSync.ts is therefore 0, not 1; the value-import grep is 0 as required. hubSync.ts and hubTransport.ts closures were checked clean (36 and 22 files, no problems).
- **Commits:** 441f547e, d6e2591b

**2. [Plan detail] Session refusal status**
- The plan says "a 401 session-refused answer"; 32-20 settled it as 403 `session-refused` (D-69). The transport follows the wire and the test uses 403; 401 revoked or quarantined on a call also ends refused.

**3. [Plan detail] forked-view and "the kept newest is unchanged"**
- 32-16's witness drops `newest` on a fork and keeps it as `proof.a` (its state invariant). The test asserts both checkpoints are stored on this computer and `proof.a` is the previously kept newest; after a rollback the kept newest is asserted unchanged.

**4. [Rule 2 - Correctness] Additions beyond the plan's list, each tested**
- wrong-hub (a challenge naming another hub sends no answer), a second try on a reused connection the hub dropped, a new session on the same connection for a mended 401, push in passes for order-dependent refusals, unknown writers pulled after the roster refolds, and a validly signed entry whose prev does not follow the stored head left unstored (its own test).

Files outside the plan's `files_modified`: none.

## Decisions

The owner accepted the 32-CONTEXT defaults; the plan had no checkpoint. Decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- **32-22 (hub checkpoint signing) must make these pass over the real hub:** sign with the key whose writer the roster admitted with `hub.admit`, at a roster head at or after that admission (`checkpointSigner`); attach the latest to heads, entries, append and the checkpoint ask; never let a later checkpoint drop a writer or stream an earlier one covered (the witness reads that as rolled-back); and after a hand-back, a checkpoint at the same count as a handed-back one must carry the same order tip (nest it), or clients name forked-view. The client sends `{known: []}` at the end of every exchange, so signing on the ask's channel makes a fresh checkpoint reach the client one exchange later at most. The extension tests sign checkpoints with a test hub key the roster admits; clientSync.test.ts runs with no checkpoints today and must stay green once heads carry them.
- **32-25 (join through the hub):** `HubTransport.enrol` posts without a session; a join call can follow the same pattern (a connection of its own, closed after).
- **32-26 (harness):** every fault knob of D-53 maps onto the scripted hub's state (`reversePages`, `skipSeq`, `extra`, `corruptBlobs`, `wrongProjectHeads`, `headsOverride`, `checkpoint`, `askAnswer`); `syncOnce` returns the findings one per kind. `memoryReplica` gives the harness Yjs-free clients.
- **Phase 33:** `SyncReport.outcome`, `reason`, `message` and `retryAfterSeconds` drive the sync status; `HubTransport.events()` and `subscribe` feed the live replicator; a forked hub stays distrusted until a fresh witness after the lead re-admits it.

## Known Stubs

- `memoryReplica.wantedBlobs()` and `blobsCitedBy()` return nothing: the in-memory replica in the hub's tests does not open bodies. The real `ReplicaProject` implements both, and both are tested there. This is a test helper, not product code.

## Threat Flags

None beyond the plan's register. The new outbound surface is the client side of 32-20 and 32-21's routes, covered by T-32-90 to T-32-95 as planned: pin or CA checked before any write (pin-mismatch, ca-refused tests), a session per connection with the token kept on that connection (new session tests), header verification, prev check and project and stream checks before anything is stored (injected, out-of-order, wrong-project tests), the witness state per hub with rollback, fork, re-push and hand-back (their tests), byte caps and the 10 second connect limit (too-large, unreachable tests), and a search of the saved witness state and every finding for keys, tokens and full hashes. No package was installed (T-32-SC).

## Self-Check: PASSED

- FOUND: src/staff/replica/hubTransport.ts, src/staff/replica/hubSync.ts, src/test/staffHubTransport.test.ts, src/test/helpers/fakeHubServer.ts, hub/test/clientSync.test.ts, hub/test/helpers/memoryReplica.ts, src/staff/replica/replicaProject.ts
- FOUND commits: 441f547e, e6cfbcbe, d6e2591b (ancestors of HEAD on feat/phase-32-23-client-transport-sync)
