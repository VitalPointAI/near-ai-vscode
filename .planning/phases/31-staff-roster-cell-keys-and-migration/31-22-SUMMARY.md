---
phase: 31-staff-roster-cell-keys-and-migration
plan: 22
subsystem: staff-replica
tags: [replica, single-machine-copy, migration, ledger, signing, d-35, d-47, tdd]
status: complete

requires:
  - phase: 31-19
    provides: projectionInputOf, ledgerHeadKey, makeMultiUser (the migrated fixture), the imported ledgers
  - phase: 31-18
    provides: ReplicaProject (open, state, signer, close)
  - phase: 31-11
    provides: projection.ts (projectProductStates, projectProductFile, importOf, importedFile, projectImportedLedger, ledgerLinesOf)
  - phase: 31-20
    provides: membership flows used by the two-install test fixture (invite, join, admit, welcome, updateMember)
provides:
  - "src/staff/replica/singleCopy.ts: makeSingleMachineCopy, COPY_REFUSALS, CONTESTED_AT_COPY_TEXT, carriedApprovalName, CopyDeps, CopyResult, CopyRefused, CarriedAct"
  - "src/test/staffReplicaCopy.test.ts: 11 tests"
affects: [31-23, 33]

tech-stack:
  added: []
  patterns:
    - "The copy is staged in .planning/staff.copy-<random> beside its final place and renamed to .planning/staff in one step: nothing is deleted, and a copy that fails part way never looks like a staff project"
    - "A person step signed on another device is carried under this device with the D-47 wording; the decision is chosen by fingerprint, never by name"
    - "A contested version carries no decision act at all; the note rides in the open request's dissent, which the decision queue shows"

key-files:
  created:
    - src/staff/replica/singleCopy.ts
    - src/test/staffReplicaCopy.test.ts
  modified: []

key-decisions:
  - "Carried wording follows the step: carriedApprovalName(name, copier, act) with act approved, rejected, released, withdrawn or superseded (default approved, so carriedApprovalName('P', 'C') is exactly the plan's string). Calling a carried rejection 'approved' would be dishonest (T-31-74)."
  - "Who is 'another person' is decided by device fingerprint: a person step whose fingerprint is this device's keeps its name; any other is carried. Today's ledger checks only the fingerprint (person-key), so this is the exact boundary."
  - "The 'contested at copy time' note lives in the open request's dissent of the contested version's submit (today's ledger has no free note field; the decision queue shows dissent beside the decision). Text: 'contested at copy time: in the shared project <names> decided this version at the same time, so the copy leaves the decision open.'"
  - "A contested version carries none of its decision acts, including any undisputed act before the dispute. Conservative: the copy can show less than the shared project, never more (D-35, P-31-30)."
  - "destination-inside-shared covers the shared project's folder and everything in it, not only its replica folder (P-31-31: the copy never writes inside the shared project). Paths are compared after resolving symbolic links."
  - "not-shared is returned when the folder has no project.json and when this computer has not joined the project; any other ReplicaProject refusal comes back as project-refused with that refusal's sentence."
  - "Every copied entry is signed at copy time (deps.now), not backdated to the entry's own time; the entry's 'at' keeps when the step was taken."
  - "Imported decision and calculator ledgers are verified again (every signature against its own key, ending at the import's head and count) before they are re-signed, so a copy never launders an entry the import does not vouch for. The wargame file must hash to the import's legacy head."

patterns-established:
  - "Make a Single-Machine Copy: refuse first, build every file in memory, self-verify the product ledger with replayLedger, then stage and rename, then write the head mark."

requirements-completed: [MUS-06]

duration: about 25 min
completed: 2026-11-20

actuals:
  tokens: 17900
  tasks: 3
  commits: 3
plan_head_before: 8cb7c6bde8874170de4a9d0bfc10203ebc817f56
plan_head_after: 61a62348f56d18ad7e8f4f252a39be9d18fe7d17
---

# Phase 31 Plan 22: Make a Single-Machine Copy Summary

**A shared staff project can now be folded back into today's single-machine files in a new folder, signed by this device, and today's own host and verifiers trust the copy. Other people's approvals and decisions are carried under the copier's key with "<Name> (approved in the shared project, carried by <Copier>)", a contested decision is never carried as decided, and the shared project is left byte for byte untouched.**

## Accomplishments

- `makeSingleMachineCopy(sharedRoot, destination, deps)`:
  - Refuses before anything is written: a destination at or inside the shared project (`destination-inside-shared`), a destination that already holds `.planning/staff` (`destination-has-staff-files`), a folder with no shared project this computer joined (`not-shared`), any other open refusal (`project-refused`).
  - Opens the shared project read-only through `ReplicaProject.open` and `projectionInputOf` (its `state()` is the only input).
  - Product ledger: a product shown from the import (31-19) is carried from the imported ledger's own entries; a product the shared project made is carried from the fold's versions family in the fold's total order, as the projection reads it. The entries are chained from `LEDGER_GENESIS` with `entryDigest`, signed with purpose `staff-ledger`, and self-checked with `replayLedger` before anything is written.
  - Product files: `projectProductFile` over the copy's own ledger state and the fold's live text. A product the copy could not carry keeps its text as a file with no header (today's host reads it as not yet proposed) and is listed in `differs`.
  - Decision log and calculator ledger: re-verified from their imports, then chained again and signed by this device (`staff-decision`, `staff-ledger`). The wargame ledger comes across byte for byte.
  - Writes into `.planning/staff.copy-<random>` then renames it to `.planning/staff`, then stores the signed `staff-ledger-head` mark under `ledgerHeadKey(destination)`.
  - Returns `{ ok, destination, written, carried, contested, differs, left, notices }`. `notices` is `multiUserNoticeLines()`.
- `carriedApprovalName`: at most 120 characters, the carried name shortened first, line breaks and control characters flattened, surrogate pairs never cut.

## Task Commits

1. **Task 1 (tracer): copy that today's host verifies:** `e3b4ca12` (feat). Tracer gate: the verify was re-run end to end (2 of 2) before expansion, and a mutation (head mark not written) made both tests fail.
2. **Task 2: carried approvals, contested at copy time, refusals:** `a20010db` (feat)
3. **Task 3: decisions, calculator and wargame:** `61a62348` (test)

## Test results

Every run used the shared flock lock and the memory cap (`MemoryMax=4G`, `--max-old-space-size=1536`). Each compile ran `tsc -p tsconfig.json` (with `vendor-libs` first) and exited 0.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1 verify: staffReplicaCopy | 2 | 2 | 0 |
| Task 2 verify: staffReplicaCopy | 8 | 8 | 0 |
| Task 3 verify: staffReplicaCopy + staffReplicaMigration | 35 | 35 | 0 |
| Final focused: every dist/test/replica*.test.js and staffReplica*.test.js (38 files) | 629 | 629 | 0 |

The full `npm test`, e2e and `verify:release` were not run; the orchestrator runs them once at the end.

**Mutation checks** (compiled `dist/` only, restored from a saved copy each time, and the final run used a fresh compile):

| Mutation | Tests that failed |
|----------|-------------------|
| The head mark is not written | tracer, untouched |
| Contested versions carry their decisions | contested |
| A person on another device keeps their own name and fingerprint | carried |
| The destination check is skipped | destination-inside-shared, destination-has-staff-files |
| Imported decision, calculator and wargame ledgers are never carried | decisions, calculator, host-equality |

**Acceptance greps:** `entryDigest` in singleCopy.ts: 4 (at least 1). `approved in the shared project` in singleCopy.ts: 2 (at least 1). `replayPersonDecisions` in the test: 3 (at least 1). Tests in the file: 11 (at least 2, 7, 9); names include "carried" and "contested". Em-dashes in both files: 0.

## TDD Gate Compliance

The tests and the module were written in the same working session per task, so there are no separate RED commits. RED evidence is the mutation table above: each guard, when disabled, fails the named tests.

## Decisions (defaults taken, owner asleep)

The plan had no checkpoint. All choices are in `key-decisions` above. The planning choice A14 / D-47 (carried name in the copier's entry) was implemented as recorded.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2: Missing critical functionality] Imported decision and calculator ledgers are re-verified before re-signing**
- **Issue:** re-signing under the copier's key turns whatever is carried into something today's verifier trusts. An entry the import does not vouch for must never be laundered that way.
- **Fix:** `verifiedImport` replays each imported file with today's function (every signature against its own key) and requires the import's head and count; the wargame file must hash to the legacy head. A ledger that fails is listed in `left` and not carried.
- **Files:** src/staff/replica/singleCopy.ts. **Commit:** e3b4ca12

**2. [Rule 2] The copy self-verifies and is staged, then renamed**
- **Issue:** the plan asks for an atomic write and no partial copy on refusal. A copy that failed between files would otherwise leave a half staff project.
- **Fix:** `replayLedger` checks the built product ledger before any write; the files go to a staging folder that is renamed to `.planning/staff` in one step. Nothing is deleted.

**3. [Rule 2] `destination-inside-shared` covers the whole shared project, not only its replica folder** (P-31-31). Tested with the replica folder, a subfolder and the project folder itself.

**4. [Additions] `differs`, `left`, `destination` in the result, `CopyDeps.copier`, the optional `act` of `carriedApprovalName`, and a fourth refusal `project-refused`**
- `differs`: products whose shared history today's ledger cannot show step by step (for example disagreeing concurrent verdicts). Their text is still written.
- `left`: imported ledgers that were not carried, with the reason.
- `copier`: the name and role the carried wording uses.

### Test fixture notes

- The Task 2 shared project is built with two installs and `ReplicaProject` (the lead P founds it; C joins by invite, join, admit and welcome; P's entries and blobs are delivered with `ingestForeign`). The lead needs `agentSeats` for the guard's verdict (D-12) and a roster `name` (the genesis lead name is not the roster member name; 31-18 noted this).
- The contested case: C rejects after seeing the submit, P approves without seeing C's reject; the fold reports `contested`.

## Known Stubs

None that block the plan's goal. Documented limits:
- **Not carried:** the files no replica kind covers yet (registers, calculator record files, gate reports, proposals, settings, observations) and `events.jsonl`. A copy's calculator ledger therefore names records whose files are not in the copy, so today's calculator check holds those numbers until a person copies `.planning/staff/calculator/` across. 31-23's command should say so, or copy those files.
- **Contested versions** lose any undisputed decision made before the dispute (see key-decisions).
- **Decisions made natively in a shared project:** none exist in Phase 31 (the decision log is carried from its import only). When Phase 33 adds them, this file needs a fold source for them.
- The `left` path (an import that does not verify) has no test: a tampered import is refused by the fold before it reaches the copy, so it cannot be built honestly in a test. The guard itself was mutation-checked.

The broken-windows ledger (`gsd_run windows append`) was not run; the brief keeps gsd-tools state commands with the orchestrator. The items above are the entries to record.

## Threat Flags

None beyond the plan's register.
- **T-31-74:** carried under the copier's key with the D-47 wording; the carried test checks every envelope's signer.
- **T-31-75:** a contested version is never approved in the copy; tested.
- **T-31-76:** destination checks before any write; byte and secret comparison before and after a copy, and after each refusal.
- **T-31-SC:** no package was installed.

## Next Phase Readiness

- **31-23 (command):** call `makeSingleMachineCopy(root, chosenFolder, { ...replicaDeps, copier: { name, role } })`. Show `result.notices`, the `contested` list ("contested at copy time"), `differs` and `left`, and a refusal's `message` as is. Mention the files that are not carried.

## Self-Check: PASSED

- FOUND: src/staff/replica/singleCopy.ts, src/test/staffReplicaCopy.test.ts
- FOUND commits: e3b4ca12, a20010db, 61a62348 (ancestors of HEAD)
