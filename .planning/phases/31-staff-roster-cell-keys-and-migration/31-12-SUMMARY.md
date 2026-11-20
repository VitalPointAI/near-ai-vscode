---
phase: 31-staff-roster-cell-keys-and-migration
plan: 12
subsystem: replica
tags: [replica, roster, cell-keys, x25519, invite, safety-code, tracer]
status: complete

requires:
  - phase: 31-01
    provides: optional RosterView members (canRunAgent, clientIdOwner, deviceEncryptionKey, cellGrantees, rosterBranchPending), clientIds.ts
  - phase: 31-04
    provides: foreign-client-id refusal through RosterView.clientIdOwner
  - phase: 31-09
    provides: genesis lead.device and cells, device slot, agentSeats, invite.void, the staff-invite, staff-join-request and staff-cell-grant purposes
provides:
  - "roster.ts: RosterAnchor, ORIGIN_ROSTER, ROSTER_KIND_OWNER, ROSTER_REFUSALS, RosterFoldInput, RosterState, foldRoster, rosterView, leadAt, deputyAt, isRosterWriterAt"
  - "rosterMembers.ts: MembersState, createMembersState, applyGenesisLead, applyMemberEntry, MEMBER_REFUSALS, memberAt, deviceAt, deviceKeyOf, devicesOfMemberAt, seatsAt, slotOwnerAt, x25519At, inviteAt, chosenBranchOf, hubSignerAt"
  - "rosterCells.ts: CellsState, createCellsState, applyGenesisCells, applyCellEntry, addGrant (GrantPlacement), CELL_REFUSALS, epochAt, granteesAt, cellOfStream, committedGrant"
  - "cellKeys.ts: importX25519Public, x25519PublicRaw, x25519PrivateFromSeed, x25519BindingBytes, CELL_WRAP_INFO, newEpochKey, wrapEpochKey, unwrapEpochKey, CellGrant, buildGrant, readGrant, grantHash"
  - "invite.ts: file extensions, InvitePayload, JoinRequestPayload, buildInvite, readInvite, joinMac, joinSecretHash, newJoinSecret, buildJoinRequest, checkJoinRequest, INVITE_REFUSALS"
  - "safetyCode.ts (safetyCode, safetyCodeText, SAFETY_CODE_WORDS) and safetyWords.ts (SAFETY_WORDS, SAFETY_WORDS_SHA256)"
  - "src/test/helpers/replicaRosterWorld.ts: rosterDevice, createRosterWorld (write, rosterEntry, grant, genesis, anchor, ringFor, foldRoster, ctxFor)"
affects: [31-14, 31-15, 31-16, 31-17, 31-20]

actuals:
  tokens: 32037
  tasks: 3
  commits: 4
plan_head_before: a93388dc3e06fe48f5f4edfd863a946b2a617e38
plan_head_after: 3117891a8cf9a7dffef0de6fabd925980733cd1a

tech-stack:
  added: []
  patterns:
    - "Two-pass fold: the roster stream folds alone from a pinned anchor; its view is then the main fold's RosterView"
    - "Kind routing table plus query functions: the driver never reads another module's records, so each wave-6 plan edits one file"
    - "Probe view: verifyEntry runs once per roster-stream body (hasRoster answers yes), and the driver checks the cited roster against the line itself"
    - "Records as position intervals (from, until) so every answer is given at the cited roster"

key-files:
  created:
    - src/domain/replica/roster.ts
    - src/domain/replica/rosterMembers.ts
    - src/domain/replica/rosterCells.ts
    - src/domain/replica/cellKeys.ts
    - src/domain/replica/invite.ts
    - src/domain/replica/safetyCode.ts
    - src/domain/replica/safetyWords.ts
    - src/test/helpers/replicaRosterWorld.ts
    - src/test/replicaRosterTracer.test.ts
    - src/test/replicaSafetyCode.test.ts
  modified:
    - src/test/replicaBoundaries.test.ts

key-decisions:
  - "One-way Task 1 taken as planned: X25519 + HKDF-SHA256 (salt = ephemeral public key, info = 'near-ai/cell-wrap/v1' NUL cell NUL epoch NUL writer) + AES-256-GCM with the info as associated data, 92-byte wire; grants signed as staff-cell-grant objects outside the streams; two-pass roster fold"
  - "Grants are signed with the constant replica time (REPLICA_SIGNED_AT), so a grant's hash depends only on its content and signer; authority comes from the roster"
  - "X25519 binding bytes: 'near-ai-vscode/device-x25519/v1\\n' + 32 raw key bytes + writer hex, signed by the device's Ed25519 key"
  - "A founding grant is the only grant at its founding roster: another grant there is grant-mismatch; any other grant counts from the position of the roster it names"
  - "Authority is checked at the head before split counting, so an entry from a device that may not write the roster can never split it"
  - "member.admit already enforces the invite (unknown, voided, used, forMember, expiry by signed time), member-exists, lead roles, device-exists, slot range and reuse, and the X25519 binding; 31-14 adds the tests and the remaining kinds"

requirements-completed: [MUS-04, MUS-05]

coverage:
  - id: D1
    description: "Tracer: genesis, invite file, join request, equal safety code, admit, grant opened, doc.update accepted through the real roster view"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaRosterTracer.test.ts#one doc.update from the new device is accepted by the main fold through the real roster view and attributed to its writer and member"
        status: pass
  - id: D2
    description: "foreign-client-id through the real roster view"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRosterTracer.test.ts#the same doc.client by the new device under a client id in the lead slot range is refused foreign-client-id through the real roster view"
        status: pass
  - id: D3
    description: "A wrap opens only for its device, cell, epoch and writer"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaRosterTracer.test.ts#a wrap opens only for the device it is addressed to: another private key, a changed cell, epoch or device id fails"
        status: pass
  - id: D4
    description: "Safety code: BIP-39 list pinned by sha256, frozen derivation, every input changes the code"
    requirement: MUS-05
    verification:
      - kind: unit
        ref: "src/test/replicaSafetyCode.test.ts"
        status: pass
  - id: D5
    description: "Kind routing contract, pending kinds refused with no answer changed, hub-side closure"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaRosterTracer.test.ts#a roster entry of a kind whose rule is not written yet is refused roster-kind-pending and changes no answer of the view, for each owner module"
        status: pass
      - kind: unit
        ref: "src/test/replicaBoundaries.test.ts#the hub-side closure, following type-only imports too, contains no replica file that is not hub-side"
        status: pass

duration: 14min
completed: 2026-11-20
---

# Phase 31 Plan 12: Roster tracer (WP-R1) Summary

**A lead can found a multi-user project, invite one person by file, compare the same six BIP-39 words on both screens, admit the person's device at slot 2 and grant it the base cell key, and that device's first edit is accepted by the main fold through the real roster view (and refused foreign-client-id under the lead's slot), with the seven pure modules split along the seams the wave-6 plans extend.**

## Performance

- Started 2026-11-20T04:43:44Z (after reading the plan, context, research and summaries 31-01 to 31-11), finished about 04:57Z
- 3 tasks, 4 commits (3 task commits and one test fix), 10 files created, 1 modified

## Accomplishments

- **Roster fold (`roster.ts`, D-08, D-44, Pattern 1):** position 0 is the origin roster (hash `ORIGIN_ROSTER` = `GENESIS_PREV`) holding only the anchor's lead and device; the pinned genesis takes position 1. The driver reads only roster-stream entries (stream = project id) whose kind `ROSTER_KIND_OWNER` routes, verifies each with `verifyEntry` against a progressive view, refuses for good a genesis that is not the pinned one (`not-the-pinned-genesis`), a genesis that does not name the anchor's lead device (`genesis-anchor-mismatch`), an agent or hub actor (`person-only`) and a body.roster that differs from rosterPrev (`roster-citation-mismatch`). Then it repeatedly takes the entries that cite the head: a signer that is not an admitted device of the lead at the head is refused `not-a-roster-writer` before candidates are counted; one candidate applies through its owner module; two or more are recorded in `pending` and none applies. After the line, every grant is read (`readGrant`) and placed by `addGrant` with the signer's authority and the admitted devices at the roster it names. `rosterView(state)` implements every required and optional `RosterView` member from module query functions only.
- **Members (`rosterMembers.ts`):** member, device and invite records as position intervals; genesis lead device (closes the origin version and opens one with slot 1 from position 1), `member.invite` and `member.admit` applied; every other member, device, hub and invite kind refused `roster-kind-pending`.
- **Cells (`rosterCells.ts`):** genesis cells found epoch 1 with their committed grant hash; grants placed (founding by commitment, others for an existing epoch from the roster they name; signer and recipients checked); `granteesAt` lists the current epoch's grantees admitted at the position; `cell.create` and `cell.rekey` refused `roster-kind-pending`.
- **Keys (`cellKeys.ts`, D-21):** the 92-byte wrap, X25519 import and seed helpers, binding bytes, signed grants and `grantHash`.
- **Invite (`invite.ts`, D-14 to D-17):** invite and join request payloads, `joinMac` (HMAC-SHA256 under the secret over canonical bytes, compared with `timingSafeEqual`), the X25519 binding check, and refusals `malformed`, `bad-signature`, `invite-expired`, `wrong-project`, `unknown-invite`, `bad-binding`, `wrong-secret`.
- **Safety code (`safetyCode.ts`, `safetyWords.ts`, D-16, D-49):** six words from the first 66 bits of a length-prefixed sha256 over the invite id, genesis hash and both devices' signing and X25519 keys; the join secret is never an input. The word list is the BIP-39 English list, generated from the scratchpad copy only after its sha256 matched `2f5eed53...dbda`, with a header naming the source URL and its MIT licence.
- **Test world (`replicaRosterWorld.ts`):** deterministic Ed25519 and X25519 devices, per-(stream, writer) chains, `rosterEntry`, `grant`, `genesis`, `anchor`, `ringFor`, `foldRoster` and `ctxFor`.
- **Boundaries:** `roster`, `rosterMembers`, `rosterCells`, `cellKeys` and `invite` are in `HUB_SIDE`; the closure test passes with no change to any module.

## Task Commits

1. Task 1 (tracer): `006902b8` feat(31-12): roster tracer from genesis to an accepted doc.update through the real roster view
2. Task 2: `94214a61` test(31-12): pin the safety code word list by sha256 and the derivation by a frozen value
3. Task 3: `423fad00` test(31-12): roster kind routing contract and hub-side boundary entries
4. Test fix: `3117891a` test(31-12): check the opened invite entry holds only the secret hash (the first check searched sealed entries, which never show plaintext)

## Seams for the wave-6 plans

- **31-14 (`rosterMembers.ts`):** `applyMemberEntry(state, entry, ctx)` with `ctx = { position, lead, deputy? }`; `position` is the position the entry takes when it applies (the cited roster is `position - 1`). Return `{ status: 'applied' }` or `{ status: 'refused', reason }`, and validate before changing anything (the driver does not roll back). Records end by setting `until`. `devices` keeps every version of a writer; `deviceKeyOf` reads the first. `slots` never shrinks. `releases` (for `chosenBranchOf`) and `kind: 'hub'` (for `hubSignerAt`) are in place with no writer yet. `MEMBER_REFUSALS` already holds the reasons the tracer's admit uses (31-14's list plus `invite-exists` and `invite-for-device`).
- **31-15 (`rosterCells.ts`, `cellKeys.ts`):** `applyCellEntry(state, entry, { position, roster })` and `addGrant(state, placement)` where `GrantPlacement` carries the grant, its hash, the position of its roster, `signerIsRosterWriter` and `admitted(writer)`; the signer and recipient rules already live in `addGrant`, so 31-15 needs no edit of `roster.ts`. `granteesAt` already takes an `admitted` filter (the view passes the members module's answer).
- **31-16 (`invite.ts`):** the refusal record and readers are in place; `safetyCode.ts` is not hub-side, so an `inviteSafetyCode` in the hub-side `invite.ts` that imports it would fail the closure test: keep it in a non-hub-side file or move the derivation behind a hub-side module.
- **31-17 (`roster.ts`):** `leads` and `deputies` are position histories (`leadAt`, `deputyAt`); `isRosterWriterAt` is the one authority check (driver and grants); `pending` and `rosterBranchPending` exist; `lead.handover`, `deputy.name` and `roster.choose` return `roster-kind-pending` in `applyOne`.

## Decisions

- One-way Task 1 (D-21, D-44): taken as planned, no alternative considered (owner asleep; defaults approved).
- Tracer gate (Task 1): the verify was re-run end to end after the first green run (tracer plus boundaries, 14 of 14) before expanding to Tasks 2 and 3.
- Base cell stream: the tracer's doc entries are in the project stream (base cell id = project id = roster stream, A1), so the joiner's key ring needs one key.
- See the frontmatter `key-decisions` for grant signing time, binding bytes, the founding-grant rule and authority before split counting.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug, found while designing] Re-opening bodies on every roster entry**
- **Issue:** verifying roster-stream entries against the strict progressive view holds every body that cites a roster not applied yet (`missing-roster`) after opening it, so a store that passes the whole base-cell stream would open each product entry once per roster entry.
- **Fix:** the driver verifies with a probe view whose `hasRoster` answers yes, so each body is opened once; it then checks the cited roster itself (the entry must cite the head and its device must be a roster writer there). Only `unknown-writer` holds are tried again, and that hold fails before any body is opened. `verifyEntry` itself is unchanged.
- **Files modified:** src/domain/replica/roster.ts
- **Commit:** 006902b8

**2. [Rule 2 - Missing critical functionality] Authority before split counting**
- **Issue:** counting every entry that cites the head as a candidate would let any admitted member split (and so freeze) the roster with one entry.
- **Fix:** entries whose signer is not a roster writer at the head are refused `not-a-roster-writer` before candidates are counted. Tested.
- **Commit:** 006902b8

### Notes

- The plan names the branch `feat/phase-31-12-roster-tracer`; the orchestrator dispatched this plan on `feat/phase-31-12-roster-fold`.
- 31-RESEARCH.md suggests a SECURITY.md dependency-notes row for the committed word list. SECURITY.md belongs to 31-13 in this wave (and 31-15 adds the cell key section in wave 6), so it is not touched here; the word list header carries the source and licence. Follow-up for the orchestrator: add one line for the BIP-39 list when SECURITY.md is next edited.
- TDD: Task 1's tests and modules were written together and went green on the first compile, so there is no separate RED run. Instead each guard was checked by mutation in the compiled `dist/` only (overwritten by the next compile): making every admitted device a roster writer failed the not-a-roster-writer test, and dropping the writer from the wrap info failed the wrap test (2 of 8 failed). For Task 2, dropping the length prefix in the safety code failed 3 of 5 tests.
- Cost note for the store plans: `foldRoster` re-reads only `unknown-writer` holds per roster entry applied, so its cost is about one body open per roster-stream entry plus a linear scan per roster entry.

## Test Results

All runs under the shared flock lock and `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`, compiling with `node scripts/vendor-libs.mjs && tsc -p tsconfig.json` (exit 0).

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1: replicaRosterTracer | 8 | 8 | 0 |
| Task 1 gate re-run: replicaRosterTracer, replicaBoundaries | 14 | 14 | 0 |
| Task 2: replicaSafetyCode | 5 | 5 | 0 |
| Task 3: replicaRosterTracer (10), replicaBoundaries, replicaKinds, replicaClientIds | 62 | 62 | 0 |
| Final: every `dist/test/replica*.test.js`, `staffReplica*.test.js` and teamSignedPayload | 475 | 475 | 0 |

The full `npm test` was not run (the orchestrator runs it at the end).

Acceptance greps: `export function foldRoster` in roster.ts 1; clock reads in roster, rosterMembers, rosterCells 0 files; non-comment "secret" in safetyCode.ts 0; the BIP-39 sha256 in safetyWords.ts 1; "MIT" in safetyWords.ts 1; the five hub-side module lines in replicaBoundaries.test.ts 5; replicaRosterTracer has 10 tests with names containing "doc.update" and "foreign-client-id"; no em-dash in any added file.

## Known Stubs

Intentional and owned by named plans (a pending kind is refused, never applied):

- `rosterMembers.ts` `applyMemberEntry` default branch: member.update, member.remove, device.*, hub.*, invite.void refused `roster-kind-pending` (31-14). `chosenBranchOf` answers undefined and `hubSignerAt` false until 31-14 writes releases and hubs.
- `rosterCells.ts` `applyCellEntry`: cell.create and cell.rekey refused `roster-kind-pending` (31-15).
- `roster.ts` `applyOne`: lead.handover, deputy.name and roster.choose refused `roster-kind-pending` (31-17); `deputies` stays empty until then.

## Threat Flags

None beyond the plan's threat register. T-31-30 (safety code bound to both devices' keys, the invite id and the genesis; tested), T-31-31 (HMAC with timingSafeEqual, wrong-secret tested), T-31-32 (wrap bound to cell, epoch and device; every substitution tested), T-31-33 (not-a-roster-writer at the head, pending kinds refused), T-31-34 (no secret in the code or the roster; guard grep and a test that reads the opened invite entry through the roster fold and finds only the hash) and T-31-SC (no package installed; the word list pinned by sha256) are mitigated. No new endpoint, file access or network path.

## Self-Check: PASSED

- FOUND: all 10 created files and the modified replicaBoundaries.test.ts
- FOUND: commits 006902b8, 94214a61, 423fad00, 3117891a are ancestors of HEAD
