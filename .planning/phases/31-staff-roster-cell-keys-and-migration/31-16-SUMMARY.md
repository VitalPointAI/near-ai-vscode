---
phase: 31-staff-roster-cell-keys-and-migration
plan: 16
subsystem: replica
tags: [replica, invite, join-request, welcome, safety-code, hostile-input]
status: complete

requires:
  - phase: 31-12
    provides: "invite.ts first version (buildInvite, readInvite, buildJoinRequest, checkJoinRequest, joinMac), safetyCode.ts, cellKeys.ts readGrant and grantHash, roster.ts foldRoster, the roster test world"
provides:
  - "invite.ts: INVITE_REFUSALS complete (11 reasons), readInvite and checkJoinRequest over file text or parsed values, JoinRequestExpectation (now, rosterInvite), RosterInviteState"
  - "invite.ts: Add My Other Machine (InvitePayload.forMember, JoinRequestPayload.member covered by the MAC, wrong-device)"
  - "invite.ts: inviteSafetyCode(invite, joinerKeys), SafetyCodeKeys, inviteAnchor(invite)"
  - "invite.ts: WelcomeFile, BuildWelcomeInput, buildWelcome, readWelcome (WelcomeRead with entries ready for foldRoster), WELCOME_MAX_BYTES, WELCOME_VERSION"
  - "src/test/replicaInvite.test.ts (19 tests)"
affects: [31-18, 31-20, 31-23]

tech-stack:
  added: []
  patterns:
    - "File readers take JSON text (byte-capped before JSON.parse) or a parsed value (capped by canonical size), read own properties only and return fresh objects"
    - "Lead-side checks take the roster's invite state as input so a command refuses before writing; the fold stays the authority"

key-files:
  created:
    - src/test/replicaInvite.test.ts
  modified:
    - src/domain/replica/invite.ts
    - src/test/replicaBoundaries.test.ts

key-decisions:
  - "safetyCode and safetyWords added to HUB_SIDE (one line) so hub-side invite.ts can derive the safety code; both are pure (node:crypto and data). The closure test is unchanged and still passes."
  - "checkJoinRequest order: shape and size, signature, project, invite id, voided, used, expired (when now is given), key binding, MAC, member"
  - "Add My Other Machine: the invite carries forMember; the request carries member (defaulting to the invite's forMember) and the MAC covers it only when present, so new-person MACs are unchanged; a mismatch either way is wrong-device"
  - "The refusal record is shared by invite, join request and welcome files; messages were reworded to fit all three"
  - "buildWelcome keeps a grant only when its cell is in the cleared list and every wrap names the joining device; it throws on an unreadable grant or a roster entry of another stream (the input is the lead's own store)"
  - "WELCOME_MAX_BYTES = BLOB_MAX_BYTES (8 MiB), as the plan says"

requirements-completed: [MUS-04]

coverage:
  - id: D1
    description: "invited -> join-requested by file: same six words on both screens, nothing written"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaInvite.test.ts#15.1 invited -> join-requested"
        status: pass
  - id: D2
    description: "Key swap: bad-signature, bad-binding, different safety code"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaInvite.test.ts (three key-swap tests)"
        status: pass
  - id: D3
    description: "One named test per refusal and the leak check on messages"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaInvite.test.ts (invite-expired, wrong-secret, wrong-project, bad-signature, unknown-invite, invite-used and invite-voided, malformed, too-large, Add My Other Machine wrong-device, messages)"
        status: pass
  - id: D4
    description: "Welcome file: roster and only this device's grants, checked against the pinned genesis"
    requirement: MUS-04
    verification:
      - kind: unit
        ref: "src/test/replicaInvite.test.ts (five welcome tests)"
        status: pass

actuals:
  tokens: 15250
  tasks: 3
  commits: 6
plan_head_before: 6cacd66f216763046e33ca50c9e1ac71eaf9f3a8
plan_head_after: 4ef3f5e4

duration: 15min
completed: 2026-11-20
---

# Phase 31 Plan 16: Invite, join request and welcome files Summary

**Joining by file is complete. Each of the 11 ways an invitation, join request or welcome file can be wrong is refused by name with a plain message that holds no secret, MAC or key. Both screens show the same six safety words. Add My Other Machine works through `forMember`. The welcome file lets a new device fold the roster to the lead's head using only its own grants.**

## Performance

- Started 2026-11-20T04:59Z, finished about 05:14Z
- 3 tasks, 6 commits (a RED and a GREEN commit per task), 1 file created, 2 modified

## Accomplishments

- **Files as they travel (D-15, D-37):** `readInvite`, `checkJoinRequest` and `readWelcome` take the file's JSON text or a parsed value. Text is measured in bytes before `JSON.parse`, and a parsed value by its canonical size. Fields are read as own properties only, so a parsed `__proto__` key counts as an extra key. Parsed input is never spread into a result.
- **Refusals (D-17):** `INVITE_REFUSALS` has `malformed`, `too-large`, `bad-signature`, `wrong-project`, `invite-expired`, `invite-used`, `invite-voided`, `unknown-invite`, `wrong-secret`, `bad-binding` and `wrong-device`. Every message is one or two sentences, says what to do next, and has no dash. `checkJoinRequest(file, { invite, secret, now?, rosterInvite? })` refuses voided or used invites from the roster's state, and expired ones when the caller passes a time. This lets the lead's command refuse before it writes anything; the fold is still the authority.
- **Safety code (D-16):** `inviteSafetyCode(invite, { publicKey, x25519 })` takes the request on the lead's side and the device's own keys on the joiner's side. The words match when the keys are honest. They differ when a whole request is remade by another device, and also when only the X25519 key is swapped.
- **Add My Other Machine (D-18):** the invite carries `forMember`, and the request carries `member`, which defaults to the invite's `forMember` and is covered by the MAC. A member invite answered by another member's machine is refused `wrong-device`, and so is one answered by a machine that names no member. A new-person invite answered by a request that names a member is refused the same way.
- **Welcome file (D-22, D-44, D-45):** `buildWelcome` carries the genesis, every roster entry and blob, and only the grants of cleared cells whose every wrap names the joining device. Excluded are the founding grant, other devices' grants, mixed grants and grants for another cell. `readWelcome` checks the size cap, the shape of every entry, blob and grant, that roster entries are in the genesis stream, that each blob's bytes match its name, the genesis hash against the pin (`wrong-project`), grant signatures, and that every wrap names the device (`wrong-device`). It returns `entries` (genesis first) ready for `foldRoster`. `inviteAnchor(invite)` gives the joining device's pin.

## Task Commits

1. Task 1 (tracer) RED: `cd7aef20` test(31-16): failing tracer tests for invited -> join-requested by file and the safety code on both screens
2. Task 1 GREEN: `ff358fc7` feat(31-16): read invite and join request files as JSON text and derive the safety code from the invite
3. Task 2 RED: `9b396534` test(31-16): failing named tests for every invite and join refusal
4. Task 2 GREEN: `ff6d538a` feat(31-16): every invite and join refusal by name, with plain messages that leak nothing
5. Task 3 RED: `9683252a` test(31-16): failing tests for the welcome file
6. Task 3 GREEN: `4ef3f5e4` feat(31-16): the welcome file carries the roster and only the joining device's grants

## TDD

Each RED commit has the new tests plus the smallest stubs needed to compile them (types, placeholder messages, an empty `inviteSafetyCode`, and `buildWelcome`/`readWelcome` stubs). Every RED run compiled and failed on the planned assertions:
- Task 1: 4 of 4 failed (`'malformed'` where `'ok'` was expected, because file text was not read yet).
- Task 2: 5 of 14 failed (invite-expired with a time, invite-used and invite-voided, too-large, wrong-device, the messages test). The other new named tests passed straight away because 31-12 had already written those checks.
- Task 3: 4 of 19 failed. The "no other cell's grant" test passed against the empty stub. It is a leak guard and has teeth: the mutations below make it fail.

After GREEN, I changed one guard at a time in the compiled `dist/` only (the next compile overwrites it) and checked that the tests catch it:
- Dropping the cleared-cell filter: 2 tests failed.
- `every` changed to `some` on the wraps filter: 3 failed.
- Skipping the welcome wrong-device check: 1 failed.
- Skipping the member check: 1 failed.
- Skipping invite-used: 2 failed.

## Decisions

- **Hub-side boundary:** the plan's key link puts `inviteSafetyCode` in `invite.ts`, and 31-20 reads it from there. So `'domain/replica/safetyCode', 'domain/replica/safetyWords',` went into `HUB_SIDE` as one line, and the comment above it was updated. `safetyWords` has to go with `safetyCode` because `safetyCode` imports it. Both are pure (node:crypto and a data array), so the closure test passes unchanged and nothing else in the boundary test was touched.
- **Tracer gate (Task 1):** auto mode. The verify (compile plus replicaInvite) was re-run together with replicaBoundaries, replicaRosterTracer and replicaSafetyCode (25 of 25) before Tasks 2 and 3 began.
- The other decisions are listed in the frontmatter `key-decisions`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] safetyCode.ts on the hub-side list**
- **Issue:** a hub-side `invite.ts` that imports `safetyCode.ts` fails the hub-side closure test (31-12 carry-over).
- **Fix:** one `HUB_SIDE` line for `safetyCode` and `safetyWords`, as the orchestrator allowed. `src/test/replicaBoundaries.test.ts` is outside the plan's `files_modified`.
- **Commit:** ff358fc7

**2. [Rule 2 - Missing critical functionality] Additions beyond the listed signatures**
- `checkJoinRequest` also takes an optional `now`, so the lead's command can refuse an expired invite before writing.
- `readWelcome` returns `entries` (genesis first).
- `inviteAnchor(invite)` was added so the joining device pins exactly what the invite names.
- Both additions keep the planned signatures as written.
- **Commits:** ff6d538a, 4ef3f5e4

### Notes

- The plan names the branch `feat/phase-31-16-invite-files`; the orchestrator dispatched this plan on `feat/phase-31-16-invite`.
- **Changed refusal messages:** `malformed`, `bad-signature` and `wrong-project` now cover welcome files as well. Their wording changed, and no existing test pinned the old text.
- `replicaRosterTracer.test.ts` already has a test whose name starts with "15.1 invited -> join-requested". The acceptance grep checks `replicaInvite.test.ts`, where the count is 1.
- **Size limit (follow-up for 31-20 and 31-18):** a welcome is capped at 8 MiB, the same as one blob. A roster large enough to pass that (thousands of entries) makes `buildWelcome` throw a plain error. This only matters for 31-20 and 31-18 if real rosters ever get that big.

## Test Results

Every run was under the shared flock lock, inside `systemd-run --user --scope -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 timeout ... NODE_OPTIONS=--max-old-space-size=1536`. Each compiled with `node scripts/vendor-libs.mjs && tsc -p tsconfig.json`, which exited 0 every time.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1 RED: replicaInvite | 4 | 0 | 4 |
| Task 1 GREEN and gate: replicaInvite, replicaBoundaries, replicaRosterTracer, replicaSafetyCode | 25 | 25 | 0 |
| Task 2 RED: replicaInvite | 14 | 9 | 5 |
| Task 2 GREEN: replicaInvite, replicaRosterTracer | 24 | 24 | 0 |
| Task 3 RED: replicaInvite | 19 | 15 | 4 |
| Task 3 GREEN (plan verify): replicaInvite, replicaRosterTracer | 29 | 29 | 0 |
| Final: every `dist/test/replica*.test.js`, `staffReplica*.test.js` and teamSignedPayload | 518 | 518 | 0 |

The full `npm test` was not run; the orchestrator runs it at the end.

Acceptance greps:

| Check | Result |
|-------|--------|
| `test('15.1 invited -> join-requested` in replicaInvite.test.ts | 1 |
| em-dashes in invite.ts | 0 |
| `export function readWelcome` in invite.ts | 1 |
| tests in replicaInvite.test.js (at least 16 required) | 19 |
| test names include invite-expired, wrong-secret, invite-used, invite-voided | yes |

## Known Stubs

None. Every RED stub was replaced in the GREEN commit that followed it.

## Threat Flags

None beyond the plan's threat register:
- **T-31-49 (stolen invite):** the safety code is bound to both devices' keys. Expiry is refused on read, and also in the lead's check when it is given a time; void and used are refused from the roster state.
- **T-31-50 (key swapped in transit):** caught by the request signature, the binding signature and a different safety code, each tested.
- **T-31-51 (another cell's grant in a welcome):** prevented by the per-device and cleared-cell filter, plus the wrong-device refusal on read. The serialised welcome was searched for the excluded grants' hashes and signatures.
- **T-31-52 (hostile or oversized files):** caps are applied before parse, fields are read as own properties, and `__proto__`, non-object and oversized inputs are tested.
- **T-31-53 (secrets in refusal text):** refusal results hold only `ok`, `reason` and `message`, and were searched for the secret, the MAC and every key.
- **T-31-SC:** no package was installed.

No new endpoint, file access or network path; the module stays pure.

## Self-Check: PASSED

- FOUND: src/test/replicaInvite.test.ts, src/domain/replica/invite.ts, src/test/replicaBoundaries.test.ts
- FOUND: commits cd7aef20, ff358fc7, 9b396534, ff6d538a, 9683252a and 4ef3f5e4 are ancestors of HEAD
