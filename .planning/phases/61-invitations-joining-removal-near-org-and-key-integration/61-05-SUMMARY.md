---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 05
subsystem: team-core
tags: [sealed-key, member.key-sealed, rotation, permissions, roster-audit, signed-log]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-01 invite and join (sealKey on member.joined, DeviceKey.sealKey, invite.ts); 61-03 sealTo/openSealed, SealIdentity, detector exemptions for sealed fields"
provides:
  - member.key-sealed (55th event type): exact-key body, validator, owner-or-lead permission row, reference rule, transition
  - Member.nearKeyDevices, nearKeyEvent, retiredNearKeyIds (optional, omitted when absent, snapshot-safe)
  - device.added optional sealKey.publicKey stored on the device
  - keyNeedsRotation, memberAttention, sealCapableFingerprints in src/domain/team/invite.ts
  - roster audit now mirrors member.invited and member.key-sealed as metadata only
affects: [61-06, 61-10, 61-11, 62, 66]

plan_head_before: d7d55aedb897c48a81a3c5e1ddad30b0e46482ea
plan_head_after: 2f333ba3f95134d79b431904ba447cec3d386a18
actuals:
  tokens: 13828
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "every delivery is a new key: the key id can never repeat, so a device change always means a new key and an existing key is never re-sealed"
    - "sealed device set must equal the member's active seal-capable devices, computed by one shared function (sealCapableFingerprints) on read and in the attention list"
    - "deterministic Phase 60 log (fixed Ed25519 seed, fixed ids) pins the state hash taken from the pre-Phase-61 code"

key-files:
  created:
    - src/test/teamKeySealedEvent.test.ts
    - src/test/helpers/teamPhase60Fixture.ts
  modified:
    - src/domain/team/types.ts
    - src/domain/team/validate.ts
    - src/domain/team/permissions.ts
    - src/domain/team/materialize.ts
    - src/domain/team/invite.ts
    - src/team/auditMirror.ts
    - src/test/teamValidate.test.ts
    - src/test/teamPermissions.test.ts
    - src/test/teamAudit.test.ts

key-decisions:
  - "Task 1 confirmed as recorded (confirm-recorded, auto-selected): member.key-sealed body, AAD binding and the rotate-on-device-add rule"
  - "memberAttention lists one item per member with precedence confirm, then deliver-key, then rotate-key; a member waiting for confirmation gets confirm only, because the key follows the confirmation (D-25)"
  - "Leads are included in deliver-key and rotate-key (plan wording: joined, not owner, not invited); only the owner is excluded"
  - "keyNeedsRotation is true whenever the sealed device set differs from the active seal-capable set, including when no seal-capable device is left; the list then shows rotate-key although nothing can be sealed yet (61-10 decides what the lead is told)"

requirements-completed: []  # TEAM-02 is only partly delivered here (log format and rules); later plans finish it, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "A lead appends member.key-sealed over real git and the member's clone materialises the key id and opens its sealed entry with the X25519 key from SecretStorage; the clear key is in no remote object"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamKeySealedEvent.test.js#tracer: a lead seals a key to a joined member over real git and the member clone opens it"
        status: pass
    human_judgment: false
  - id: D2
    description: "Only the owner or a lead may write member.key-sealed, never for the owner; the target must be joined and not removed"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamKeySealedEvent.test.js (only the owner or a lead delivers a key...; the target must be joined and not removed); dist/test/teamPermissions.test.js (28 rows, ownerKey)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A key id can never repeat; sealed devices must be exactly the member's active seal-capable devices; the previous key id moves to retiredNearKeyIds"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamKeySealedEvent.test.js (every delivery is a new key...; sealing to a device of another member...; the sealed devices must be exactly...)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A device add with a seal key or a device revoke makes keyNeedsRotation true; memberAttention lists confirm, deliver-key and rotate-key in roster order and only confirm without a NEAR link"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamKeySealedEvent.test.js (device.added with a seal key records it...; memberAttention lists confirmations...)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Roster audit mirrors member.invited and member.key-sealed with metadata only (no email hash, invite key, key id or sealed field); Phase 60 states keep their hash and snapshots round-trip"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamAudit.test.js#member.invited and member.key-sealed are mirrored as metadata only...; dist/test/teamKeySealedEvent.test.js#a Phase 60 state keeps its hash..."
        status: pass
    human_judgment: false

duration: 8 min
completed: 2026-11-02
---

# Phase 61 Plan 05: Sealed key event Summary

**A lead can seal a freshly created NEAR key to a joined member's devices in a signed `member.key-sealed` event that every client validates, permission-checks and applies (owner or lead only, never for the owner, new key id every time, sealed set equal to the member's seal-capable devices), with rotation detection after device changes and the attention list a lead's window needs.**

## Performance

- **Duration:** 8 min (2026-11-02T01:20:10Z to about 01:28Z)
- **Tasks:** 3 (one decision checkpoint, one tracer, one hardening task)
- **Files modified:** 11 (2 created, 9 modified)

## Accomplishments

- `member.key-sealed` joins the roster group (event types 54 to 55). Body: `memberId`, `keyId` (NEAR id pattern), `scheme` fixed to `x25519-hkdf-sha256-aes-256-gcm-v1`, and `sealed` of 1 to 8 entries with exact keys and strict base64url lengths (32, 12, 16 bytes; ciphertext 16 to 525 bytes), no duplicate devices. Three new rejection reasons: `keyReused`, `keyDevices`, `noSealKey`.
- Permission row `member.key-deliver` (owner and lead, 28 rows), with an override that denies any delivery to the owner using the new `PERMISSION_REASONS.ownerKey`. The write path (`TeamLog.append`) and the read path ask the same question through `actionForEvent`.
- Materialiser reference rule and transition: the key id must not be the current or any retired id; each sealed device must belong to the member, be unrevoked and have a seal key; the sealed set must equal the member's active seal-capable devices. The transition retires the previous key id and records `nearApiKeyId`, sorted `nearKeyDevices` and `nearKeyEvent`. Snapshot parsing accepts the new optional member keys.
- `device.added` takes an optional `sealKey.publicKey` stored on the device. `keyNeedsRotation` and `memberAttention` (confirm, deliver-key, rotate-key) are pure and in roster order; `sealCapableFingerprints` is shared with the materialiser.
- `ROSTER_AUDIT_TYPES` gained `member.invited` (moved here from 61-01) and `member.key-sealed`; the entries carry only `{ eventType, eventId, lamport, memberId, role, subjectId }`.

## Task Commits

1. **Task 1: Confirm the sealed-key event body and rotation rule** - no commit (decision checkpoint, `auto_select="confirm-recorded"` taken in auto mode; logged as `Auto-selected: confirm-recorded`)
2. **Task 2 (tracer):** RED `be525a2` (test), GREEN `33e6175` (feat)
3. **Task 3:** RED `d967a73` (test), GREEN `2f333ba` (feat)

## Decisions

- **Task 1: confirm-recorded** (auto-selected under auto mode, `gate="blocking"` with `auto_select`). The recorded body, AAD binding (team, member, device, key id) and rotation rule are used unchanged. No revision was requested. Rotation on device add (rather than re-sealing) is the choice that never re-seals an existing key, as D-24 requires.
- Attention precedence and the inclusion of leads are listed under key-decisions above; both are consistent with D-16, D-24 and D-25 and are open to change in 61-10 without a format change, because `memberAttention` is derived state, not logged.

## Files Created/Modified

- `src/domain/team/types.ts` - event type, `SealedEntryBody`, `MemberKeySealedBody`, `DeviceAddedBody.sealKey`, three optional Member fields, three rejection reasons
- `src/domain/team/validate.ts` - key-sealed validator (`validateSealedList`, `validateSealedEntry`, `validateCiphertext`), optional `sealKey` on `device.added`
- `src/domain/team/permissions.ts` - `member.key-deliver` kind, row, label, `ownerKey` reason and override, `actionForEvent` mapping
- `src/domain/team/materialize.ts` - `keyDeliveryProblem` reference rule, key-sealed transition, device seal key on add, snapshot parse of new Member keys
- `src/domain/team/invite.ts` - `sealCapableFingerprints`, `keyNeedsRotation`, `memberAttention`, `MemberAttention`
- `src/team/auditMirror.ts` - `ROSTER_AUDIT_TYPES` with `member.invited` and `member.key-sealed`
- `src/test/teamKeySealedEvent.test.ts` - tracer over real git plus ten fixture tests (rules, rotation, attention, Phase 60 hash, snapshot round trip)
- `src/test/helpers/teamPhase60Fixture.ts` - deterministic Phase 60 log for the pinned state hash
- `src/test/teamValidate.test.ts`, `teamPermissions.test.ts`, `teamAudit.test.ts` - deliberate pin updates plus new tests

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Snapshot parsing of the new Member keys**
- **Found during:** Task 2 (planning the materialiser change)
- **Issue:** `parseMember` rejects any member key it does not know, so a snapshot of a team with a delivered key would have been refused and every client would have fallen back to a full replay.
- **Fix:** `nearKeyDevices`, `nearKeyEvent` and `retiredNearKeyIds` are accepted (and validated) as optional keys; a round-trip test covers a team with a retired key.
- **Files modified:** `src/domain/team/materialize.ts`, `src/test/teamKeySealedEvent.test.ts`
- **Commit:** `33e6175`

**2. [Plan note] Extra test helper file**
- A deterministic Phase 60 log (`src/test/helpers/teamPhase60Fixture.ts`) was added so "a Phase 60 state keeps its hash" is checked against a literal hash taken from the pre-Phase-61 code (compiled from `d7d55ae` into a scratch directory), not against the current code. It is outside the plan's `files_modified` list but is test-only.
- **Commit:** `d967a73`

**3. [Plan note] Task 3 rule tests passed on first run**
- The delivery rules (permission, joined target, key reuse, noSealKey, keyDevices) were implemented in Task 2 together with the materialiser change, as the Task 2 action specifies, so the Task 3 tests for them passed immediately. The genuinely failing Task 3 tests were `keyNeedsRotation` and `memberAttention`.

**Total deviations:** 1 auto-fixed (Rule 2), 2 plan notes. **Impact:** none on scope; the snapshot fix was required for correctness.

## TDD Gate Compliance

- **Task 2 RED (`be525a2`):** real assertion failures. The tracer ran invite, join and confirm, then failed at the `member.key-sealed` append with `not permitted` (`false !== true`), the planned reason. Pin tests failed on assertions (`27 !== 28` rows, the old `ROSTER_AUDIT_TYPES` list, 2 audit entries instead of 4, `unsupported event type` for the new body). Semantic assessment: the target tests ran and failed for the intended reason. `tsc` also reported type errors for the not-yet-existing types; it still emits, so the compiled tests ran. `gsd_run check tdd-red-evidence` was not run against a record.
- **Task 3 RED (`d967a73`):** the two new tests failed with `keyNeedsRotation is not a function` and `memberAttention is not a function` (missing symbols, not assertion failures); the rule tests already passed (see deviation 3).
- **GREEN:** `33e6175` and `2f333ba`, each after its RED. No REFACTOR commit.
- **Tracer gate (auto mode):** the tracer's verify command was re-run end to end and passed before Task 3 began: `⚡ Tracer verified end-to-end — expanding`.

## Verification Results

- `npx tsc -p tsconfig.json && node --test dist/test/team*.test.js`: 477 tests, 477 pass, 0 fail (442 before this plan).
- The Task 2 verify command (key sealed, validate, permissions, audit, materialize): 126 pass. The Task 3 verify command (key sealed, invite, materialize): 54 pass.
- `npm run lint` exits 0.
- Acceptance greps: `MemberKeySealedBody` in types, `'member.key-deliver'` in permissions, `assert.equal(kinds.length, 28)`, `'member.invited'` and `'member.key-sealed'` in auditMirror, `export function memberAttention` and `export function keyNeedsRotation`, `TEAM_REJECTION_REASONS.keyReused` and `.keyDevices` in the key-sealed test all match. The tracer scans every object on the coordination remote for the run-time clear key (four renderings) and finds none; the key id is the only trace.
- No `vscode` import in the changed domain files; no `Date.now` in the code lines of `invite.ts` or `materialize.ts`; no package changes.

## Known Stubs

None. The `fakeSealed` entries in tests are random-shaped bytes by design (the log checks shape and binding, never decrypts); the tracer uses real `sealTo`.

## Threat Flags

None beyond the plan's register. T-61-20 (author rights) is covered by the permission tests and the owner-target override; T-61-21 and T-61-22 by the key-reuse, noSealKey and keyDevices tests; T-61-23 by the retired list and the round-trip test.

## Open Items For Later Plans

- 61-06 should add the planned invariant test: for every seeded log a member's `nearApiKeyId` is never in `retiredNearKeyIds`, and the current plus retired ids equal the key ids of that member's accepted `member.key-sealed` events.
- Removal (61-10/61-11) must revoke `nearApiKeyId` and every id in `retiredNearKeyIds`.
- A member whose last seal-capable device is revoked shows `rotate-key` with nothing to seal to; 61-10 should decide the wording.

## Next Phase Readiness

Ready for the next plans in wave 2. The log format for key delivery is fixed (one-way), the permission row exists, and the lead-side triggers (`memberAttention`) are available for the status bar and the Manage Team Members list.

## Self-Check: PASSED

- Created files exist: `src/test/teamKeySealedEvent.test.ts`, `src/test/helpers/teamPhase60Fixture.ts`; `src/domain/team/invite.ts` modified and present.
- Commits `be525a2`, `33e6175`, `d967a73`, `2f333ba` are ancestors of HEAD.
