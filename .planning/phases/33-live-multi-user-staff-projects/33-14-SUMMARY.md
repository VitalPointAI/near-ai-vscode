---
phase: 33-live-multi-user-staff-projects
plan: 14
status: partial
subsystem: the live scenarios over a real hub, the two-compartment leak test through the replicator, and the CI steps that run them
tags: [staff, live, replicator, hub, scenarios, leak, presence, session-keys, compaction, ci, d-24, d-34, d-35, d-43, d-46, d-60, d-62, mus-09]
requires: [33-01, 33-03, 33-05, 33-06, 33-08, 33-09, 33-12, 33-21, 33-22, 33-24]
provides: [staffLiveScenario.test.ts, liveScenarios.test.ts, liveLeak.test.ts, hub/test/helpers/capture.ts, LiveWorld.join, LiveWorld.goOffline, LiveWorld.goOnline, LiveWorld.hostedStyle, asyncPersonSigner, LivePerson, LiveSession, "CI step: Run the real-hub staff scenario", "CI step: Build the hub for the real-hub tests"]
affects: [33-16, 33-24, 33-25, 33-27]
tech-stack:
  added: []
  patterns: [one hosted-style person per scenario through a session key and an async person signer, waits on status and fold state, capture of every byte per authenticated connection]
key-files:
  created:
    - src/test/staffLiveScenario.test.ts
    - hub/test/liveScenarios.test.ts
    - hub/test/liveLeak.test.ts
    - hub/test/helpers/capture.ts
    - .planning/phases/33-live-multi-user-staff-projects/33-14-late-joiner-scenario.ts.txt
  modified:
    - src/test/helpers/liveWorld.ts
    - src/staff/replica/liveReplicator.ts
    - src/staff/replica/compactor.ts
    - src/test/staffLiveReplicator.test.ts
    - workbench/extension/src/node/staff/staff-live-engine.ts
    - workbench/test/staff/staff-live-engine.test.ts
    - hub/test/ciphertextOnly.test.ts
    - hub/test/helpers/liveClient.ts
    - .github/workflows/ci.yml
    - src/test/hubIsolation.test.ts
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - docs-site/content/security/road-to-production.md
key-decisions:
  - "onCheckpoint now means: an exchange made a newer checkpoint of this hub the trusted newest one on this computer. It no longer fires on the frame."
  - "The compactor folds and recomputes the checkpointed prefix under the hub's earlier checkpoints that this computer stored."
  - "The root test job builds the hub on Node 26.13.1 and sets NEAR_AI_HUB_NODE. Without it every real-hub test in the suite fails in GitHub Actions (D-46)."
  - "The late joiner scenario is held back, not skipped: it cannot pass until the fold is given the stored checkpoints, which changes the order for every device (Rule 4)."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 60000
  tasks: 3
  commits: 5
plan_head_before: 30f81862
plan_head_after: fc5b361b
completed: 2026-11-25
---

# Phase 33 Plan 14: The live scenarios Summary

The real-hub scenarios now run. Two and three people's computers, each with its own store and device key, share one hub child process on Node 26. Each scenario includes one hosted-style person, whose session key signs ordinary work and whose person key signs decisions. The cases covered:

- co-editing through bound documents, then propose, clear, submit and approve on the other person's computer;
- a session key that has ended;
- a decision made offline against one made online, contested and then settled;
- a roster change under a checkpoint.

On the hub side, five live scenarios and the two-compartment leak test run through the live replicator, with presence and cursors in the capture. CI runs the scenario in the hub job, and the test job now gives the suite a built hub.

Three engine defects were found and fixed on the way: the compactor never ran on the newest checkpoint, it could not reproduce any checkpoint after the first, and the live engine named the server by the wrong id. The late joiner part of Task 2 does not pass yet. Its last missing piece changes how every computer orders entries, so the scenario is held back for a decision (below).

## Base and merges

- `feat/phase-33-engine-wave-1` at `2353811b` (33-31 done). The branch is checked out in another worktree, so this work is on `worktree-agent-ac332f9b7cf0e25a4` and pushed to `origin/feat/phase-33-engine-wave-1`.
- `origin/main` merged (`1cb95868`: #197, the 45.2, 47, 70.1, 74.1 and 74.3 plans, the gap register). No conflicts.
- **Gap renumbered** (`30f81862`). 33-24's G416 clashed with 74.1's reserved range G407 to G418, so it is now **G422**:
  - the highest id on any `origin/*` branch was G420 (Phase 47), and Phase 71 is taking G421;
  - the coordinator has since confirmed this branch keeps G422 and has **G430 to G434** for anything new;
  - the count test was still 391 after 33-24 added a gap, and is now right;
  - road-to-production was regenerated, and the 33-24 SUMMARY names G422.

Step 0 (D-01) at the base:
- `staffLiveTracer.test.ts` is present.
- `startHubChild` 1, `EditorBinding` 1, `VersionActs` 1.
- The digest is not a function. It is `fold.digests`, from `streamDigests` in `digest.ts`, and the scenarios compare `fold.digests`.

## What was built

- **`staffLiveScenario.test.ts`** (4 tests, all over a real hub child; each prints the hub's Node version and fails unless it is v26.13.1):
  - **tracer:** Avery and Blake (hosted) each bind a `FakeBoundDocument` through `EditorBinding` and type in three interleaved rounds.
    - Documents, Y.Texts and fold texts end equal.
    - Avery proposes v1, Blake clears it as the release guard, Avery submits, and Blake approves on Blake's computer. Every step waits for the other computer's fold, so the proposal's text blob (33-24 defect 2) crosses the hub.
    - Versions and every `fold.digests` entry are equal.
    - Blake's typing is signed by the session key, and the decision by the person key with one person-signer call.
  - **session-expired:** Blake's session key lasts 8 s.
    - After notAfter, Blake's decision is kept on Blake's computer, and the replicator is `refused` / `session-expired` with its sentence and no retry.
    - The hub and Avery never get the decision, so v1 stays awaiting a decision.
  - **contested:** Avery goes offline for real (replicator stopped, every transport call refused unreachable) and approves, while Blake rejects online.
    - All three computers show contested, with both names and reasons in `contestedCards`.
    - Casey (hosted) settles with a fresh approval whose `decisionsSeen` lists both decisions.
    - All three end approved with equal digests.
  - **roster change:** Casey is admitted while Avery and Blake (hosted) are live. A hub checkpoint at the new roster head reaches Blake, and both stay live with no finding (33-24 defect 1).
- **`liveWorld.ts`:**
  - per-person roles and agent seats;
  - `join` (a person after the world was made);
  - `goOffline` and `goOnline`;
  - `hostedStyle` (session.certify by the device, the project reopened with the session signer and `asyncPersonSigner`);
  - the lead's name in the roster.
- **`hub/test/helpers/capture.ts`:** the canary search, `captureServer`, `wireOf`, `canaryForms`, `startCapturedHub` and `logsOf`, moved unchanged. `ciphertextOnly.test.ts` imports them and passes unchanged. `grep -c "function captureServer" hub/test/ciphertextOnly.test.ts` gives 0.
- **`liveScenarios.test.ts`** (5):
  - delivery to two others in 549 and 560 ms;
  - presence and cursor reach only the cell's access list and open only under that cell's key;
  - a join request reaches the lead's device only (both clients said yes to `isLeadDevice`, so the hub's audience is what is tested);
  - restore mode puts both computers offline with reason `restoring`, then both go live and exchange;
  - a server put back to an older copy shows both computers attention `rolled-back`; after the lead's re-admission both are live with each other's changes.
- **`liveLeak.test.ts`** (5; one is named "presence"). X is in compartment one, and Y in compartment two in a hosted session. Every hub request and response is captured per authenticated connection, and the state folder is read raw. The tests:
  - a positive control;
  - no canary of the other compartment, in any `canaryForms` form, reaches X or Y, and no compartment canary is anywhere in the hub;
  - no stream id, grant, entry or presence value of the other compartment reaches either person;
  - presence opens only under its own cell's key and never under the hub's keys;
  - `session.certify` travels sealed under the roster cell's key and carries only `device, member, notAfter, sessionKey, sessionSig, slot`.
- **CI (gate path, D-39):**
  - hub job: a step "Run the real-hub staff scenario" after `npm test`, guarded like the others. It takes `NEAR_AI_HUB_NODE` from the job's Node 26, puts `NEAR_AI_HUB_OLD_NODE` first on PATH, and runs `npm ci --ignore-scripts`, `npm run compile` and the scenario. It reads no secret. The job timeout goes from 25 to 35 minutes.
  - test job: see deviation 4.
  - `hubIsolation.test.ts` has a new test for both.

## Deviations from Plan

1. **[Rule 1] onCheckpoint ran before the checkpoint was known** (`570d067c`).
   - The replicator called the hook on the frame, before the exchange that stores the checkpoint in the witness.
   - The device whose own ask made the hub sign gets the checkpoint in the ask's answer and no frame.
   - So the compactor ran on the previous checkpoint or not at all. The hook now runs after an exchange that made a newer checkpoint the trusted newest one.
   - New unit test in `staffLiveReplicator.test.ts`.
2. **[Rule 1] The compactor could not reproduce any checkpoint after the first** (`570d067c`).
   - `prepareCompaction` folded the checkpointed prefix and recomputed its order without the hub's earlier checkpoints. The hub nests those first, so the result was `order-tip-mismatch` whenever two writers' entries interleaved.
   - It now passes this hub's stored, verified checkpoints to `foldEntries` and to `recomputeCheckpoint`.
   - Proven over the real hub: doc.compact was written 10 s after the sixtieth update, where before it was never written.
3. **[Rule 1] The live engine never compacted** (`570d067c`).
   - `StaffLiveEngine.compact` passed the hub's id, but the compactor and the witness memory name the server by its writer id.
   - The workbench test now checks the id passed in.
4. **[Rule 3] The root test job gives the suite a built hub** (`81668d8a`).
   - Every real-hub test already in the root suite (33-01's tracer, 33-22's session key test, these scenarios) fails in GitHub Actions without `NEAR_AI_HUB_NODE` (D-46).
   - The `test` job now sets up Node 26.13.1 first, builds the hub, exports `NEAR_AI_HUB_NODE`, then sets up Node 24 as before (first on PATH). Both hub steps are skipped on a commit without `hub/package.json`. The timeout goes from 15 to 20 minutes.
   - The hub job's own scenario step, which the plan requires, therefore runs the scenario a second time (open condition).
5. **[Rule 4, held back] The late joiner scenario.**
   - It is written: 60 updates, a hub checkpoint, Avery's doc.compact, three later updates, Dana joins and syncs with `startFromBase`, and Dana's text and digest are compared.
   - It reaches doc.compact. It then fails because:
     - Dana pulled 4 entries (from seq 62 on) against a history of about 78;
     - all 4 stay held `missing-predecessor`, because `ReplicaProject`'s fold (`createFoldState(this.ctx)`) is never given the stored checkpoints that make them join bases.
   - Two more findings:
     - nothing passes `startFromBase` (33-08's summary said 33-24 would; it does not);
     - the hub checkpoints only the base cell and cells granted to it (D-63), so a label cell needs `grantCellToHub` before it can be compacted at all.
   - Giving every device's fold its checkpoints changes the order and the final mark for everyone, which is beyond a test plan's fix.
   - The scenario is kept, with the imports and the hub child's longer kill guard it needs, in `33-14-late-joiner-scenario.ts.txt`. It is filed as G430.
6. **The fork scenario is a restored copy, not a forked view.**
   - Over the in-process hub, an older copy put back gives `rolled-back` on both computers. The heads check stops the exchange before the checkpoint comparison.
   - The test asserts `rolled-back` and the lead's re-admission, then live on both. It does not claim that the re-admission was what cleared it.
   - The forked-view to re-admission path is covered by `staffLiveReplicator.test.ts` (33-09).
   - The test shortens the one-minute look-again of attention to 0.5 s through the replicator's `timers` option.
7. **The lead's name was not in the roster.** `CreateSharedInput.lead.name` is accepted but not written at genesis, so a contested card showed `mbr-lead`. The test world writes the name with `updateMember`, as a lead's own flow would. The product path is for 33-28 to confirm.
8. **Tests first:** every new test was written against the merged code. The failures it met are deviations 1 to 3 and 5, plus test premises (`flush` counts updates and not the registration; a member with nothing to push stays live in restore mode; the lead's name).

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0, choom and timeout, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set.

| Run | Result |
|-----|--------|
| Root, focused, on the final code: staffLiveScenario, staffLiveReplicator, staffCompactor, staffLiveTracer, staffHubSessionKey, hubIsolation, scripts/test/workflow | **101 tests: 101 passed, 0 failed, 0 skipped** |
| Root boundaries: architecture, copyLint, replicaBoundaries, replicaHubWitness, staffHubSyncLive, staffLiveProjection, staffProposalBlob, staffEditorBinding | 121 passed, 0 failed |
| Hub: `npm run lint && npm test` | lint exit 0; **457 tests: 454 passed, 0 failed, 3 skipped**. The 3 skips are the existing older-Node tests, which need `NEAR_AI_HUB_OLD_NODE`; CI sets it. |
| Compliance: gaps, wordLint | 30 passed |
| Workbench | **not run here**: this worktree has no workbench install. The change is one argument and one strengthened assertion; the workbench CI job runs it. |

- Scenario timings:
  - tracer 6.5 s (co-edit 3.5 s);
  - session-expired 10.9 s;
  - contested 4.5 s (settled 3.7 s after the replicators went live);
  - roster change 12.6 s (the checkpoint reached Blake 11.1 s after the admission);
  - 33-01's tracer is unchanged: B saw A's change in 634 to 713 ms.
- Acceptance:
  - `hubNodeOrSkip` in staffLiveScenario: present.
  - `NEAR_AI_HUB_NODE` in ci.yml: 4. `staffLiveScenario.test.js` in ci.yml: 1. `function captureServer` in ciphertextOnly: 0.
  - liveScenarios 5 tests (at least 5); liveLeak 5 (at least 4), one named presence.
  - staffLiveScenario has 4 tests with "contested" but **no "late joiner"** (deviation 5).
- **Tests added: 15.**
  - root: staffLiveScenario 4, staffLiveReplicator 1, hubIsolation 1;
  - hub: liveScenarios 5, liveLeak 5 (the remainder is the existing hub suite moved to the shared helper unchanged).
  - **Tests changed: 1** (the workbench compaction test now also checks the writer id).

## Threat model

| Threat | As built |
|---|---|
| T-33-59 | liveLeak: every byte per connection, presence and cursors and session certificates included; the hub opens nothing of either compartment. |
| T-33-60 | contested: both decisions are kept and shown, and the fresh one lists both. |
| T-33-61 | The scenario step reads no secret, runs only repository code, is guarded like the others, and needs the owner's gate approval. |
| T-33-62 | Every run was inside MemoryMax. Waits are on status, and the only timed waits are the hub's own checkpoint timing. |
| T-33-SC | `npm ci --ignore-scripts` of the existing lockfiles; no package added. |

## Known Stubs

None.

## Gate files

- `.github/workflows/ci.yml`: the hub job's scenario step and the test job's hub build. The integration PR waits for the owner's gate approval (D-39); 33-16 sends the run URL.

## Open conditions

- G430 (filed, closes in Phase 33): a late joiner cannot start from a checkpoint and a compaction yet.
  - The decision: give `ReplicaProject`'s fold the stored, verified checkpoints of the admitted hub. This changes the order and the final mark on every computer.
  - Then pass `startFromBase` for a joining device, and restore `33-14-late-joiner-scenario.ts.txt` to `staffLiveScenario.test.ts`.
  - Even then, a late joiner can start from a compaction only in a cell the hub holds (D-63).
- G422 (renumbered from G416, 33-24): the workbench image SBOM does not list the vendored Yjs build.
- CI runs `staffLiveScenario` twice: in the test job (the whole suite now has a hub) and in the hub job's step, which this plan requires. 33-16 or the owner decides whether to drop the hub job step.
- The workbench unit run of the engine fix was not run in this worktree; the workbench CI job runs it.
- The lead's name is not written at genesis (deviation 7), for 33-28 to confirm.

## Self-Check: PASSED

- The created files exist. Commits `30f81862`, `69720a2a`, `570d067c`, `6f1cf76f`, `81668d8a` and `fc5b361b` are in HEAD.
