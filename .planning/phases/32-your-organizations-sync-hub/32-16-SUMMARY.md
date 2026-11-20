---
phase: 32-your-organizations-sync-hub
plan: 16
subsystem: staff replica (hub witness: malicious-hub findings on the client)
status: complete
tags: [replica, hub, witness, checkpoint, rollback, fork, withheld, delayed, D-46, D-50, D-52, D-63, D-70, MUS-08]
requires: [32-01, 32-02, 32-03, 32-04, 32-05, 32-06, 32-07, 32-08, 32-09, 32-10, 32-11, 32-12, 32-13]
provides:
  - "src/domain/replica/hubWitness.ts: HUB_FINDINGS, HubFinding, WitnessState, createWitness, witnessCheckpoint, witnessHeads, witnessResponse, witnessEntry, witnessBlob, witnessCitations, witnessOwn, findingSentence, serializeWitness, readWitness, WITHHELD_GRACE_MS, DELAYED_AFTER_MS (plus WITNESS_MAX_BYTES, WITNESS_REFUSALS, WITNESS_PROOF_REASONS, MAX_SEEN_HEADS, MAX_WAITING, MAX_OWN_WAITS)"
  - "src/test/replicaHubWitness.test.ts: 28 tests"
affects: [32-23, 32-26, Phase 33]
tech-stack:
  added: []
  patterns:
    - "every witness function takes a state and returns {state, findings} with a new state object; the input is never changed (tests deep-freeze it)"
    - "state is plain JSON with fixed key order and no undefined keys, so serialise then read is deep-equal"
    - "size caps on every growing list so a full state plus a proof of two full checkpoints stays under 256 KiB"
key-files:
  created:
    - src/domain/replica/hubWitness.ts
    - src/test/replicaHubWitness.test.ts
  modified: []
decisions:
  - "witnessHeads takes the roster (deviceKey) as a required third argument and tracks only writers the roster knows, so a hub cannot fill the high-water marks with made-up writers and hide a later rollback (plan signature had two arguments)"
  - "witnessCheckpoint returns trusted: boolean beside {state, findings}, so 32-23 knows whether the checkpoint became the newest; it takes optional entries passed to checkpointConflict so nesting can be judged too"
  - "witnessCheckpoint check order: verify (injected, with the refusal id) -> project (wrong-project) -> distrusted (forked-view again) -> compare with newest. A forked checkpoint gives only forked-view, not rolled-back as well"
  - "Beyond checkpointConflict, two head checks prove a fork: same seq with another hash (same-seq-other-hash) and identical heads with another count (same-heads-other-count); WITNESS_PROOF_REASONS extends CHECKPOINT_CONFLICTS with them"
  - "A checkpoint that drops a writer or a whole stream the newest one covered counts as rolled-back: an honest hub's coverage only grows because it keeps every cell key it was granted (D-63, D-64)"
  - "On forked-view the newest checkpoint is dropped (proof.a holds it) and the hub stays distrusted until Phase 33's re-admit flow; this keeps the saved state under its size cap and readWitness enforces the invariant distrusted == has proof and no newest"
  - "The stored checkpoint is rebuilt from the verified payload and the roster's device key, because verifyCheckpoint ignores the hub-sent signer field; nothing extra the hub sent is kept"
  - "An accepted checkpoint raises the seen marks too, so heads below an accepted checkpoint are rolled-back"
  - "Seen marks keep stream, writer and seq only (no hash): rollback is judged by seq, and dropping the hash keeps 400 marks inside the size budget"
  - "One finding per kind per call: rolled-back and withheld name the first (sorted or oldest) item in detail and carry the count of all"
  - "withheld counts only hashes missing for at least WITHHELD_GRACE_MS (>=), and at most MAX_WAITING (128); a verified new entry (witnessEntry) also stops a wait"
  - "delayed: the clock per own writer log starts when its head is first seen uncovered while connected and keeps running while the entries it started with stay uncovered; a checkpoint that covers those restarts it for the rest. Not connected (or distrusted) stops every clock, so the next connection starts fresh. An optional covered stream list limits it to cells the hub can checkpoint (D-63). Minutes are whole (floor), at >= DELAYED_AFTER_MS"
  - "findingSentence fills N with the count and the singular for 1 ('1 change', '1 minute'); without a count it says 'some'"
  - "Finding detail values are cut to 12 characters for ids (stream, writer, entry, blob, checkpoint, project); reason ids are kept whole and must match a lowercase id pattern, else 'unknown'"
  - "readWitness checks the hub and project first (other-hub, other-project), then every key closed, every id pattern, ISO times, list caps and no duplicate rows (malformed); the saved checkpoints are shape-checked, not re-verified, because this is this computer's own record"
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan has no checkpoint. The tracer gate (Task 1) passed on its automated verify before Tasks 2 and 3."
metrics:
  duration: "about 13 minutes"
  completed: 2026-11-20
estimate:
  tokens: 45023
  tasks: 3
actuals:
  tokens: 15338
  tasks: 3
  commits: 3
plan_head_before: fc3e6f0811c89d01cc46531f64f96313b59a8943
plan_head_after: e45a7bc3a7f84250a718ccf2cd90c7a25fa86af6
---

# Phase 32 Plan 16: Hub witness Summary

The client's malicious-hub findings as one pure module: rolled-back and forked checkpoints caught against the newest checkpoint held (with the two signed checkpoints kept as proof and the hub distrusted after a fork), lower heads, wrong-project responses, injected entries, corrupt blobs and counted replays, plus withheld citations and delayed own entries over passed-in time, all in a plain state that saves and reads back per hub per project.

## What was built

- `src/domain/replica/hubWitness.ts` (440 lines). Imports only `../team/canonical`, `../team/validate`, `./checkpoint`, `./entry`, and types from `./chain`, `./rosterView`, `./transport`. It is not on HUB_SIDE (the hub never runs it), and the hub's own tests may load it.
- `src/test/replicaHubWitness.test.ts` (28 tests): Task 1 checkpoints (9), Task 2 heads, responses, entries, blobs and finding fields (8), Task 3 withheld, delayed, save and read, caps, sentence table, import rule and input checks (11).

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | Tracer: a rolled-back checkpoint and a forked view are named | c1c4049c |
| 2 | Heads, responses, entries and blobs | bdec8137 |
| 3 | Withheld and delayed over injected time, serialisation, the sentence table and the import rule | e45a7bc3 |

## Failing-first evidence

- Task 1: the test compiled against unchanged code failed with `TS2307: Cannot find module '../domain/replica/hubWitness'`.
- Task 2: on Task 1 code, `TS2305: ... has no exported member 'witnessBlob'` (and witnessEntry, witnessHeads, witnessResponse).
- Task 3: on Task 2 code, `TS2305` for WITNESS_MAX_BYTES, WITNESS_REFUSALS, serializeWitness, witnessCitations, witnessOwn, and `TS2724` for readWitness.
- Mutation proofs (D-66 style), each applied alone, compiled, run, then restored:
  - Remove the distrust gate in witnessCheckpoint: 2 tests fail (forked-view proof and distrust; saved distrusted state keeps refusing).
  - Drop the lower-seq rollback check: 2 tests fail (rolled-back checkpoint; finding fields).
  - Withheld grace `>=` to `>`: 1 test fails (withheld at exactly the grace period).
  - Remove the roster filter in witnessHeads: 1 test fails (unknown writers raise no mark).
  - Delayed while not connected: 1 test fails (nothing while offline).

## Verification

- `replicaHubWitness.test.js` 28/28 pass; with `replicaBoundaries.test.js` 34/34 pass; `npm run lint` exits 0 (all under the memory cap).
- `grep -c "forked-view" src/domain/replica/hubWitness.ts` = 6; em-dash count in both files = 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Roster filter and size caps**
- **Found during:** Tasks 2 and 3
- **Issue:** Without a filter a hub could fill the seen marks with made-up writers; without caps the saved state could pass its 256 KiB read limit, and a state that cannot be read back would lose the distrust after a fork.
- **Fix:** witnessHeads requires the roster's deviceKey; caps MAX_SEEN_HEADS 400, MAX_WAITING 128, MAX_OWN_WAITS 64; the newest checkpoint is dropped on a fork (the proof holds it). A test fills every cap and asserts the state plus two full checkpoints fits.
- **Files modified:** src/domain/replica/hubWitness.ts, src/test/replicaHubWitness.test.ts
- **Commits:** bdec8137, e45a7bc3

**2. [Rule 1 - Bug] Literal em-dash characters in test regexes**
- **Found during:** Task 3 verification
- **Issue:** The test's em-dash checks were written with the literal character.
- **Fix:** Replaced with the backslash-u-2014 regex escape; no file now contains the character.
- **Commit:** e45a7bc3

## Notes for later plans

- 32-23: call witnessResponse on every answer, witnessEntry per entry after verifyEntry, witnessBlob per blob, witnessHeads with the roster, witnessCheckpoint with heads.checkpoint (and the held entries when available), witnessCitations with missing deps and checkpoint heads, witnessOwn with this device's heads and the covered cells (D-63). Use `trusted` before using a checkpoint as a join base.
- 32-26: WITHHELD_GRACE_MS and DELAYED_AFTER_MS are exported for the harness; the "honest chain" control row (D-70) should give no forked-view, which the same-seq and same-heads checks only raise on a real disagreement.
- Phase 33: findings carry the sentence; group by kind for display. Re-admitting a distrusted hub means starting a fresh witness (createWitness).

## Known Stubs

None.

## Threat Flags

None. The module adds no endpoint, file access or schema at a trust boundary; it only reads values the caller already holds.

## Self-Check: PASSED

- FOUND: src/domain/replica/hubWitness.ts
- FOUND: src/test/replicaHubWitness.test.ts
- FOUND: c1c4049c, bdec8137, e45a7bc3 (ancestors of HEAD)
