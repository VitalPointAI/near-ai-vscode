---
phase: 33-live-multi-user-staff-projects
plan: 14
status: complete
subsystem: the live scenarios over a real hub, the two-compartment leak test through the replicator, the late joiner from a checkpoint, and the CI run of them
tags: [staff, live, replicator, hub, scenarios, leak, presence, session-keys, compaction, checkpoints, late-joiner, ci, d-24, d-34, d-35, d-42, d-43, d-46, d-60, d-62, mus-09]
requires: [33-01, 33-03, 33-05, 33-06, 33-08, 33-09, 33-12, 33-21, 33-22, 33-24]
provides: [staffLiveScenario.test.ts, liveScenarios.test.ts, liveLeak.test.ts, hub/test/helpers/capture.ts, foldCheckpoints, trustedCheckpointsOf, ReplicaProject.trustCheckpoint, SyncLocal.trustCheckpoint, SyncReport.readInFull, FULL_REPLAY_SENTENCE, LiveReplicatorOptions.startFromBase, MigrationOptions.leadName, LiveWorld.join, LiveWorld.goOffline, LiveWorld.goOnline, LiveWorld.hostedStyle, asyncPersonSigner, "CI step: Build the hub for the real-hub tests"]
affects: [33-16, 33-24, 33-25, 33-27, 33-28]
tech-stack:
  added: []
  patterns: [one hosted-style person per scenario through a session key and an async person signer, waits on status and fold state, capture of every byte per authenticated connection, the fold under the checkpoints the witness trusts]
key-files:
  created:
    - src/test/staffLiveScenario.test.ts
    - src/staff/replica/foldCheckpoints.ts
    - hub/test/liveScenarios.test.ts
    - hub/test/liveLeak.test.ts
    - hub/test/helpers/capture.ts
  modified:
    - src/test/helpers/liveWorld.ts
    - src/staff/replica/liveReplicator.ts
    - src/staff/replica/compactor.ts
    - src/staff/replica/replicaProject.ts
    - src/staff/replica/hubSync.ts
    - src/staff/replica/migrate.ts
    - src/test/staffLiveReplicator.test.ts
    - src/test/replicaCheckpointHeads.test.ts
    - src/test/staffHubSyncLive.test.ts
    - src/test/staffReplicaProject.test.ts
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
  - "onCheckpoint means: an exchange made a newer checkpoint of this hub the trusted newest one on this computer. It no longer fires on the frame."
  - "The compactor folds and recomputes the checkpointed prefix under the hub's earlier checkpoints that this computer stored."
  - "A computer's fold uses only the checkpoints of a hub the roster admits at the head, that verify at their own position, and that the hub's witness on this computer trusts (its newest and the stored ones no larger). Coordinator's decision on G430."
  - "The live engine passes startFromBase: a log this computer holds nothing of starts at the newest trusted checkpoint's head; other logs are untouched."
  - "The test job is the one CI run of the staff scenarios: it builds the hub on Node 26.13.1 and sets NEAR_AI_HUB_NODE. The hub job runs only the hub's own suite."
  - "createSharedProject writes the lead's name as the lead's first member.update; the genesis names only the member id."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 75000
  tasks: 3
  commits: 8
plan_head_before: 30f81862
plan_head_after: 39d2f62e
completed: 2026-11-25
---

# Phase 33 Plan 14: The live scenarios Summary

The real-hub scenarios now run. Two and three people's computers, each with its own store and device key, share one hub child process on Node 26. Each scenario includes one hosted-style person, whose session key signs ordinary work and whose person key signs decisions. The cases covered:

- co-editing through bound documents, then propose, clear, submit and approve on the other person's computer;
- a session key that has ended;
- a decision made offline against one made online, contested and then settled;
- a roster change under a checkpoint;
- a late joiner.

On the hub side, five live scenarios and the two-compartment leak test run through the live replicator, with presence and cursors in the capture.

On the way, four engine defects were found and fixed:

- the compactor never ran on the newest checkpoint;
- it could not reproduce any checkpoint after the first;
- the live engine named the server by the wrong id;
- the lead's name was never written to the roster.

The late joiner is now built as the coordinator decided. Each computer's fold uses the checkpoints its witness trusts, and the engine passes `startFromBase`, so a person who joins pulls 5 of 79 entries and nothing is held back. Two limits remain in G430:

- only the base cell and cells granted to the hub have a checkpoint to start from;
- a summary's text counts only once the registrations written before the checkpoint arrive.

CI runs the scenarios once, in the test job.

## Base and merges

- `feat/phase-33-engine-wave-1` at `2353811b` (33-31 done). The branch is checked out in another worktree, so this work is on `worktree-agent-ac332f9b7cf0e25a4` and pushed to `origin/feat/phase-33-engine-wave-1`.
- `origin/main` merged (`1cb95868`: #197, the 45.2, 47, 70.1, 74.1 and 74.3 plans, the gap register). No conflicts.
- **Gap renumbered** (`30f81862`). 33-24's G416 clashed with 74.1's reserved range G407 to G418, so it is now **G422**:
  - the highest id on any `origin/*` branch was G420 (Phase 47), and Phase 71 is taking G421;
  - the coordinator confirmed this branch keeps G422 and has **G430 to G434**; **G430** is used;
  - the count test was still 391 after 33-24 added a gap. It is 393 now (G422 and G430).
- Step 0 (D-01): the tracer exists, and `startHubChild`, `EditorBinding` and `VersionActs` gave 1 each. The digest is `fold.digests`, from `streamDigests` in `digest.ts`.

## What was built

- **`staffLiveScenario.test.ts`** (5 tests, all over a real hub child; each prints the hub's Node version and fails unless it is v26.13.1):
  - **tracer:** Avery and Blake (hosted) bind `FakeBoundDocument`s through `EditorBinding` and type in three interleaved rounds.
    - Documents, Y.Texts and fold texts end equal.
    - Avery proposes v1, Blake clears it as the release guard, Avery submits, and Blake approves on Blake's computer. Each step waits for the other computer's fold, so the proposal's text blob (33-24 defect 2) crosses the hub.
    - Versions and every digest are equal.
    - Blake's typing is signed by the session key, and the decision by the person key with one person-signer call.
  - **session-expired:** after notAfter, Blake's decision stays on Blake's computer, and the replicator is `refused` / `session-expired` with its sentence and no retry. Avery never gets the decision.
  - **contested:** Avery goes offline for real (replicator stopped, every call refused unreachable) and approves, while Blake rejects online.
    - All three computers show contested, with both names and reasons in `contestedCards`.
    - Casey (hosted) settles with a fresh approval listing both decisions.
    - All three end approved with equal digests.
  - **roster change:** Casey is admitted while two others are live. A hub checkpoint at the new roster head reaches Blake, and both stay live with no finding (33-24 defect 1).
  - **late joiner:**
    1. 60 updates, a hub checkpoint, and Avery's doc.compact about 10 s after the sixtieth update.
    2. A later editing session adds 3 lines.
    3. Dana joins and Dana's replicator runs with `startFromBase`. Dana pulls **5 of 79** entries in 0.2 s, nothing waits in the chain, Dana folds under the hub's checkpoint, and Dana's roster equals Avery's.
    4. The earlier history is then served in shuffled pieces. Dana then has the same text with the compaction, the same digest for every stream, the same roster and the same checkpoint.
- **`foldCheckpoints.ts`:** the checkpoints a fold may use, from those stored and what each hub's witness trusts.
  - **Used:** a hub the roster admits as checkpoint signer at the head; a checkpoint that verifies at its own position, is version 2 and is for this project; the witness's newest checkpoint and the stored ones no larger.
  - **Not used:** anything from a hub whose witness distrusts it or holds a proof, or whose witness can't be read.
  - The list is sorted by hash, so two computers holding the same checkpoints fold under the same list.
- **`ReplicaProject`:**
  - folds under those checkpoints (join bases and checkpoint order), and folds again from the start when the set changes;
  - reads the witness memory once at the first fold, and after that each exchange updates it through `SyncLocal.trustCheckpoint`;
  - `createSharedProject` writes `lead.name` as the lead's first `member.update`.
- **`hubSync`:** with `startFromBase`, a log no trusted checkpoint covers is read from its start and listed in `readInFull`, with `FULL_REPLAY_SENTENCE` ("Your organization's server keeps no summary of this part of the project, so this computer reads all of its history. Nothing is left out.").
- **`LiveReplicatorOptions.startFromBase`**, which the live engine passes. **`MigrationOptions.leadName`**.
- **`liveWorld.ts`:** per-person roles and agent seats, `join`, `goOffline` and `goOnline`, `hostedStyle` (session.certify by the device, the project reopened with the session signer and `asyncPersonSigner`), and the lead's name.
- **`hub/test/helpers/capture.ts`:** the capture helpers, moved unchanged out of `ciphertextOnly.test.ts`, which passes unchanged.
- **`liveScenarios.test.ts`** (5):
  - delivery to two others in about 550 ms;
  - presence and cursor reach only the cell's access list and open only under its key;
  - a join request reaches the lead only (the hub's audience);
  - restore mode puts both computers offline with reason `restoring`, then live;
  - a server put back to an older copy shows both computers attention `rolled-back`, and after the lead's re-admission both are live.
- **`liveLeak.test.ts`** (5; one is named "presence"). X is in compartment one, and Y in compartment two in a hosted session. Every hub byte is captured per connection, and the state folder is read raw. The tests:
  - a positive control;
  - no canary of the other compartment in any form reaches X or Y, and no compartment canary is anywhere in the hub;
  - no stream id, grant, entry or presence value of the other compartment reaches either person;
  - presence opens only under its own cell's key;
  - `session.certify` is sealed under the roster cell's key and carries only its binding.
- **CI (gate path, D-39):** the `test` job sets up Node 26.13.1 first, builds the hub and exports `NEAR_AI_HUB_NODE`, then sets up Node 24 as before. Every real-hub test in the root suite runs there, the staff scenarios included, which makes it the one canonical run. The hub job runs only the hub's suite again (timeout 25). The test job's timeout goes from 15 to 25 minutes. `hubIsolation.test.ts` checks both.

## Deviations from Plan

1. **[Rule 1] onCheckpoint ran before the checkpoint was known** (`570d067c`).
   - It fired on the frame, before the exchange that stores the checkpoint.
   - The device whose own ask made the hub sign gets no frame at all.
   - It now runs after an exchange that made a newer checkpoint trusted. A unit test is added.
2. **[Rule 1] The compactor could not reproduce any checkpoint after the first** (`570d067c`).
   - It folded and recomputed without the hub's earlier checkpoints, which the hub nests first (`order-tip-mismatch`).
   - It now passes the stored, verified ones.
3. **[Rule 1] The live engine never compacted** (`570d067c`). It named the server by its hub id, not its writer id.
4. **[Rule 3] The root test job gives the suite a built hub.** Every real-hub test in the root suite failed in GitHub Actions without `NEAR_AI_HUB_NODE` (D-46).
   - The plan's hub-job step would have run the scenario a second time.
   - The coordinator chose one canonical run, so the step is removed (`018fc335`), and the plan's acceptance grep for `staffLiveScenario.test.js` in ci.yml now gives 0.
5. **Coordinator decision: the late joiner** (`47696c53`).
   - **Built:** the checkpoint-aware fold and `startFromBase`, with the parity test and the fall-back test the coordinator asked for.
   - **Remaining limit 1:** the domain's own rule (D-42, CR-01). A summary counts only once the registrations of the editing sessions it holds have arrived, and those are written before the checkpoint. So Dana's product text is complete only once the earlier history is served.
   - The scenario asserts what holds today and does not assert the text before the history is served. The plan's must-have that the late joiner has the same text and digest at once is met only after that serving.
   - **Remaining limit 2:** only cells the hub holds have a checkpoint. In any other cell the history is read in full, with the plain sentence above.
   - Both stay in **G430** (`39d2f62e`), and need a decision on how a summary may name the sessions it holds.
6. **The fork scenario is a restored copy, not a forked view.** Over the in-process hub, an older copy gives `rolled-back`, because the heads check stops the exchange before the checkpoint comparison. The forked-view to re-admission path is covered by `staffLiveReplicator.test.ts` (33-09).
7. **[Rule 1] The lead's name.**
   - `CreateSharedInput.lead.name` was accepted and dropped, because the genesis has no place for it. So the Staff Room showed the lead as `mbr-…` (a contested card showed `mbr-lead`).
   - It is now the lead's first `member.update`, and `staffReplicaProject.test.ts` covers it. The three creation tests there now expect that entry, a behaviour change and not a weaker test.
   - `migrate` accepts `leadName`. The VS Code command asks no name, so it still passes none. The native Share flow (33-28) should pass the name the person gives.
8. **Tests first:** every new test was written against the merged code. The failures it met are deviations 1 to 3, 5 and 7, plus test premises (`flush` counts updates and not the registration; a member with nothing to push stays live in restore mode; the hub child is stopped after 60 s, which every scenario now finishes inside).

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0, choom and timeout, on Node 26.13.1 with `NEAR_AI_HUB_NODE` set.

| Run | Result |
|-----|--------|
| Root `npm run lint` | exit 0 |
| **Root `npm test`, full, once** | **6613 tests: 6603 passed, 2 failed, 8 skipped.** The 2 failures are `autoApproval` "the managed Open-GSD runtime's gsd-tools runs without an approval" and `cyberAssembly` "the store path and the run root are the same workspace". Both compare a path built from this worktree's long folder names, and both touch no file this plan changed (see Open conditions). The 8 skips are the existing environment skips: no ripgrep, no `NEAR_GSD_HOME`, no `NEAR_AI_API_KEY`. |
| Root focused on the final code: the scenarios, checkpoint heads, project, hub transport, copy, replicator, compactor, hubIsolation, hub sync, membership, architecture, copyLint, replicaBoundaries | **266 tests: 266 passed** |
| Hub `npm run lint && npm test` | lint exit 0; **457 tests: 454 passed, 0 failed, 3 skipped** (the existing older-Node tests, which need `NEAR_AI_HUB_OLD_NODE`) |
| Workbench `npm ci --ignore-scripts`, then `npm run build`, `npm test`, `npm run lint` | build ok; **147 tests: 147 passed**; lint exit 0. Lint first caught a `string \| undefined` message in `liveWorld.ts`, now fixed. |
| Compliance: gaps, wordLint | 30 passed |

- Timings:
  - tracer 6.5 s (co-edit 3.5 s); session-expired 10.9 s; contested 4.5 s; roster change 12.6 s;
  - late joiner 14.6 s (doc.compact 10.0 s after the sixtieth update; Dana's pull 0.2 s);
  - hub live delivery 549 to 560 ms; 33-01's tracer unchanged (634 to 713 ms).
- **Pulled-entry count of the late joiner:** 5 of 79. The 5 are doc.compact, the later session's registration and 3 updates.
- Acceptance:
  - staffLiveScenario has 5 tests, with "contested" and "late joiner" in their names, none skipped. `hubNodeOrSkip` is present.
  - liveScenarios 5, liveLeak 5 (one named presence). `function captureServer` in ciphertextOnly: 0.
  - `NEAR_AI_HUB_NODE` in ci.yml: present. `staffLiveScenario.test.js` in ci.yml: 0 (deviation 4).
- **Tests added: 18.**
  - root: staffLiveScenario 5, staffLiveReplicator 1, replicaCheckpointHeads 2, hubIsolation 1;
  - hub: liveScenarios 5, liveLeak 5.
- **Tests changed: 5.**
  - the workbench compaction test checks the writer id;
  - the workbench engine test checks `startFromBase`;
  - two `staffHubSyncLive` tests check `readInFull`;
  - the `staffReplicaProject` creation tests expect the lead's name entry.

## Threat model

| Threat | As built |
|---|---|
| T-33-59 | liveLeak: every byte per connection, presence, cursors and session certificates included; the hub opens nothing of either compartment. |
| T-33-60 | contested: both decisions are kept and shown, and the fresh one lists both. |
| T-33-61 | The CI change reads no secret, runs only repository code, and needs the owner's gate approval. |
| T-33-62 | Every run was inside MemoryMax. The only timed waits are the hub's own checkpoint timing. |
| T-33-SC | `npm ci --ignore-scripts` of the existing lockfiles; no package added. |

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: fold trust input | src/staff/replica/foldCheckpoints.ts, src/staff/replica/replicaProject.ts | A hub's checkpoint now lets entries in without their predecessors (join bases) and fixes the fold's order, but only when the roster admits the hub, the checkpoint verifies, and the witness on this computer trusts it. A distrusted or forked hub gives none, which is tested. |

## Gate files

- `.github/workflows/ci.yml`: the test job's hub build. The integration PR waits for the owner's gate approval (D-39), and 33-16 sends the run URL.

## Open conditions

- G430 (closes in Phase 33): the late joiner's two remaining limits.
  - It starts from a checkpoint only in the base cell and cells granted to the hub, and reads every other cell in full.
  - Its product text counts the summary only once the earlier registrations arrive.
  - Needs a decision on how a summary may name the sessions it holds without their registrations, then serving the earlier history after the start.
- G422 (renumbered from G416, 33-24): the workbench image SBOM does not list the vendored Yjs build.
- Two root tests fail in this worktree: `autoApproval` (Open-GSD runtime) and `cyberAssembly` (store path).
  - Both compare paths derived from the very long scratch and worktree folder names, and both still fail with a short TMPDIR.
  - No file they test is touched by this plan, but their pass on a short-path checkout was not shown here.
  - 33-16's full run on CI is the check.
- The lead's name reaches the roster only when the creating flow passes it: `MigrationOptions.leadName`, for 33-28's Share flow.
- `.planning/phases/33-live-multi-user-staff-projects/33-14-late-joiner-scenario.ts.txt` is the held-back copy, now restored into the test file. It can be deleted; I left it until someone confirms.

## Self-Check: PASSED

- The created files exist. Commits `30f81862`, `69720a2a`, `570d067c`, `6f1cf76f`, `81668d8a`, `fc5b361b`, `42c05990`, `47696c53`, `018fc335` and `39d2f62e` are in HEAD.
