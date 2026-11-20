---
phase: 31-staff-roster-cell-keys-and-migration
plan: 14
subsystem: replica
tags: [replica, roster, members, devices, invites, hub, slots, quarantine]
status: complete

requires:
  - phase: 31-06
    provides: forkChosen and forkStanding accepting any branch of a fork slot, read through RosterView.chosenBranch
  - phase: 31-12
    provides: roster driver, ROSTER_KIND_OWNER, applyMemberEntry seam with ctx { position, lead, deputy? }, MembersState with releases and kind 'hub', replicaRosterWorld helper
provides:
  - "rosterMembers.ts: apply rules for member.update, member.remove, invite.void, device.add, device.rotate, device.revoke, device.quarantine, device.release, hub.admit, hub.grant, hub.revoke; member.admit completed"
  - "MEMBER_REFUSALS: invite-unknown, invite-exists, invite-expired, invite-voided, invite-used, invite-for-device, invite-wrong-member, member-exists, member-unknown, lead-role-by-handover-only, lead-not-removable, last-lead-device, slot-in-use, slot-out-of-range, device-limit, device-exists, bad-binding, device-unknown, hub-exists, hub-unknown"
  - "Queries: inviteAt(state, invite, position, at?) with an 'expired' standing from signed time; hubAt, hubCellsAt; hubSignerAt now requires the hub in force"
  - "MembersState.hubs (HubRecord versions with certPin, ceiling and granted cells)"
  - "src/test/replicaRoster.test.ts: 24 named tests for DESIGN 15.1 (except split and choose) and 15.2"
affects: [31-15, 31-17, 31-20]

actuals:
  tokens: 17865
  tasks: 4
  commits: 4
plan_head_before: 6cacd66f216763046e33ca50c9e1ac71eaf9f3a8
plan_head_after: 3e1ddb7a5940eff21ec7be1f86f62d4936d02d1e

tech-stack:
  added: []
  patterns:
    - "A change is a new version (from, until) so every query still answers at the cited roster (member.update, hub.grant)"
    - "Line builder in the test: next() moves the roster head; tryEntry() folds a single attempt on its own so a refused entry never splits the line"
    - "bareEntry: call the members module directly with only the fields it reads, for rules the driver cannot route yet (deputy signer) and for the 4095-slot loop"

key-files:
  created:
    - src/test/replicaRoster.test.ts
  modified:
    - src/domain/replica/rosterMembers.ts
    - src/test/replicaRosterTracer.test.ts

key-decisions:
  - "Invite expiry is a standing inviteAt answers for a given signed time (at past expiresAt gives 'expired'); the roster keeps no clock and no 'latest time' state, so a record-only entry can never change an answer"
  - "A reused invitation is told invite-used before expiry or invite-for-device, so a second admission is always invite-used, whatever member it names"
  - "device.add with an invitation requires the invitation's forMember to be the member named; a new-member or another member's invitation is invite-wrong-member (new reason)"
  - "device-limit counts every slot ever given (revoked included), so a project has at most 4095 devices in its life (D-41, P-31-19)"
  - "last-lead-device: the lead's last person device may not be revoked unless the signer's member is the deputy at the cited roster (D-09, D-48)"
  - "device.quarantine and device.release need a device the roster has had (device-unknown otherwise); a later release of the same slot replaces the earlier choice"
  - "Hub ids share the member namespace and are never given twice (member-exists, hub-exists); the hub device takes a slot like any device; hub.revoke ends the hub and its devices"

requirements-completed: [MUS-04]

coverage:
  - id: D1
    description: "Membership transitions of DESIGN 15.1 (none -> invited, join-requested -> active, active -> active, active -> removed, invited -> expired, invited -> cancelled) and the lead rules"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRoster.test.ts#15.1 (none) -> invited, 15.1 join-requested -> active, 15.1 active -> active, 15.1 active -> removed, 15.1 lead roles, 15.1 invited -> expired, 15.1 invited -> cancelled"
        status: pass
  - id: D2
    description: "Invitations single use, voidable, expired by signed time; Add My Other Machine"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRoster.test.ts#invite-used: a second member.admit; Add My Other Machine (D-18) (two tests)"
        status: pass
  - id: D3
    description: "Device transitions of DESIGN 15.2 with slots, binding, rotate, revoke, last lead device and the 4095 limit"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRoster.test.ts#15.2 (none) -> active, device refusals, slot-out-of-range and device-limit, 15.2 active -> rotated (two), 15.2 active -> revoked (two)"
        status: pass
  - id: D4
    description: "Quarantine and release through the main fold with the real roster view; hub member and checkpointSigner"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRoster.test.ts#15.2 active -> quarantined, 15.2 quarantined -> active, 15.2 quarantined -> revoked, the hub member, hub refusals, every members kind has its rule"
        status: pass

duration: 22min
completed: 2026-11-20
---

# Phase 31 Plan 14: Roster members, devices, invitations and the hub Summary

**The roster fold now applies every member, device, hub and invite kind: people are invited, admitted with seats, decision roles, clearance and agent seats, changed and removed; invitations expire by signed time, are voided and admit once (including Add My Other Machine); each device gets a never-reused slot from 1 to 4095 with its X25519 key bound by its own signature, and can be rotated, revoked, quarantined and released; and a hub member signs checkpoints only while it is in force. Every answer is given at the roster an entry cites.**

## Performance

- Started 2026-11-20T05:03Z (after reading the plan, context, research sections, DESIGN 7 and 15, and summaries 31-06 and 31-12), finished 05:18Z
- 4 tasks, 4 task commits plus this summary, 3 files changed (1 created, 2 modified)

## Accomplishments

- **Membership (DESIGN 15.1, D-10 to D-12):** `member.update` writes a new version with only the named fields changed, so the old roles, seats and agent seats still answer at the old roster and `roleWithdrawnBy` names the update; `member.remove` ends the member and every device of it from its position (slots stay given). Lead and deputy roles by admit or update are refused `lead-role-by-handover-only`; removing the lead is refused `lead-not-removable`.
- **Invitations (D-17, D-18):** `inviteAt(state, invite, position, at?)` answers open, used, voided, or expired for a signed time past the expiry, never a clock. `invite.void` closes an open invitation (a used one stays used). `member.admit` checks voided, then used, then a device invitation, then expiry by its own signed time. `device.add` adds a device for an existing member, directly or through a `forMember` invitation, which it then marks used.
- **Devices (D-19, D-20, D-41):** every new device (admit, `device.add`, `device.rotate`, `hub.admit`) passes one check: `device-limit` once 4095 slots were ever given, then the slot range, then slot reuse (even of a revoked device), then the Ed25519 signature over `x25519BindingBytes`. `device.rotate` ends the old writer at the rotation point and starts the new one there; `device.revoke` ends the device, except the lead's last device unless the deputy signs.
- **Quarantine and release (D-20, D-48):** `device.quarantine` applies and changes no state (the members state deep-equals the one without it); `device.release` records the kept branch for `chosenBranchOf`, and a fresh main fold through the real roster view admits the chosen third branch with its later entry and excludes the other two branches.
- **Hub (D-04, D-12):** `hub.admit` adds the hub (certPin, ceiling) and its device with a slot; `hub.grant` records a cell as a new version (`hubCellsAt`); `hub.revoke` ends the hub and its devices. `hubSignerAt` (behind `checkpointSigner`) is true only for a hub device whose hub is in force: a v2 checkpoint the hub signs verifies; one by a member device, or by the hub after its revoke, is refused `not-a-checkpoint-signer`.

## Task Commits

1. Task 1 (tracer): `6629568c` feat(31-14): member.update and member.remove at the cited roster, lead rules and the full refusal map
2. Task 2: `6ecec863` feat(31-14): invitations expire by signed time, can be voided and admit once; Add My Other Machine
3. Task 3: `66b0e347` feat(31-14): device slots never reused, X25519 binding, rotate, revoke and the last lead device
4. Task 4: `3e1ddb7a` feat(31-14): device.quarantine record only, device.release feeds chosenBranch, and the hub member

## Decisions

- One-way Task 3 (D-41): taken as planned. Slots are never reused and the limit counts every slot ever given, so a project has at most 4095 devices in its whole life.
- Tracer gate (Task 1): the verify was re-run end to end after the first green run (16 of 16) before expanding to Tasks 2 to 4.
- The deputy rule for `last-lead-device` is tested by calling `applyMemberEntry` with a ctx naming the signer's member as deputy, as the plan says; the driver routes deputy-signed entries only after 31-17 merges.
- See the frontmatter `key-decisions` for the expiry standing, the order of invitation checks, `invite-wrong-member`, release replacement and hub ids.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The tracer's pending-kind test listed kinds this plan applies**
- **Found during:** Task 1 (and again in Tasks 2 and 3)
- **Issue:** `replicaRosterTracer.test.ts` "a roster entry of a kind whose rule is not written yet is refused roster-kind-pending" listed `member.update`, `member.remove`, `invite.void` and `device.revoke`. Once their rules exist that test fails, and every task's verify runs it. The file is outside this plan's `files_modified`.
- **Fix:** removed exactly those four kinds from its pending list, each in the task that gave the kind its rule, and changed its owner-module assertion from `['cells', 'members', 'roster']` to `['cells', 'roster']` with a comment, because no members kind is pending any more. The remaining pending kinds (`cell.create`, `deputy.name`, `lead.handover`) are still checked to change no answer. The new test "every member, device, hub and invite kind has its rule: none is refused roster-kind-pending" in this plan's file covers the members side.
- **Merge note for the orchestrator:** 31-15 (`cell.create`) and 31-17 (`deputy.name`, `lead.handover`) must edit the same array, so the three branches will conflict on those adjacent lines. After all three merge, no kind is pending: the test then has no subject and should become "no routed kind is refused roster-kind-pending" (or be retired with the default branch it guards).
- **Files modified:** src/test/replicaRosterTracer.test.ts
- **Commits:** 6629568c, 6ecec863, 66b0e347

**2. [Rule 2 - Missing critical functionality] New refusal reasons beyond the planned list**
- **Issue:** the plan's closed list had no reason for a `device.add` naming another member's or a new-member invitation, or for a hub id given twice.
- **Fix:** added `invite-wrong-member` and `hub-exists` (plain sentences, no em-dash), each tested.
- **Commits:** 6ecec863, 6629568c (sentence), 3e1ddb7a (use)

**3. [Rule 1 - Bug] An em-dash literal in the new test**
- **Issue:** the em-dash check in the first commit had a literal character instead of the escape the tracer uses.
- **Fix:** written as `'—'`; folded into the Task 2 commit.
- **Commit:** 6ecec863

**Total deviations:** 3 auto-fixed (1 blocking, 1 missing functionality, 1 bug). **Impact:** one file outside `files_modified` was edited, in place and minimally; the merge with 31-15 and 31-17 needs a manual resolution of that one array.

### Notes

- Slot 0 or 4096 never reaches the members module through the fold: the wire schema (`deviceProblem`) refuses it at verification. The module's own `slot-out-of-range` is tested directly for 0 and 4096 and through the fold for a descriptor with no slot; the fold test also checks slots 0 and 4096 are refused without moving the head.
- Seams added in this module (no edit of `roster.ts`): `hubAt` and `hubCellsAt` for the hub's granted cells. Nothing in `RosterView` reads hub cells yet; a sender filter or 31-15 can read them through `roster.ts` later.
- A hub device is admitted (`isAdmitted` true) while its hub is in force, like any device; it cannot write the roster (`isRosterWriterAt` requires the lead's member, and the driver refuses non-person actors).
- TDD: each task's tests were written first and failed (Task 1: 4 of 6; Task 2: compile error, inviteAt had no time argument; Task 3: 5 of 17; Task 4: compile error, hubCellsAt missing), then passed. Mutation checks in `dist/` only: `chosenBranchOf` answering nothing, no `device-limit`, no `last-lead-device`, and reusable slots each failed 1 to 3 tests. Ignoring the device kind in `hubSignerAt` failed none, because that check is redundant: a person device can never belong to a hub id.

## Test Results

All runs under the shared flock lock and `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`, compiling with `node scripts/vendor-libs.mjs && tsc -p tsconfig.json` (exit 0).

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1: replicaRoster, replicaRosterTracer (and the tracer gate re-run) | 16 | 16 | 0 |
| Task 2: replicaRoster, replicaRosterTracer | 21 | 21 | 0 |
| Task 3: replicaRoster, replicaClientIds | 36 | 36 | 0 |
| Task 4: replicaRoster, replicaRosterTracer, replicaCheckpointHeads, replicaEquivocation | 64 | 64 | 0 |
| Plan verification: replicaRoster, replicaRosterTracer, replicaClientIds, replicaCheckpointHeads, replicaEquivocation | 82 | 82 | 0 |
| Every `dist/test/replica*.test.js` and `staffReplica*.test.js` | 500 | 500 | 0 |

The full `npm test` was not run (the orchestrator runs it at the end). The repo has no ESLint config; its lint is `tsc --noEmit`, clean through the compile.

Acceptance greps: replicaRoster has 24 tests; `test('15.1 ` 7; `test('15.2 ` 8; test names include invite-expired, invite-voided and invite-used; `invite-used` in rosterMembers.ts 4; `x25519BindingBytes` in rosterMembers.ts 3; `chosenBranch` in replicaRoster.test.ts 5; no `Date.now` or `new Date(` in rosterMembers.ts; no em-dash in any changed file.

## Known Stubs

- `applyMemberEntry` default branch still refuses `roster-kind-pending` for a kind routed to members with no rule; every routed members kind now has one, so the branch is a guard only.

## Threat Flags

None beyond the plan's threat register. T-31-40 (invite states and the signed-time expiry, Task 2 tests), T-31-41 (binding checked over `x25519BindingBytes`, two bad-binding cases), T-31-42 (slots never reused, range and limit), T-31-43 (lead-role-by-handover-only, lead-not-removable, last-lead-device), T-31-44 (checkpointSigner only for an in-force hub device; member-signed checkpoint refused) and T-31-SC (no package installed) are mitigated. No new endpoint, file access or network path.

## Self-Check: PASSED

- FOUND: src/test/replicaRoster.test.ts, src/domain/replica/rosterMembers.ts, src/test/replicaRosterTracer.test.ts
- FOUND: commits 6629568c, 6ecec863, 66b0e347, 3e1ddb7a are ancestors of HEAD
