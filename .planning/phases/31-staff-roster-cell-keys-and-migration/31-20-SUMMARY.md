---
phase: 31-staff-roster-cell-keys-and-migration
plan: 20
subsystem: staff-replica
tags: [replica, membership, invite, join, safety-code, welcome, dominance, rekey, deputy, handover, roster-split, security-docs, tdd]
status: complete

requires:
  - phase: 31-14
    provides: member, device and invite kinds in the roster fold (inviteAt, device.add with forMember, device.revoke and the last-lead-device rule)
  - phase: 31-15
    provides: planRekey, earlierEpochGrants, sealLabel and openLabel, REKEY_KEEP_TEXT, granteesAt and epochsAt
  - phase: 31-16
    provides: buildInvite, readInvite, buildJoinRequest, checkJoinRequest, inviteSafetyCode, inviteAnchor, the welcome file
  - phase: 31-17
    provides: deputy.name, lead.handover, roster splits and roster.choose
  - phase: 31-18
    provides: ReplicaProject (createSharedProject, pinAnchor, localDevice, joinFromWelcome, appendOwn, putGrants, welcomeFor, state), keyring.ts join secrets, multiUserNoticeLines
provides:
  - "src/staff/replica/membership.ts: MEMBERSHIP_REFUSALS, MembershipResult, OpenWelcomeResult, SharedProjectHost, INVITE_DEFAULT_DAYS, inviteToProject, addMyOtherMachine, voidInvite, joinFromInvite, openWelcome, reviewJoinRequest, admitJoinRequest, removeFromProject, updateMember, chooseRosterBranch, nameDeputy, handOverLead, cellOrderHook"
  - "SECURITY.md ### Invitations, join secrets and the safety code"
affects: [31-21, 31-22, 31-23, 32, 33]

tech-stack:
  added: []
  patterns:
    - "Every flow checks everything before its first write (writer, split, invitation standing, secret, keys of every cell to grant, labels of every cell to rekey), then confirms the roster applied its entry and answers with the fold's own sentence if it did not"
    - "Clearance is decided by the writing host at write time with Phase 70 dominates, the host clock and the project's scale table; the label comes from a grant opened with a key this device holds"
    - "Rekey plans are computed before the change entry is written; one cell.rekey per plan with recipients, key and founding grant stored before the entry that commits to them"

key-files:
  created:
    - src/staff/replica/membership.ts
    - src/test/staffReplicaMembership.test.ts
  modified:
    - SECURITY.md

key-decisions:
  - "The flows take a SharedProjectHost { project, deps, scales?, mappings? } instead of a bare ReplicaProject: ReplicaProject keeps its deps private (secret storage for join secrets, the clock), and dominance needs the project's scale table. Absent scales are the shipped presets with no mapping"
  - "Invitations are made only on the device that founded the project (refusal not-founding-device). The 31-16 invite names its signer as the lead the joiner pins, and the joiner's roster fold requires that to be the genesis anchor's device, so an invitation from any other device (the deputy, the lead's second machine, a lead after a handover) would make a join that never folds. Admission is checked on the computer that holds the join secret, which is the same device (refusal no-join-secret elsewhere)"
  - "reviewJoinRequest added: the lead must see the six words before confirming they matched, so the command needs a read-only step that runs every check and returns the words; admitJoinRequest then refuses unless codeMatched is exactly true, checked before anything is read"
  - "A member with no declared clearance (only the founding lead: the genesis names none) is cleared for the cells one of its devices already holds, so the lead is never dropped from a cell it founded and the lead's other machine gets the lead's cells"
  - "A labelled cell whose label this device cannot open clears nobody at admission (fail closed). On removal or revocation it keeps its current grantees minus the removed devices (the signed grant is the authority for who is on a cell), and the new founding grant then carries no label; a clearance change for a member who holds such a cell is refused no-grant-key before anything is written. This keeps the deputy able to revoke a lost lead's device even when the lead holds cells the deputy cannot read"
  - "A rekey plan with no recipients is not written (31-15 carry-over); the result says 'Nobody else is on one part of the project, so no new key was made for it.'"
  - "Any roster change other than roster.choose is refused roster-split while a split is pending, so a flow never widens a split"
  - "member.admit takes the name, seat, roles and clearance the lead declared in the invitation (D-13), not the name in the join request; a member id is made (mbr- and 8 hex) unless the caller gives one; the slot is the smallest never given"
  - "Add My Other Machine invitations carry the member's seat and clearance, or the placeholders other-machine and org/Public for the lead who has none; device.add ignores both and the schema requires them"
  - "A crash between the admission and the welcome is resumed: a used invitation whose secret is still kept and whose admitted device is the requester's is not refused invite-used; the missing grants are written and the welcome is built"
  - "cellOrderHook(options) gives the host ReplicaProjectDeps.cellOrder from Phase 70 dominance (31-15 and 31-18 carry-over): the base cell is lowest, a cell cites another only when its label dominates, an unreadable label answers no. replicaProject.ts was not edited"
  - "A welcome over the 8 MiB cap (31-16 carry-over) returns welcome-too-large after the admission stands, with a plain sentence"

requirements-completed: [MUS-04, MUS-05]

coverage:
  - id: D1
    description: "Two installs invite, join, review the same six words, admit with the words confirmed, and open the welcome; the joiner's own project shows its slot, base key and the lead's roster head; the join secret is forgotten and every other secret kept"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/staffReplicaMembership.test.ts (Task 1, tests 1 to 4)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Admission grants every epoch of the cells the declared clearance dominates and nothing else; cellOrderHook"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/staffReplicaMembership.test.ts (Task 1, tests 5 and 6)"
        status: pass
    human_judgment: false
  - id: D3
    description: "code-not-confirmed, invite-expired on both sides, invite-used, invite-voided with the secret forgotten, wrong-secret with the secret kept, unknown-invite, folder-has-staff-project, not-a-roster-writer, Add My Other Machine, no secret in any result"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/staffReplicaMembership.test.ts (Task 2, 9 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Remove a member, revoke a device, lower and raise a clearance: rekey with the agreed sentence, earlier epochs on a raise, the lead's refusals, an empty plan not written, no-grant-key"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/staffReplicaMembership.test.ts (Task 3, 7 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Roster split by two lead devices resolved by the lead; the deputy revokes the lead's only device and resolves a split; deputy and handover rules; SECURITY.md subsection"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/staffReplicaMembership.test.ts (Task 4, 4 tests)"
        status: pass
    human_judgment: false

actuals:
  tokens: 27718
  tasks: 4
  commits: 5
plan_head_before: bd94109cdd618e807bece173a05241fc50f5d6f6
plan_head_after: 15bdc3f11c9f7b5fb63d182db02538595bc4ba31

duration: 26min
completed: 2026-11-20
---

# Phase 31 Plan 20: Membership flows Summary

**Joining a shared staff project now works by three files and six spoken words. Every wrong invitation is refused in a sentence that says what to do next. Removing someone, revoking a device or lowering a clearance moves the affected cells to new keys with "They keep what they already received. They will not receive anything new." The lead and the deputy can resolve a roster split, name a deputy and hand over the lead.**

## Performance

- **Started:** 2026-11-20T05:40Z (reading); first code 05:52Z
- **Completed:** 2026-11-20T06:07Z
- **Tasks:** 4 of 4
- **Files:** 3 (2 created, 1 modified)

## Accomplishments

- **Invite (D-14, D-18):** `inviteToProject` writes `member.invite` with the sha256 of a fresh 32-byte secret, then keeps the secret in secret storage, then returns `inv-<id>.near-staff-invite` (open 7 days by default). `addMyOtherMachine({ member })` makes the short invitation for an existing member. `voidInvite` writes `invite.void` and forgets the secret only after the roster applied it.
- **Join (D-15, D-16):** `joinFromInvite(root, deps, inviteText, { name })` reads the invitation and refuses a folder holding today's staff ledgers or another shared project before anything changes. It then pins the genesis, makes or reuses this install's keys, and returns `join-<id>.near-staff-join` with the six words.
- **Admit (D-16, D-22, D-45):** `reviewJoinRequest` runs every check and shows the six words, writing nothing. `admitJoinRequest(host, text, { codeMatched, agentSeats?, member? })`:
  - refuses unless `codeMatched === true`;
  - checks the slot, member id and every key it will need before writing;
  - writes `member.admit` (or `device.add`) at the smallest slot never given;
  - grants every epoch of every cell the declared clearance dominates (Phase 70 `dominates`, host clock, project scales);
  - forgets the join secret;
  - returns `welcome-<id>.near-staff-welcome` for that device alone.
- **Welcome:** `openWelcome(root, deps, welcomeText)` joins through `ReplicaProject.joinFromWelcome` and returns the opened project.
- **Rekey (D-23):** `removeFromProject` (member or one device) and `updateMember` (a lowered clearance) compute `planRekey` before writing the change. Then, for each plan with recipients, they make a new epoch key, store it and its founding grant (label sealed again), and write `cell.rekey` at the head. A raised clearance grants every epoch of the newly cleared cells.
- **Authority (D-09, D-10):** `chooseRosterBranch`, `nameDeputy` and `handOverLead` each mirror the fold's rule before writing and answer with the roster's own sentence.
- **Notices (D-13):** every result carries `multiUserNoticeLines()`.
- **SECURITY.md:** `### Invitations, join secrets and the safety code` inside the multi-user section.

## Task Commits

1. **Task 1 (tracer): invite, join, admit, welcome, dominance:** `c0d0cc76` (feat). Tracer gate: the verify was re-run after the commit (6 of 6) before expanding.
2. **Task 2: refusals, Add My Other Machine, void:** `10968a3c` (test)
3. **Task 3: remove, revoke, clearance, rekey:** `1628d2ba` (test)
4. **Task 4: split, deputy, handover, SECURITY.md:** `f3123a3c` (docs)
5. **Fix:** `15bdc3f1` (test): three em-dash checks written as escapes instead of the literal character.

## Test results

Every run went through the shared flock lock and the memory cap (`MemoryMax=4G`, `--max-old-space-size=1536`), compiling with `tsc -p tsconfig.json` (exit 0).

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1: staffReplicaMembership (and the tracer gate re-run) | 6 | 6 | 0 |
| Task 2: staffReplicaMembership | 15 | 15 | 0 |
| Task 3: staffReplicaMembership, replicaCellKeys | 34 | 34 | 0 |
| Task 4: staffReplicaMembership, replicaRosterSplit, gateDocs, replicaCellLeak | 81 | 81 | 0 |
| Final focused: every `dist/test/replica*.test.js` and `staffReplica*.test.js` | 594 | 594 | 0 |
| After the em-dash fix: staffReplicaMembership | 26 | 26 | 0 |

staffReplicaMembership has 26 tests (the plan asked for at least 4, 12, 16, then 19). The full `npm test`, e2e and `verify:release` were not run; the orchestrator runs them at the phase end.

**Acceptance greps:** `dominates` in membership.ts 6; `code-not-confirmed` 2; `planRekey` 2; the SECURITY.md heading 1; em-dashes in SECURITY.md, membership.ts and the test 0. Test names include code-not-confirmed, invite-expired, invite-used, invite-voided and wrong-secret.

**Mutation checks** were made in the compiled `dist/` only, and the next compile restored it:

| Mutation | Tests failed |
|----------|--------------|
| No code confirmation check | 1 |
| Never forget the join secret | 3 |
| Dominance always true | 7 |
| No split check | 1 |
| No rekey written | 6 |
| Only the newest epoch granted | 1 |
| Lead may revoke its own last device | 1 |

Two mutations failed no test:
- **Removed devices kept in the cleared list.** This filter is redundant: `planRekey` already drops the named devices for a removal or revocation.
- **A member with no clearance cleared for every cell.** This is not observable in Phase 31: the lead cannot read the label of a cell it does not hold, and the lead holds every cell it can read.

## TDD note

The module was written in full with the Task 1 tests in the same session, so the first runs were green, apart from the SECURITY.md test, which waited for Task 4 (25 of 26 on the first full run). Tasks 2 to 4 are test commits over the module from Task 1, as in 31-18. RED evidence comes from the mutation table above. Each task's commit holds exactly the tests of that task, and each was compiled and run before it was committed.

## Decisions Made

All are listed in the frontmatter `key-decisions`. There was no checkpoint. Task 3 is rated costly to reverse; it took the plan's design unchanged.

**For the owner:**
- **Invitations only from the founding device** (see key-decisions). Lifting this needs the invite format to carry the pinned anchor separately from its signer, which would be a 31-16 format change.
- **The deputy cannot rekey a labelled cell it cannot read.** Its grantees are kept, and the new grant carries no label. A device holding an earlier epoch still reads the label from that epoch's grant.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2: Missing critical functionality] reviewJoinRequest**
- **Issue:** the plan's function list has no read-only step that shows the lead the six words before the lead confirms them, so the code-matched confirmation could not be honest.
- **Fix:** added `reviewJoinRequest`. Commit `c0d0cc76`.

**2. [Rule 2] Refusals beyond the planned list**
- `no-join-secret`, `not-founding-device`, `roster-split`, `no-split`, `not-a-branch`, `device-unknown`, `device-limit`, `welcome-too-large`, `change-not-applied` and `nothing-to-change`, each a plain sentence.
- Refusals the fold also makes (`lead-not-removable`, `last-lead-device`, `deputy-cannot-name-deputy`, `handover-not-allowed`, `names-the-lead`, `choose-not-allowed`, `lead-role-by-handover-only`, `member-exists`) use the roster's own sentence. Invitation-reading refusals outside the closed list (`malformed`, `bad-signature`, `bad-binding`, `wrong-device`, `wrong-project`, `too-large`) use `INVITE_REFUSALS`.

**3. [Rule 2] Result fields beyond the planned shape**
- `MembershipResult` also has `reason`, `granted`, `invite`, `member` and `writer`, so commands and tests can act on a result without parsing its sentence. `OpenWelcomeResult` adds `project`.

**4. [Rule 2] SharedProjectHost as the first argument** (see key-decisions).

**5. [Rule 1: Bug] Literal em-dashes in three test regexes**
- **Fix:** written as the escape `\u2014`. Commit `15bdc3f1`.

### Notes

- **Cells in tests:** cells are made with `cell.create` through `appendOwn` in the test (`createCell`, `unlabelledCell`). No host command makes a cell in Phase 31.
- **Syncing installs:** installs are synced by hand. Roster entries go through `welcomeFor(writer, [])` into `ingestForeign`, and grants are read from disk into `putGrants`, standing in for the Phase 32 transport.
- **Carry-overs closed:**
  - 31-15: the host builds the cell order (`cellOrderHook`), and an empty rekey plan is not written.
  - 31-16: a welcome over the cap returns a plain refusal.
  - 31-17: the deputy revokes all of the lead's devices end to end. The lead's own attempt on its last device is refused, and its second device can be revoked.
  - 31-18: the lead's display name can be set with `updateMember({ member: lead, name })`, and replicaProject.ts was not edited.

## Known Stubs

None. `cellOrderHook` is exported for the host, but nothing passes it to `ReplicaProjectDeps.cellOrder` yet. 31-21 or 31-23 wires it when the staff host opens a shared project.

## Threat Flags

None beyond the plan's register:
- **T-31-66:** admission is refused without `codeMatched === true`. Tested with false, undefined, 'yes' and 1.
- **T-31-67:** used and voided invitations are refused by host checks and the fold, and the secret is forgotten only after the roster applied the outcome.
- **T-31-68:** dominance is computed at write time, with per-epoch grants only to cleared devices. The M, N and Z test covers this.
- **T-31-69:** every affected cell is rekeyed. A removed device opens no new epoch, which is tested on M's and the revoked device's own installs.
- **T-31-70:** results, messages and file names were searched for the join secret, the MAC, the device and encryption keys and every cached epoch key.
- **T-31-SC:** no package was installed.

There is no new network endpoint. The three file kinds are the ones 31-16 defined, and SECURITY.md now documents them.

## Self-Check: PASSED

- FOUND: src/staff/replica/membership.ts, src/test/staffReplicaMembership.test.ts, the SECURITY.md subsection
- FOUND: commits c0d0cc76, 10968a3c, 1628d2ba, f3123a3c and 15bdc3f1 are ancestors of HEAD
