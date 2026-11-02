---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 10
subsystem: key-delivery
tags: [nearai, api-key, spend-limit, sealed-key, rotation, cleanup-checklist, member-confirm]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-02 NearOrgClient (createKey with the cap in the create call, findKey, setSpendLimit, revokeKey) and the fake NEAR; 61-03 sealTo, wipe and the seal identity; 61-04 installTeamKey and readInstalledKey; 61-05 member.key-sealed, keyNeedsRotation, sealCapableFingerprints; 61-07 CleanupChecklist"
provides:
  - src/team/keyDelivery.ts with confirmMember, deliverMemberKey, rotateMemberKey, installDeliveredKey, teamKeyName and the result types
  - TeamLog.findEvent, an accessor for one event body by id (needed to read sealed entries on the member side)
  - the wording for a member who has no seal-capable device left (61-05 left it to this plan)
affects: [61-11, 61-12, 61-13, 62, 66]

plan_head_before: 5b7bf7ecbf309238ac7bbcc80f3c7208737dfdc7
plan_head_after: ad69c9eed86f87f61ff30e10cfcfa748acdd5a92
actuals:
  tokens: 16800
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "one shared private sendKey for first delivery and rotation: create with the cap, seal in a try/finally that wipes the clear key, append with a builder that re-checks the fresh state, and on any failure zero then revoke the key just made"
    - "cleanup items are updated, not duplicated: an open item for the same member, step and key is reused, a failed attempt counts, and success settles every open item for the step"
    - "InterruptedOrg test double: a NearOrgClient subclass that runs a step right after createKey to stand in for another lead acting between two steps"

key-files:
  created:
    - src/team/keyDelivery.ts
    - src/test/teamConfirm.test.ts
  modified:
    - src/team/eventLog.ts

key-decisions:
  - "A rotation cap is old limit minus lifetime usage with integer arithmetic, floored at 0; a key NEAR no longer has, or one that reports no limit or usage, gives a cap of 0 and a manual rotate-key note rather than a guessed budget"
  - "The old key is only touched after member.key-sealed is accepted, and then zeroed before it is revoked; a failed step is listed as zero-limit or revoke-key with the old key id, and a zero-limit item is skipped when the revoke worked"
  - "Rotation refuses (no-device) when the member has no seal-capable device left, makes nothing, and says the old key stays valid on every computer that already has it, because revoking a device does not take its copy of the key away"
  - "deliverMemberKey refuses a member who already has a key, and the append builder re-checks that the member's current key is still the one this delivery replaces, so two leads confirming at once cannot leave a spendable key that the log no longer knows about"
  - "The sign-in instruction for a pending deliver-key item is stored in the item's lastError (the checklist has no separate text field)"
  - "TeamLog gained findEvent because installDeliveredKey takes a TeamLog and no existing accessor returned an event body; the first entry with the id in log order is the accepted one"

requirements-completed: []  # TEAM-02 is only partly delivered here (confirm, capped key, delivery, install, rotation); sessions, commands and removal come in later plans, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "Confirming a developer appends member.role-changed then, in a NEAR-linked team, creates the key with the allocation as its limit in the create call (no later PATCH), seals it to the member's device, and the member's clone installs it as the project's active team profile; the key is in no blob, mirror, storage file, clone file or checklist"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamConfirm.test.js#tracer: the owner confirms a developer, the key is created with the allocation as its cap, sealed through the log and installed on the developer clone"
        status: pass
    human_judgment: false
  - id: D2
    description: "A failed delivery never undoes a confirmation: no session leaves a pending deliver-key item that says to sign in, a NEAR error leaves a failed item with attempts counted and no key in the workspace, and a retry settles the same item"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamConfirm.test.js (confirming without a NEAR sign-in; a lead whose NEAR sign-in is gone; a NEAR error while making the key; a failed retry counts as another attempt)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A key made for a log write that is refused (member removed meanwhile) is set to limit 0 and then revoked (PATCH before DELETE), and steps that cannot finish are listed as zero-limit and revoke-key with the key id"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamConfirm.test.js (a key whose log write is refused ... is zeroed then revoked; a key that cannot be zeroed or revoked after a refused write)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Rotation sets the new cap to old limit minus lifetime usage, never below 0, including usage one nano-USD short of, equal to and above the old limit; the new key is delivered before the old key is zeroed and revoked; the revoked device gets no entry; both devices install the newest key"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamConfirm.test.js (adding a device gives a new key with the remaining cap ...; the new cap is the old cap minus lifetime usage, never below zero ...)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Rotation edge cases: an old key NEAR no longer has gives a cap of 0 and a manual note; an old key that cannot be revoked is listed by id; a failure making the new key leaves the old key working with a rotate-key item; no seal-capable device left makes nothing and says so; rotation is refused when no rotation is needed"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamConfirm.test.js (an old key NEAR no longer has; an old key that cannot be revoked; a failure while making the new key; a member with no device left; rotation is refused ...)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Live behaviour against the real NEAR AI Cloud (key activation delay on a real new key, real spend-limit enforcement after the cap is reached)"
    requirement: TEAM-02
    verification: []
    human_judgment: true
    rationale: "Everything is proven against the fake NEAR, which reproduces the documented traps (camelCase spendLimit, activation delay, 402 at the cap); nothing here calls the real service."

duration: ~20 min
completed: 2026-11-02
---

# Phase 61 Plan 10: Confirm, capped key delivery and rotation Summary

**The lead's client now turns a confirmation into a hard-capped NEAR key: it creates the key with the member's allocation as its spend limit in the create call, seals it to the member's devices through the signed log, and the member's clone opens and installs it; a device change rotates to a new key capped at what the member had left; every failure keeps the confirmation and leaves a Retry item.**

## Performance

- **Duration:** about 20 min (start time was not recorded at launch; estimated from commit times 21:13 to 21:22 local plus reading)
- **Tasks:** 3 (a tracer and two more), 6 commits (RED and GREEN for each)
- **Files:** 2 created, 1 modified

## Accomplishments

- `confirmMember`: appends `member.role-changed` from the fresh state (conflict if another lead already confirmed or the member was removed), then, in a NEAR-linked team, sends the key through `deliverMemberKey`; with no session it leaves a pending `deliver-key` item whose text says "Sign in to NEAR to send <name>'s key." A member who joined with their final role and has no key gets the key through the same call (`roleChanged: false`).
- `deliverMemberKey`: the target must be joined, not removed, not the owner and have a seal-capable device; the limit is `allocationNanoUsd ?? 0` sent only through `createKey`; the clear key is wiped in a `finally` right after `sealTo`; the append builder re-checks the member is still there, still holds the key being replaced and still has exactly the sealed device set.
- Failure handling: every failure is a `DeliveryResult` plus a checklist item. A key made for a refused write is `setSpendLimit(0)` then `revokeKey`; steps that cannot finish become `zero-limit` and `revoke-key` items carrying the key id. Open items are reused so a retry never duplicates and `attempts` counts failed tries; success settles them.
- `rotateMemberKey`: requires `keyNeedsRotation`; reads the old key with `findKey`; the new limit is `max(0, limit - usage)` in integers; the new key goes through the same path; only after `member.key-sealed` is accepted is the old key zeroed then revoked.
- `installDeliveredKey`: finds this device's member through the device index, answers `none`, `already-installed` or `not-for-this-device` where they apply, reads the event with the new `TeamLog.findEvent`, opens its entry with the seal identity, and installs through `installTeamKey` with `expect` set to the team's organization and workspace and the key id recorded. The opened key is wiped in a `finally`.
- `teamKeyName`: letters, digits, space, dot, underscore and hyphen only, at most 100 characters, with a per-delivery unique token kept whole.

## Task Commits

1. **Task 1 (tracer):** RED `a9ba014`, GREEN `058ad2f`
2. **Task 2:** RED `cd7ff4c`, GREEN `766f3eb`
3. **Task 3:** RED `0ca57b7`, GREEN `ad69c9e`

## TDD Gate Compliance

Each task has a `test(61-10)` commit followed by a `feat(61-10)` commit. RED evidence is the node:test run before the implementation:

- **Task 1 RED:** 4 of 4 tests fail. `keyDelivery.ts` existed as a skeleton whose entry points throw "not implemented" (and `TeamLog.findEvent` likewise), so the build compiles and each target test fails when the world has been built and the first entry point is called. Semantic assessment: the tracer ran its full setup (real git, signed invite and join, fake NEAR) and failed at `confirmMember`, which is the planned point.
- **Task 2 RED:** 6 of 9 new tests fail on assertions (checklist items missing, key not revoked). 3 of the 9 (an observer joined with the final role, a key-only confirm, the owner and a not-yet-joined member) already passed because Task 1's guards covered them; they were kept as regression tests and are not claimed as RED.
- **Task 3 RED:** 7 of 7 new tests fail at the `rotateMemberKey` skeleton after their setup (second device added over real git) succeeded.
- No refactor commits were needed.

The limit arithmetic is blocking-critical, so it was mutation-checked: replacing `Math.max(0, limit - usage)` with the old limit made 2 tests fail.

## Decisions Made

See key-decisions above. The one that matters most for later plans: after a device revoke with no seal-capable device left, the old key stays valid on every computer that already has it, and the message tells the lead so instead of implying the revoke cut the member off.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TeamLog had no way to read an event body**
- **Found during:** Task 1
- **Issue:** `installDeliveredKey` is specified to take a `TeamLog`, but the log and the state only expose the sealed key's id and event id, not the sealed entries. The plan's wording ("the transport's readAll") assumed access to the transport.
- **Fix:** added `TeamLog.findEvent(eventId)` which reads the log, parses each entry with `parseEventFile` and returns the first entry with that id (a later copy is a rejected duplicate). The member side also checks the body's member id and key id against the state before opening.
- **Files modified:** src/team/eventLog.ts (not in the plan's files_modified)
- **Verification:** tracer and rotation tests install through it; `teamLog`, `teamKeySealedEvent` and the whole `team*` suite (558 tests) pass.
- **Commit:** 058ad2f

**2. [Rule 2 - Missing critical functionality] A second lead could leave a spendable key unknown to the log**
- **Found during:** Task 1 design
- **Issue:** two leads confirming the same member at once would each create a key; the second `member.key-sealed` would retire the first without revoking it.
- **Fix:** `deliverMemberKey` refuses a member who already has a key, and the append builder returns a conflict if the member's current key is no longer the one this delivery replaces; a conflict zeroes and revokes the new key like any refused write.
- **Files modified:** src/team/keyDelivery.ts
- **Commit:** 058ad2f, 766f3eb

**3. [Rule 2 - Missing critical functionality] Log errors other than a refused append**
- **Found during:** Task 2
- **Issue:** a thrown error from the log write (a git failure, a secret-detector refusal) after the key was made would have left the key spendable.
- **Fix:** any throw from the append is treated like a refused write: the key is zeroed and revoked and a Retry item is left.
- **Files modified:** src/team/keyDelivery.ts
- **Commit:** 766f3eb

**Additions to the declared interface (compatible):** `DeliveryResult` success gained an optional `notice` (cleanup-list or old-key sentences the caller should show); `signInToSendKeyText` and `InstallDeliveredInput` are exported.

**Total deviations:** 3 auto-fixed (1 blocking, 2 missing critical). **Impact:** none on scope; `findEvent` is a small read-only accessor.

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. No new network surface: the module uses the existing NEAR routes and the existing log event; no package changes.

## Next Phase Readiness

Plans 61-12 and 61-13 can call `confirmMember`, `deliverMemberKey`, `rotateMemberKey` and `installDeliveredKey` and show `ConfirmResult.message`, `DeliveryResult.notice` and the checklist. `memberAttention` already lists `confirm`, `deliver-key` and `rotate-key`; for a rotation that returns `no-device`, show the message as written. Removal (which must revoke every id in `retiredNearKeyIds` plus the current key) is a later plan.

## Self-Check: PASSED

- Files: src/team/keyDelivery.ts, src/test/teamConfirm.test.ts, src/team/eventLog.ts all present.
- Commits a9ba014, 058ad2f, cd7ff4c, 766f3eb, 0ca57b7, ad69c9e are ancestors of HEAD; `commits: 6` is measured from the ledger.
- `npm run lint` exits 0; `node --test dist/test/teamConfirm.test.js dist/test/teamKeySealedEvent.test.js dist/test/teamKeyProfile.test.js` passes (41 tests); `node --test dist/test/team*.test.js dist/test/nearSignIn.test.js` passes (558 tests).
- Acceptance greps: `createKey(`, `wipe(`, `member.key-sealed`, `member.role-changed`, `'deliver-key'` and `export async function rotateMemberKey` all match in keyDelivery.ts; no `vscode` import there.
