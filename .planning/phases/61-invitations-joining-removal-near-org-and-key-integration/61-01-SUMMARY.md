---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 01
subsystem: team-core
tags: [invite, join, ed25519, hkdf, signed-log, git-transport, commit-time-expiry]

requires:
  - phase: 60-team-core-identity-signed-event-log-git-transport-roster
    provides: signed event log, materialiser pipeline, TeamLog, GitTransport, device identity, secret detectors
provides:
  - member.invited implemented (body, validator, permission mapping, invited member record)
  - self-bound invite-gated member.joined (verified against the key in its own body, gated by a code-derived countersignature)
  - src/domain/team/invite.ts pure invite rules (proof bytes, expected role, commit-time expiry, display status)
  - src/team/inviteCode.ts 160-bit Crockford code with HKDF-derived Ed25519 invite key
  - TeamLog.appendJoin and prepareJoinEvent for a joiner without a signer
  - Materializer.check commit time and GitTransport.now so a stale join is refused on write with the read-side reason
affects: [61-02, 61-03, 61-04, 61-05, 62, 66]

plan_head_before: 767ba47c3e7adc5ab361fd8eb860b875c32593c7
plan_head_after: ea1efdc36e1896cb9659c8844b6e4f199aff2f89
actuals:
  tokens: 20913
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "self-bound event: author's device is bound by the event itself, signature checked against the key in the body"
    - "commit-time rule: compare two transport commit times, never read a clock on the read path"
    - "optional-only Member fields, omitted when absent, so Phase 60 snapshots and state hashes do not change"

key-files:
  created:
    - src/domain/team/invite.ts
    - src/team/inviteCode.ts
    - src/test/teamInvite.test.ts
  modified:
    - src/domain/team/types.ts
    - src/domain/team/validate.ts
    - src/domain/team/permissions.ts
    - src/domain/team/materialize.ts
    - src/team/eventLog.ts
    - src/team/gitTransport.ts
    - src/test/teamValidate.test.ts

key-decisions:
  - "Task 1 confirmed as recorded (confirm-recorded, auto-selected): invite and join shapes, HKDF/PKCS#8 derivation, 300 s skew, D-15 confirmation rule"
  - "Joiner transition keeps invitedEvent after the join so a used invitation is distinguishable from a never-invited member and a second join gets notInvited"
  - "Any accepted member.role-changed clears pendingRole (plan Task 3 wording), not only a change to exactly the pending role"
  - "A join whose author differs from body.memberId is rejected as an invalid body field before any invitation check"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "A lead appends member.invited and every client materialises an invited record (observer, no device, pendingRole set)"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInvite.test.js#tracer: an owner invites, a second clone joins with only the code, and both clones materialise identical state"
        status: pass
    human_judgment: false
  - id: D2
    description: "A second clone with no device key joins with the code over real git; both clones accept it and hold byte-identical state"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInvite.test.js#tracer: an owner invites, a second clone joins with only the code, and both clones materialise identical state"
        status: pass
    human_judgment: false
  - id: D3
    description: "The clear-text code never appears in any object on the coordination remote"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInvite.test.js#the clear-text code never appears in any object on the coordination remote"
        status: pass
    human_judgment: false
  - id: D4
    description: "Wrong code, replay, second join, cancelled invite, changed email, wrong role and expired join are rejected on read and refused on write with one fixed reason"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamInvite.test.js (join rule tests) and expiry is also checked on write"
        status: pass
    human_judgment: false
  - id: D5
    description: "Cancel, re-issue as one batch, notJoined rules, pendingRole clearing and racing joins"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInvite.test.js#re-issue is one batch; two devices racing the same code"
        status: pass
    human_judgment: false
  - id: D6
    description: "Phase 60 tests and snapshots are unchanged: member.joined outside genesis without an invitation is still ownerJoinOnly"
    verification:
      - kind: unit
        ref: "node --test dist/test/team*.test.js (398 pass, 0 fail)"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-11-02
status: complete
---

# Phase 61 Plan 01: Invite and join tracer Summary

**A lead invites a person into the signed log and a second clone joins over real git with only a single-use code: the join is signed by a not-yet-bound device, countersigned by an HKDF-derived Ed25519 key, expires by commit time on read and write, and the code never touches the log.**

## Performance

- **Duration:** about 50 min (start time was not recorded at launch, so this is an estimate)
- **Completed:** 2026-11-02T00:52:58Z
- **Tasks:** 3 (one decision checkpoint, one tracer, one hardening task)
- **Files modified:** 10 (3 created, 7 modified)

## Accomplishments

- `member.invited` is an implemented event: exact-key validator (one email hash, invitable roles only, ttl 3600 to 2592000, derived public key), mapped to the `member.invite` permission, creating an invited member record with no device.
- Self-bound `member.joined`: a branch ahead of the bound-device step takes a join whose author has an invitation on record. It checks the signing device equals the body device, the fingerprint is new, and the envelope signature against the key in the body, then the invitation rules in the fixed order: unused and not cancelled, code proof, email hashes, expected role, commit-time expiry. Every other non-genesis join keeps the Phase 60 `ownerJoinOnly` rejection.
- `src/team/inviteCode.ts`: 20 random bytes as 32 Crockford characters, normalising parse (case, spaces, dashes, I/L/O), HKDF-SHA256 key derivation (salt team id, info member id) wrapped as PKCS#8 Ed25519. The private key stays in a closure.
- `TeamLog.appendJoin` and `prepareJoinEvent` for a joiner with no signer; the body function is re-run on every transport retry so a racing loser gets the `notInvited` conflict instead of a duplicate.
- Write-side expiry: `Materializer.check` takes an optional commit time and `GitTransport` passes `floor(now/1000)` at both check calls (`GitTransportOptions.now`, injectable), so a stale join is refused with `inviteExpired` before anything is pushed.
- Snapshot support: `parseMember`/`parseDeviceKey` accept the new optional keys, and an empty device list is allowed only for `status: 'invited'`. A team with no invitations serialises byte-identically; `STATE_HASH_VERSION` stays 1.

## Task Commits

1. **Task 1: Confirm the signed invite and join formats** - no commit (decision checkpoint, `auto_select="confirm-recorded"` taken in auto mode; logged as `Auto-selected: confirm-recorded`)
2. **Task 2: Tracer, invite then join from a second clone** - RED `adf7424` (test), GREEN `18c44f5` (feat)
3. **Task 3: Every join rule, expiry on read and write, cancel and re-issue** - RED `27fc41b` (test), GREEN `ea1efdc` (feat)

**Plan metadata:** committed separately after this file (docs: complete plan).

## Files Created/Modified

- `src/domain/team/invite.ts` - pure invite rules: `joinProofBytes`, `expectedJoinRole`, `inviteExpired`, `INVITE_*` constants, `invitationStatus`
- `src/team/inviteCode.ts` - code generation, formatting, parsing, derived invite key
- `src/domain/team/types.ts` - `INVITABLE_ROLES`, `MemberInvitedBody`, optional `invite`/`sealKey` on `MemberJoinedBody`, `DeviceKey.sealKey`, optional invitation keys on `Member`, `Materializer.check` commit time, eight new rejection reasons
- `src/domain/team/validate.ts` - `member.invited` validator, optional `invite.sig` and `sealKey.publicKey` on `member.joined`
- `src/domain/team/permissions.ts` - `member.invited` maps to `member.invite`
- `src/domain/team/materialize.ts` - invited transition, self-bound branch, joiner transition, `notJoined` and email/id rules, `pendingRole` clearing, snapshot parsing, commit time through `checkCandidate`
- `src/team/eventLog.ts` - `prepareJoinEvent`, `TeamLog.appendJoin`
- `src/team/gitTransport.ts` - `now` option and candidate commit time at both check calls
- `src/test/teamInvite.test.ts` - 15 tests: code, derived key, tracer, no clear-text code, every join rule, exact expiry boundary, snapshot round trip, detector check over 1000 random keys, expiry on write, re-issue, racing joins
- `src/test/teamValidate.test.ts` - two deliberate pin updates plus one necessary adjustment (see deviations)

## Decisions Made

- **Task 1: confirm-recorded** (auto-selected under auto mode, `gate="blocking"` with `auto_select`). Shapes, derivation, the 300 s skew allowance (assumption A5, still flagged unresolved for the owner), and the D-15 confirmation rule are used exactly as recorded. No revision was requested.
- `invitedEvent` survives the join, so `invitationStatus` can report `used` and a second join attempt gets `notInvited` rather than the Phase 60 rejection.
- A join whose author is not `body.memberId` is rejected as an invalid body field (`body.memberId`) before invitation checks; the plan's fixed reason list had no better match.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wrong-type probe in the "every body" validator test cannot use a number for numeric fields**
- **Found during:** Task 2 (RED)
- **Issue:** `teamValidate.test.ts` probes each key with `12345`; for `allocationNanoUsd` and `ttlSeconds` that is a valid value, so the probe could never fail.
- **Fix:** probe those two keys (and `lamport`, already special-cased) with a string instead. No assertion was weakened; the same wrong-type check now runs for every key.
- **Files modified:** `src/test/teamValidate.test.ts`
- **Commit:** `adf7424`

**2. [Rule 1 - Bug, test only] Two test helper mistakes found while writing the RED tests**
- `signed()` cannot canonicalise a body with an `undefined` key, and the Join helper returned its own `'not invited'` text instead of the shared reason. Both were fixed in the test file before RED was committed.
- **Commit:** `27fc41b`

**3. [Plan note] Rules landed in Task 2, not Task 3**
- The plan's Task 2 action already specifies the whole materialiser rule set, so the Task 3 fixture tests passed as soon as they were written. The only genuinely failing Task 3 test was expiry on write, which drove the `GitTransport.now` change.

**Total deviations:** 1 auto-fixed blocking test adjustment, 1 test-only fix, 1 plan note. **Impact:** none on scope or shipped behaviour.

## TDD Gate Compliance

- **Task 2 RED (`adf7424`):** `teamInvite.test.ts` fails at load because `invite.ts`, `inviteCode.ts`, `appendJoin` and the new types do not exist yet. That is a build/load failure, not an assertion failure, so it would be classed INVALID_RED by the evidence classifier. It is unavoidable for brand-new TypeScript modules without a stub commit. In the same commit `teamValidate.test.ts` fails on a real assertion (`valid bodies for every implemented type pass`: actual 11 bodies, expected 10 implemented types). `gsd_run check tdd-red-evidence` was not run against a record; the evidence above is from the actual `node --test` output.
- **Task 3 RED (`27fc41b`):** a genuine assertion failure: `expiry is also checked on write` got `refused.ok === true` (actual true, expected false), because the transport passed commit time 0 to the check. Semantic assessment: the target test ran, failed on the planned assertion, for the planned reason.
- **GREEN:** `18c44f5` then `ea1efdc`, each after its RED. No REFACTOR commit was needed.

## Verification Results

- `npx tsc -p tsconfig.json && node --test dist/test/team*.test.js`: 398 tests, 398 pass, 0 fail (baseline before the plan: 383).
- `npm run lint`: exit 0.
- Acceptance greps: `MemberInvitedBody`, `'member.invited'` in validate, `joinProofBytes(` in materialize, `hkdfSync` in inviteCode, `appendJoin` in eventLog all match; no `vscode` import in `invite.ts` or `inviteCode.ts`; code lines containing `Date.now` in `invite.ts` and `materialize.ts`: 0; `TEAM_REJECTION_REASONS.invite` appears 9 times in the invite tests; the three-argument `materializer.check(` appears twice in `gitTransport.ts`.
- Phase 60 pins still pass unchanged: non-genesis `member.joined` without an invitation is rejected with `ownerJoinOnly`.

## Known Stubs

None. Nothing in the changed files is a placeholder or an unwired value.

## Threat Flags

None beyond the plan's register. T-61-01 (code never logged) is covered by the remote-wide object scan; T-61-02 to T-61-04 by the proof, replay, email and role tests; T-61-05 (expiry is hygiene) is accepted as planned.

## Open Items For Later Plans

- Assumption A5 (300 s skew) is still flagged for the owner to confirm; changing it only moves the acceptance edge for joins near the deadline.
- `member.invited` is not yet mirrored into the roster audit; that is planned for 61-05 Task 2 together with `member.key-sealed`. `auditMirror.ts` and `teamAudit.test.ts` were left untouched as the plan requires.
- Mixed-version teams: a Phase 60 build reads `member.invited` as unsupported and will diverge from snapshots (research Pitfall 9); acceptable pre-release.

## Next Phase Readiness

Ready for 61-02. The log-level join protocol, the `sealKey` slot on the joining device, and the write-side expiry hook are in place for the bundle, key delivery and command plans.

## Self-Check: PASSED

- Created files exist: `src/domain/team/invite.ts`, `src/team/inviteCode.ts`, `src/test/teamInvite.test.ts`.
- Commits `adf7424`, `18c44f5`, `27fc41b`, `ea1efdc` are ancestors of HEAD.
