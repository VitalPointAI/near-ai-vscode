---
phase: 31-staff-roster-cell-keys-and-migration
plan: 09
subsystem: replica
tags: [replica, kinds, schemas, roster, migration, signed-payload, contracts]
status: complete

requires:
  - phase: 31-05
    provides: project reducer refusing non-person actors (agent-cannot-decide), replicaKinds at 22 tests
  - phase: 31-07
    provides: versions reducer hardening (no direct use; wave order only)
  - phase: 31-08
    provides: PHASE_30_SECTIONS SHA-256 pins in replicaVectors.test.ts (left untouched and passing)
provides:
  - "LEGACY_FILE_MAX_BYTES = 2 MiB and isLegacyFile in kindSchemas/project.ts; project.import optional file (strict base64url, empty allowed) and mark (one line, at most 4096 characters)"
  - "ProjectImport.fileHash (sha256 hex of the decoded file, absent without a file) and ProjectImport.marked"
  - "deviceProblem exported from kindSchemas/project.ts, with the optional D-41 slot (1 to 4095); roster.ts imports it"
  - "project.genesis optional lead.device (writer must equal lead.writer), level (slug) and cells (at most 64 of { cell, epoch >= 1, grant }, each cell once)"
  - "member.invite forMember, member.admit agentSeats, member.update agentSeats (counted in its at-least-one rule), device.add invite, cell.create epoch and grant, cell.rekey grant"
  - "new roster kind invite.void { invite, rosterPrev }: 51 kinds, 18 roster kinds"
  - "PAYLOAD_PURPOSES gains staff-invite, staff-join-request, staff-cell-grant, staff-replica-mark (14 purposes)"
affects: [31-12, 31-13, 31-14, 31-15, 31-16, 31-17, 31-19, 31-20]

actuals:
  tokens: 14026
  tasks: 4
  commits: 4
plan_head_before: cceb466e11083984bea59e98ed3ab13bde83d547
plan_head_after: d6813e369b628701229d43b28e67a25cbd6b1d88

tech-stack:
  added: []
  patterns:
    - "Additive optional wire fields on closed schemas: every Phase 30 sample and vector stays valid; the later fold requires the field where a decision needs it"
    - "A check two family files share lives in project.ts (the file roster.ts already imports from), so there is no import cycle between family schema files"
    - "Output-only reducer fields: new import facts are listed in the family output but not in the digest tuple, so the Phase 30 digest form is unchanged"

key-files:
  created: []
  modified:
    - src/domain/replica/kindSchemas/project.ts
    - src/domain/replica/kindSchemas/roster.ts
    - src/domain/replica/kinds.ts
    - src/domain/replica/projectFold.ts
    - src/domain/team/signedPayload.ts
    - src/test/replicaKinds.test.ts
    - src/test/replicaTracer.test.ts
    - src/test/replicaContracts.test.ts
    - src/test/teamSignedPayload.test.ts

key-decisions:
  - "An empty legacy file is accepted (file is the empty text) so a present but empty ledger can still be imported"
  - "The project digest tuple stays (ledger, legacyHead, count, entry); fileHash and marked are output only"
  - "Duplicate agent seats and duplicate genesis cells are refused, like duplicate roles"
  - "cell.create epoch and grant are each optional on the wire, not tied together; the roster fold requires both"

requirements-completed: [MUS-04, MUS-05, MUS-06]

duration: 11min
completed: 2026-11-20
---

# Phase 31 Plan 09: Shared contracts for the roster and migration Summary

**The closed schemas now accept everything Phase 31 will write: a project.import can carry the whole legacy file and its signed head mark (listed by sha256 in the project output), the genesis can name the lead's device, level and first cells, the roster kinds carry device slots, agent seats, invite links and cell grants, a new `invite.void` kind brings the list to 51, and four new signing purposes exist for invites, join requests, cell grants and store marks.**

## Performance

- Started 2026-11-20T04:21:06Z, finished 2026-11-20T04:32Z (about 11 minutes)
- 4 tasks, 4 task commits, 9 files modified (none created)

## Accomplishments

- **D-31, D-49 import (Task 1, tracer):** `project.import` takes optional `file` (strict base64url of the whole legacy file, at most `LEGACY_FILE_MAX_BYTES` = 2 MiB decoded; the length is checked before any decoding) and optional `mark` (one line, at most 4096 characters, the product ledger's `staff-ledger-head` envelope as today's host stores it). The project reducer lists `fileHash` (sha256 hex of the decoded bytes, computed with `node:crypto`) and `marked`. The de-duplication key (ledger, legacyHead, count) is unchanged, so the first import in fold order is the one listed. The tracer test writes a 300 KB file; `buildEntry` moves the body into one sealed blob, the fold verifies it, and the output lists the right hash. Without the blob the entry is held `missing-blob`.
- **D-07, D-41, D-49 genesis (Task 2):** `deviceProblem` moved from `roster.ts` to `project.ts` (exported, with the X25519 and signature size constants and `isExactBytes`) and gained the optional `slot` (checked with `isSlot` from `clientIds.ts`, 1 to 4095). `project.genesis` allows `lead.device` (whose writer must equal `lead.writer`, refused at `data.lead.device.writer`), `level` (slug) and `cells` (at most 64 of `{ cell, epoch, grant }`, epoch at least 1, grant a 64-hex hash, each cell once). `project.ts` imports `../entry` and `../clientIds`, both already hub-side, and never imports `roster.ts`.
- **D-12, D-17, D-18, D-44, D-49 roster (Task 2):** `member.invite.forMember`, `member.admit.agentSeats` and `member.update.agentSeats` (at most 16 slugs, no duplicates; `agentSeats` alone is enough for an update), `device.add.invite`, `cell.create.epoch` and `.grant`, `cell.rekey.grant`, and the new shape `invite.void: { invite, rosterPrev }`. The slot rides in the device descriptor, so `member.admit`, `device.add`, `device.rotate`, `hub.admit` and the genesis `lead.device` all carry it the same way. `kinds.ts` adds `'invite.void'` at the end of the roster family. The roster.ts comment reads "The 18 roster kinds" and lists each addition and its decision.
- **Pinned counts (Tasks 2 and 3):** replicaKinds 20 samples, 18 roster kinds, 51 kinds (the test now also asserts `REPLICA_KINDS.length` and the set size are 51, and its family regex includes `invite`); replicaTracer 51 (title and both assertions); replicaContracts 48. Every pin is an exact value.
- **D-49 purposes (Task 4):** `PAYLOAD_PURPOSES` appends `staff-invite`, `staff-join-request`, `staff-cell-grant`, `staff-replica-mark`. Each has a realistic sample (whole numbers only, fictional key bytes) shaped like 31-RESEARCH.md describes. A new test signs each with an agent-style key, verifies it, refuses it `wrong-purpose` under each of the 13 other purposes, refuses an edited purpose field `bad-signature`, and refuses an old `staff-ledger-head` and `staff-replica` signature offered as a new purpose. No other test pins the purpose list (searched `src/test`).

## Task Commits

1. Task 1 (tracer): `407c56a4` feat(31-09): project.import carries the whole legacy file and its head mark
2. Task 2: `d7c0a29d` feat(31-09): genesis and roster schema additions and the invite.void kind
3. Task 3: `f9c9e0da` test(31-09): pin the closed kind list at 51 and the non-doc kinds at 48
4. Task 4: `d6813e36` feat(31-09): four signed-payload purposes for invites, join requests, cell grants and store marks

Each commit holds its tests and its code together.

## TDD evidence

- **Task 1 RED:** tsc reported the missing `LEGACY_FILE_MAX_BYTES` export and the missing `fileHash` and `marked` on `ProjectImport`; the emitted tests ran 26, 22 passed and the 4 new ones failed. GREEN: replicaKinds plus replicaVectors 38 of 38. Tracer gate: the Task 1 verify was run again end to end and passed before Task 2 started.
- **Task 2 RED:** the new tests were compiled against the pre-Task-2 `project.ts`, `roster.ts` and `kinds.ts` (taken from the Task 1 commit, then restored byte for byte). 6 of 28 failed: the two new D-49 tests, the 20-sample and 18-roster-kind tests, the kept-roster-entries test (invite.void was an unknown kind there) and the 51-kind test. GREEN: replicaKinds, replicaBoundaries and replicaVectors 46 of 46.
- **Task 3:** a pin change only; replicaTracer 10, replicaContracts 17 and replicaKinds 28 all pass, with the test counts the plan expects.
- **Task 4 RED:** tsc refused the four new sample keys and purpose names; 2 of 23 failed (the round-trip test with the exact list and the new wrong-purpose test). GREEN: teamSignedPayload 23, teamBoundaries 9, staffRelease 13, all passing.

## Test results

All runs used the shared flock lock and the systemd-run memory cap. `npm run lint` exited 0 and `tsc -p tsconfig.json` exited 0.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1: replicaKinds, replicaVectors | 38 | 38 | 0 |
| Task 2: replicaKinds, replicaBoundaries, replicaVectors | 46 | 46 | 0 |
| Task 3: replicaTracer, replicaContracts, replicaKinds | 10 + 17 + 28 | 55 | 0 |
| Task 4: teamSignedPayload, teamBoundaries, staffRelease | 23 + 9 + 13 | 45 | 0 |
| Final: every `dist/test/replica*.test.js` (23 files) plus teamSignedPayload, teamBoundaries, staffRelease, staffLedgerIntegrity | 428 | 428 | 0 |

No `staffReplica*.test.js` file exists on this branch yet (31-11 creates it). The full `npm test` was not run, as the brief says; the orchestrator runs it.

replicaKinds.test.js has 28 tests (22 after 31-05; 6 new). teamSignedPayload.test.js has 23 (22 before).

Acceptance greps: `LEGACY_FILE_MAX_BYTES` in project.ts 3 lines; `fileHash` in projectFold.ts 5; `invite.void` in kinds.ts 1; `export function deviceProblem` in project.ts 1; `REPLICA_KINDS.length, 51` in replicaTracer 1; `others.length, 48` in replicaContracts 1; `staff-replica-mark` in signedPayload.ts 1; `staff-cell-grant` in teamSignedPayload.test.ts 4.

## Canonical vectors

No canonical byte changed. The 31-08 SHA-256 pins of the Phase 30 vector sections (`PHASE_30_SECTIONS` in replicaVectors.test.ts) were not touched and pass in every run above. Reasons:
- Every new field is optional, so no existing sample or vector entry changes.
- The project reducer's digest form (`canonical`) still lists each import as (ledger, legacyHead, count, entry). The entry hash already commits to the file and the mark, so adding `fileHash` or `marked` to the digest would only change every digest of a project with an import. A test pins this form.
- `invite.void` is appended at the end of the roster family, so the order of every existing kind in `REPLICA_KINDS` is unchanged.

## Decisions

No checkpoint in this plan. Both one-way tasks (1 and 2) were taken as written (D-31, D-49). Choices made inside the plan's words:
- **Empty legacy file accepted.** `file: ''` is valid (the whole of an empty file), so 31-19 can import a ledger file that is present but empty without a special case. Its `fileHash` is the sha256 of no bytes. Any other value must be strict base64url of 1 byte to 2 MiB.
- **Mark limit 4096 characters, one line.** A newline, a control character, leading or trailing space, an empty text or a non-string is refused at `data.mark`. Today's head mark (a `staff-ledger-head` envelope written with `JSON.stringify`) is a few hundred characters.
- **Duplicates refused.** A repeated agent seat is refused at `data.agentSeats[i]` and a repeated genesis cell at `data.cells[i].cell`, matching how roles are already checked.
- **`cell.create` epoch and grant are independent optional keys.** The plan lists them as optional; the roster fold (31-12, 31-14) requires both. Tying them together on the wire would add a rule the fold already enforces.
- **Where `invite.void` sits in the list:** last in the roster family, so no existing index moves.

## Deviations from Plan

None in behaviour. Two small points:
- **Extra tests beyond the plan's behaviour list:** a clone test for the import fields (the incremental and fresh folds must agree, as for 31-04 and 31-07 counters), a both-delivery-orders check, and a test that pins the unchanged digest tuple. The tracer test also checks the hold when the blob is missing.
- **Comment wording:** the kinds.ts and signedPayload.ts comments avoid repeating the literal kind and purpose names, so the plan's exact `grep -c` acceptance counts (1) hold.

## Issues Encountered

- In the first Task 1 GREEN run one new test failed because of the test, not the code: it folded the lead's second import without the first import in the same writer chain, so the second was held `missing-predecessor`. The test now writes that case on the lead's other device (L2). No production change was needed.

## Known Stubs

None.

## Next Phase Readiness

- WP-R1 (31-12, 31-14 to 31-17) can build the roster fold against fixed schemas: device slots, agent seats, `forMember`, the `device.add` invite, cell epochs and grants, `invite.void`, and the genesis `lead.device`, `level` and `cells`.
- WP-R2 (31-13, 31-19) can write imports with `file` and `mark` and find them by `fileHash`; 31-13 can sign marks with `staff-replica-mark`.
- The roster fold must require the optional fields where D-41, D-44 and D-49 need them (for example a slot on every admitted device and `lead.device` on the pinned genesis). The wire allows them to be absent only so Phase 30 data stays valid.

## Self-Check: PASSED

- All 9 modified files exist and are committed; `git status` is clean apart from this summary before its commit.
- Commits 407c56a4, d7c0a29d, f9c9e0da and d6813e36 are ancestors of HEAD.
