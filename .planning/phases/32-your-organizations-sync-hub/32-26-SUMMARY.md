---
phase: 32-your-organizations-sync-hub
plan: 26
subsystem: hub tests (malicious-hub harness, restore drill); client hub sync; hub checkpointer
status: complete
tags: [hub, malicious-hub, fault-layer, restore-drill, withheld, rolled-back, forked-view, checkpoints, D-30, D-45, D-50, D-53, D-54, D-63, D-70, MUS-08]
requires: [32-16, 32-20, 32-21, 32-22, 32-23, 32-25]
provides:
  - "hub/test/helpers/faultProxy.ts: wrapHub, wrapHarnessHub, FaultPlan (refuse, hold, answer, frame), FaultLayer (set, clear, stats, restore), jsonAnswer, readAnswer, withJson, keptHub (folder, copy, restore, start, instance, cleanup), HubInstance"
  - "hub/test/maliciousHub.test.ts: 15 tests (the seed row and 14 fault rows, HUB_HARNESS_SEED, HUB_HARNESS_FAULTS_OFF)"
  - "hub/test/restoreDrill.test.ts: 3 tests (covers every client, ungranted cell, no hub key in the backup)"
  - "src/staff/replica/hubSync.ts: SyncLocal.missingDeps (optional); deps of held entries cited for withheld"
  - "src/staff/replica/replicaProject.ts: ReplicaProject.missingDeps; syncLocalOf passes it"
  - "hub/src/checkpoints.ts: an order-mismatch gap is checked again when an ask hands back more checkpoints"
affects: [32-28 (operator docs: restore procedure and its known limit), Phase 33 (live replicator, re-admitting a distrusted hub)]
tech-stack:
  added: []
  patterns:
    - "fault layer inside the hub process: the hub's request listener taken off its https server and wrapped, so TLS and the session binding stay real"
    - "the same hub (keys and certificate) started on a state folder and its cold copies for rollback, fork and restore"
    - "seeded table: row order and every random choice from sha256(seed/row) generators; the seed printed as a test diagnostic"
    - "faults-off switch (HUB_HARNESS_FAULTS_OFF=1) as the regression proof that each row exercises its fault"
key-files:
  created:
    - hub/test/helpers/faultProxy.ts
    - hub/test/maliciousHub.test.ts
    - hub/test/restoreDrill.test.ts
  modified:
    - src/staff/replica/hubSync.ts
    - src/staff/replica/replicaProject.ts
    - src/test/staffHubTransport.test.ts
    - hub/src/checkpoints.ts
decisions:
  - "The fault layer names the device of a request with the hub's own session check (sessions.authenticate), which only reads the request's token and socket, so a fault can be selective per device"
  - "Selective refusal answers A's appends 200 with every entry refused (reason rate-limited) instead of an error status: an error status ends the exchange before the delayed check, so the person would never be told; a refused batch is what a hub that quietly refuses one device looks like"
  - "Harmless rows (replay, reorder) compare the client's final set of entry hashes with an honest client of the same device on the same hub and world, because a second hub would have other hub keys and so other roster entry hashes"
  - "Wrong-project serves the second project's page as the hub would answer it for that project (its own project label); the transport's label check refuses it and the witness names wrong-project"
  - "Rolled-back is two rows: the base cell through the checkpoint (also checked directly: the hub's latest given to the witness A held is rolled-back) and an ungranted cell through the witness's heads alone (detail stream is the cell, no hand-back, kept newest unchanged)"
  - "The restore drill has B hold one more checkpoint than A (C2b over B's last report), so both clients see the rollback and both hand back; it asserts the checkpoint only B held, the hub's order gap after A and its healing after B, and recomputes C3 with every earlier checkpoint the hub keeps nested (C1, C2, C2b and the one only B held), not only C1 and C2"
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan had no checkpoint. The tracer row ran green before the rest of the table was added to the suite run."
metrics:
  duration: "about 120 minutes"
  completed: 2026-11-20
estimate:
  tokens: 75000
  tasks: 3
actuals:
  tokens: 24100
  tasks: 3
  commits: 3
plan_head_before: 8c1f2eb74a4158e4bc6ef54c064b21852be98762
plan_head_after: 042efd99ff43cb4e5e70965d9e4e09956fd601e9
---

# Phase 32 Plan 26: Malicious-hub harness and restore drill Summary

The real hub, wrapped by a fault layer inside its own process, is made to withhold, delay, replay, reorder, roll back, fork its view, inject, corrupt a blob, refuse one device's appends, serve another project's page and end catch-up early; every fault is named by the extension's own sync client or shown to change nothing, in a seeded order. An honest restore from an old backup is refused as a rollback, refilled by both clients, and followed by a checkpoint that covers everyone. Two real bugs were found and fixed on the way (one in the client, one in the hub), and one design limit is reported below.

## What was built

- **Fault layer (`faultProxy.ts`, D-53).** `wrapHub` removes the hub's `request` listener and installs one that passes each request on, with a plan that can answer instead of the hub (refuse), hold a request, buffer and rewrite or drop a JSON or blob answer, and drop event stream frames. It never changes hub source. `keptHub` keeps one hub's key lines and TLS pair and starts it (with a hand-moved scheduler) on a state folder or a cold copy of it.
- **Fault table (`maliciousHub.test.ts`, D-50, D-53, D-63).** 14 rows plus a seed row:

| Row | Fault | Expected and seen |
| --- | --- | --- |
| withheld (tracer) | catch-up drops one entry, heads still name it | withheld after 60 s; next entry never stored without it; honest retry stores both, no finding |
| withheld by a dep (ungranted cell) | C's log hidden from heads and catch-up, A's entry cites it | withheld after 60 s, detail names the cell and C; no checkpoint lists the cell |
| delayed (stripped) | checkpoints stripped from every answer and event, appends accepted | none at 4 min, delayed at 5 min; hub did sign; frames dropped; no checkpoint frame reached A |
| replayed | every entry twice plus the whole log again, shuffled | replayed counted; final set equals the honest client's |
| reorder | pages reversed, streams and writers in another order | no finding; final set equals the honest client's |
| rolled-back (base, checkpoint) | A moved to a second instance on an older copy | rolled-back (also directly from the checkpoint), C2 handed back, re-push until heads equal A's |
| rolled-back (ungranted, heads) | same, only the ungranted cell moved on | rolled-back with the cell as detail, no hand-back, kept newest unchanged, re-push |
| forked-view | two instances from one copy, A shown the other's checkpoint | forked-view; A keeps both; `checkpointConflict` gives equal-count-tip-mismatch; hub distrusted |
| injected | an entry for B's writer signed by another key | injected (bad-signature), not stored by A nor the hub |
| corrupt-blob | one byte flipped in a blob answer | corrupt-blob, not stored; honest retry stores it |
| delayed (selective refusal) | A's appends refused, B's taken | delayed after 5 min; the hub never stored A's entry |
| wrong-project | a second enrolled project's page under this project's path | wrong-project, attention, nothing ingested |
| more false | catch-up cut short with more false | withheld after 60 s; honest retry stores all |
| honest chain (control, D-70) | none: three checkpoints with a late concurrent entry | no forked-view or rolled-back; C3 recomputes nested and not without nesting |

  Every row also checks that no finding sentence or detail holds a 64-hex hash, a 40-character token-like run, a hub key line or any device public key.
- **Restore drill (`restoreDrill.test.ts`, D-30, D-54, D-63).** Base cell, a cell granted to the hub and an ungranted cell; backup after a clean stop; more work (C2 held by both, C2b by B only); restore; both clients name rolled-back, hand back and re-push; the hub signs nothing new until B has handed back; C3 verifies, lists exactly the base and granted cells, is at or above every client's heads there, recomputes with every earlier kept checkpoint nested, and no client report has forked-view. The ungranted-cell test shows the rollback named from the heads (detail is the cell), re-push, and the hub's GET heads for it equal both clients'. The backup and live state folder hold no byte of either key line, seed text, raw seed or its hex (with a planted-file check that the search has teeth).

## The question from the caller: does hubSync pass every earlier checkpoint to recomputeCheckpoint?

It does not recompute at all: `syncOnce` calls `witnessCheckpoint` without entries, so a new hub checkpoint is judged only by `checkpointConflict` without entries (equal counts with different tips) and the witness's head checks (same seq other hash, same heads other count, heads below). Nesting cannot cause a false forked-view there, and the honest chain control row confirms it over the real hub. The other side of that: a hub that reorders a prefix while changing the count is not caught by the client today; judging prefixes needs the opened entries, which `SyncLocal` does not expose (32-16 and 32-23 left this for when entries are available). Not changed here.

## Tests

| Suite | Result |
| --- | --- |
| hub unit suite (`npm test`, `NEAR_AI_HUB_OLD_NODE` set, under the cap) | 351 tests, 351 pass, 0 fail, 0 skipped (333 before this plan) |
| maliciousHub.test.js | 15 tests; seeds 12345, 931317859, 261029072, 659218627, 1294692698 and 773005963 all green |
| restoreDrill.test.js | 3 tests |
| staffHubTransport.test.js (extension) | 47 tests, 47 pass (46 before) |
| staffReplicaProject, replicaBoundaries, replicaHubWitness (extension) | 50 tests, 50 pass |
| `npm run lint` and `cd hub && npm run lint` | both exit 0 |

Acceptance greps: `removeAllListeners('request')|removeListener('request'` in faultProxy.ts 2; `HUB_HARNESS_SEED` in maliciousHub.test.ts 4. Test names contain withheld, delayed, replayed, reorder, rolled-back, forked-view, injected, corrupt-blob, wrong-project, more false, honest chain, covers every client and ungranted cell. No em-dash in any file written.

### Failing-first evidence

- **Faults switched off** (`HUB_HARNESS_FAULTS_OFF=1 HUB_HARNESS_SEED=12345`, final code): 15 tests, 2 pass, 13 fail. Every fault row fails (no finding raised, or for replay the replay count stays 0). On the first such run reorder still passed with its fault off (3 pass, 12 fail), so its "at least two pages reversed" check was made unconditional and it now fails too. The seed row and the honest chain control pass by design; the control's teeth are its own assertion that C3 does not recompute without the earlier checkpoints nested.
- **Client bug (withheld by a dep).** The harness row failed on the unchanged client (`AssertionError: []`, no withheld). The extension regression test first failed to build (`TS2339: Property 'missingDeps' does not exist on type 'ReplicaProject'`). After the fix, two mutations of the compiled code each fail that test alone (46 of 47 pass): M1 hubSync ignores `missingDeps`; M2 `syncLocalOf` does not pass it. Files compared byte for byte after restoring.
- **Hub bug (order gap after a restore).** restoreDrill.test.js with hub/src/checkpoints.ts from HEAD before the fix: 3 tests, 1 fail (`C3 was not signed`). With the fix 3 of 3, and checkpoints.test.js 18 of 18 (its three conflict tests unchanged and green: pair conflicts still stop for good, a lone order-mismatch with nothing more handed back still signs nothing and logs once).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The client never cited the deps of held entries for withheld (D-50, D-63)**
- **Found during:** Task 2, row "withheld by a dep in an ungranted cell".
- **Issue:** `syncOnce` cited only the hub's heads and the trusted checkpoint's heads. In a cell no checkpoint covers, a hub that leaves an entry out of its heads and its catch-up was never named, although a delivered entry's dep pointed at it.
- **Fix:** optional `SyncLocal.missingDeps()`; `syncOnce` adds its citations; `ReplicaProject.missingDeps()` opens only entries the chain stage holds for a missing predecessor (bodies only, not blobs) and `syncLocalOf` passes it. Regression test in `src/test/staffHubTransport.test.ts` (and `memberWrite` there takes `deps`).
- **Files modified:** src/staff/replica/hubSync.ts, src/staff/replica/replicaProject.ts, src/test/staffHubTransport.test.ts
- **Commit:** 1ef2d291

**2. [Rule 1 - Bug] A restored hub stopped signing for good when a checkpoint only one client held came back late (D-54, D-70)**
- **Found during:** Task 3.
- **Issue:** the hub signs a checkpoint on an ask, but the ask's answer carries the one before it, so the asking client may never see it; another client may. Later checkpoints nest after it. After a restore, the first client to hand back gave C2 without that intermediate one, `validateChain` named order-mismatch, and the project was stopped for the life of the process, although the second client's hand-back a moment later supplied the missing checkpoint.
- **Fix:** order-mismatch still logs `checkpoint.conflict` and signs nothing, but an ask that hands back more checkpoints (a longer kept chain) checks again; signing resumes once the chain reproduces. Pair conflicts (not-nested, equal-count-tip-mismatch) still stop for good.
- **Files modified:** hub/src/checkpoints.ts
- **Commit:** 042efd99

**3. [Plan detail] Restore drill sequence**
- The plan has both clients hold C2 and B hand back as well. Because a client pushes every entry the hub lacks (other writers' too), A alone would refill everything C2 covers and B would see no rollback. B therefore writes once more after C2 (C2b), so both clients see the rollback and both hand back. C3 is recomputed with every earlier checkpoint the hub keeps.

Files outside the plan's `files_modified`: src/staff/replica/hubSync.ts, src/staff/replica/replicaProject.ts, src/test/staffHubTransport.test.ts, hub/src/checkpoints.ts (all above).

## Known limit found (design, not fixed: needs an owner decision)

An honest restore followed by new work before every client has handed back turns into a permanent forked-view for the client that held the lost checkpoint. Probe (run, then removed): backup; B writes twice more, the hub signs C2 and C2b (B holds C2b, A holds C2); restore; A re-pushes, writes once more, and the restored hub signs C3' over C2 plus A's entry. C2b and C3' are both signed by the hub's key and cover the same number of base cell entries with different order tips, so B's sync names rolled-back and forked-view, stops before handing back or re-pushing, distrusts the hub, and B's last entry never reaches it. An honest restore and a real fork are the same evidence to B. Options for the owner: a restore mode in which the operator starts the restored hub so that it signs nothing until the lead confirms every device has synced (32-28 operator docs could carry the procedure); or the lead re-admits the hub (Phase 33) with a fresh witness on every device. A related gap: a checkpoint that no client ever received and that later checkpoints nest after cannot be handed back at all, and the hub then signs nothing for that project (the fix above heals only when some client holds it). Clients receiving the checkpoints a newer one nests after (for example with the ask answer) would close it.

## Known Stubs

None. `missingDeps`, `wantedBlobs` and `blobsCitedBy` in maliciousHub.test.ts open bodies with the world's keys as a device's real replica does; they are test code.

## Threat Flags

None beyond the plan's register: no new endpoint or file access in product code. The new client read (`missingDeps`) opens only bodies this device already holds keys for, and its citations carry ids the witness cuts to 12 characters. T-32-106 (injected, wrong-project, replay and reorder rows), T-32-107 (forked-view row keeps both checkpoints), T-32-108 (withheld and delayed rows, named never silent) and T-32-109 (restore drill) are covered. No package was installed (T-32-SC).

## Self-Check: PASSED

- FOUND: hub/test/helpers/faultProxy.ts, hub/test/maliciousHub.test.ts, hub/test/restoreDrill.test.ts, src/staff/replica/hubSync.ts, src/staff/replica/replicaProject.ts, src/test/staffHubTransport.test.ts, hub/src/checkpoints.ts
- FOUND commits: 1ef2d291, a03b4d46, 042efd99 (ancestors of HEAD on feat/phase-32-26-malicious-hub-restore)
