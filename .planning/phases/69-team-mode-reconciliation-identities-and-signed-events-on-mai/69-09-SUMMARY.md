---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 09
subsystem: team-mode
tags: [team-mode, device-rotation, signed-events, permissions, snapshots, determinism]

requires:
  - phase: 69-08
    provides: PR 1 (#59) open from feat/team-core-on-main, the base PR 2 branches from
provides:
  - "device.rotated: one signed event { memberId, from, device } that retires a key and binds its replacement in a single step"
  - "Positional rotation: a key rotated at an earlier log position is refused with 'device was rotated before this event' on both the read and the write side"
  - "Permission action device.rotate (self for developer, reviewer and observer; owner and lead for others; a lead never on the owner)"
  - "DeviceKey.rotatedEvent / rotatedAt / rotatedTo, carried through snapshots and cross-checked on load"
  - "Revocation honours rotation: a rotated key can still be revoked, and the last-device rule counts only keys that are neither revoked nor rotated"
affects: [69-10, 69-15]

pr2_base: 6fd91a6a7be56d52ba9a9cb07297e511d744874a

actuals:
  tokens: 9252
  tasks: 2
  commits: 2
plan_head_before: 6fd91a6a7be56d52ba9a9cb07297e511d744874a
plan_head_after: 1b4fd94b2a56d44c357b34fb851d378a8fad3c92

tech-stack:
  added: []
  patterns:
    - "A new retirement state is a positional check in boundKey next to revocation, so the read side and the write side (which replays through the same materializer) give one text"
    - "Optional DeviceKey fields are set only when present, so a log with no rotation serialises and hashes exactly as before"

key-files:
  created: []
  modified:
    - src/domain/team/types.ts
    - src/domain/team/validate.ts
    - src/domain/team/permissions.ts
    - src/domain/team/materialize.ts
    - src/test/helpers/teamEvents.ts
    - src/test/teamMaterialize.test.ts
    - src/test/teamValidate.test.ts
    - src/test/teamPermissions.test.ts
    - src/test/teamForgery.test.ts
    - src/test/teamLog.test.ts

key-decisions:
  - "A member rotates their own key only by signing with the key it retires (rotationNotByOldKey), also when the member is the owner; the owner or a lead acting for someone else signs with their own device"
  - "The retired fingerprint stays in deviceIndex so it can never be registered again, by device.added or by another rotation (deviceTaken)"
  - "Revocation is reported before rotation for a key that is both, so the read-side text for such a key stays 'device was revoked before this event'"
  - "A snapshot's rotatedTo must name a device of the same member that the rotation event itself bound (addedEvent equals rotatedEvent), and the three rotation fields come together or not at all"

patterns-established: []

requirements-completed: []
status: complete
---

# Phase 69 Plan 09: device.rotated end to end Summary

**Key rotation is now one signed `device.rotated` event that the roster, the permission matrix, the materializer, snapshots and both sides of the log honour, next to Phase 60's positional `device.revoked`.**

PR2_BASE: `6fd91a6a7be56d52ba9a9cb07297e511d744874a` (the head of `feat/team-core-on-main`, PR #59, open and not merged). Plan 15 rebases or merges from it. PR 2 work sits in a linked worktree on `feat/team-signed-payloads`, created by the orchestrator from that commit. Nothing was pushed.

## Task 1: tracer, an owner rotates their own key

Commit `cdd8a72`. `device.rotated` joined `TEAM_EVENT_TYPES` (header now says 55 types) and the implemented list (eleven). The body validator pins exactly `memberId`, `from` and `device`. The matrix row `device.rotate` has the `device.add` and `device.revoke` shape, and the lead-on-owner reason now reads "a lead cannot add, revoke or rotate a device of the owner". In the materializer:

- `boundKey` returns `device was rotated before this event` for a key with `rotatedEvent`, right after the revoked check, so events at or before the rotation stay valid.
- `referenceProblem` checks, in order: the member exists and is not removed, `from` is bound to that member, `from` is not revoked or already rotated, the new fingerprint is not in the index, and (author is the member) the event's signing device is `from`.
- The transition sets `rotatedEvent`, `rotatedAt` and `rotatedTo` on the old key, pushes the new key (`addedBy` the author, `addedEvent` the rotation event) and indexes it; the old fingerprint stays indexed.

The tracer test: genesis, an event by the genesis key (accepted), the owner's rotation signed by the genesis key, an event by the new key (accepted), an event by the old key (rejected with the exact text), and a full replay that agrees byte for byte.

## Task 2: revocation after rotation, snapshots, the property and both sides of the log

Commit `1b4fd94`. The behaviour listed in the plan is covered by tests; the code for the last-device rule, the snapshot fields, the `rotatedTo` cross-check and the rotated snapshot signer shipped in the first commit (see Deviations).

- Revoking an already rotated key is accepted and skips the last-device rule; revoking the only key that is neither revoked nor rotated still gives 'cannot revoke the last active device of a member'; rotating never trips the rule, including a second rotation in a row.
- Snapshots: a state with a rotation round-trips with all three fields; a `rotatedTo` that names no device of that member, names the retired key itself, comes with only two of the three fields, or names a key bound by another event is refused; a snapshot signed by the retired key is refused with the rotated reason; a state with no rotation serialises with no rotated field anywhere.
- The seeded determinism property now generates self-rotations, revocations of the retired key and stale-key forgeries. Over its 40 seeds, 14 contain a rotation, 8 refuse a retired key with the rotated reason, and 6 revoke a retired key (the test asserts at least 5, 3 and 2, so the property cannot silently stop covering rotation).
- Validation, permissions (every role, own and other, owner target), raw-pushed forgeries seen identically by two real-git clients (`from` not bound, already rotated, self-rotation signed by another of the member's keys, retired key signing later) and write-side refusals (`TeamLog.append` and the transport) with the text a reader records.

A mutation check confirmed the tests bite: with the `rotatedDevice` line in `boundKey` removed, the tracer, the property, the raw-forgery test and the write-side test all failed; it was restored before committing.

## Verification

All commands run from the PR 2 worktree inside the owner-rules cap wrapper (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

| Command | Result |
| --- | --- |
| Task 1 verify: `npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/teamMaterialize.test.js dist/test/teamValidate.test.js dist/test/teamPermissions.test.js` | 110 tests, 110 pass, 0 fail, 0 cancelled |
| Task 2 verify: same `tsc`, then the six files `teamMaterialize teamValidate teamPermissions teamForgery teamLog teamCanonical` | 155 tests, 155 pass, 0 fail, 0 cancelled |
| All team suites: `node --test --test-concurrency=2 dist/test/team*.test.js` (33 files) | 550 tests, 550 pass, 0 fail |
| `npx tsc -p tsconfig.json` (the repo's `lint` is `tsc --noEmit`) | clean |

Acceptance greps: `'device.rotated'` appears on 4 lines of `types.ts` (at least 2), the rotated-before text on 1 line (1), `'device.rotate'` on 6 lines of `permissions.ts` (at least 3), `rotatedEvent` on 11 lines of `materialize.ts` (at least 4), `rotat` on 15 lines of `teamForgery.test.ts` and 12 of `teamLog.test.ts` (each at least 1). `git diff --stat 6fd91a6..HEAD` touches exactly the ten files in the plan's `files_modified` and no others; `package.json` and the lockfile are unchanged (T-69-SC).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 1's verify command runs two suites the plan lists only for Task 2**
- **Found during:** Task 1
- **Issue:** `teamValidate.test.ts` asserts that its valid-body table has one entry per implemented type and `teamPermissions.test.ts` asserts the matrix has 27 kinds and a table row per kind, so adding `device.rotated` and `device.rotate` made both fail until their tables grew.
- **Fix:** the minimal table updates (a valid `device.rotated` body, three `device.rotate` rows, kind count 28, the action mapping case, the new kind in the two device loops) went into the Task 1 commit so it stays green; the fuller coverage is in the Task 2 commit.
- **Files modified:** src/test/teamValidate.test.ts, src/test/teamPermissions.test.ts
- **Commit:** cdd8a72

### Other deviations

- The implementation for the Task 2 behaviours (last-device count, `parseDeviceKey` fields, the `rotatedTo` cross-check in `deserialiseState`, the rotated snapshot signer) was written together with the tracer in `cdd8a72`, because the tracer's types, snapshot shape and revoke rule are one consistent change. Task 2's commit holds the tests for them; I did not stage a failing-first run for those cases, and instead checked the tests bite with the mutation described above.
- The precondition's "create the worktree" step was already done by the orchestrator (`feat/team-signed-payloads` at `6fd91a6`). `npm ci` was run in it; `npx tsc -p tsconfig.json` was run instead of `npm run compile` (the test commands need only `dist`).
- Commit trailers use the model that ran (`Claude Sonnet 5.5`), per the owner rules, not the `Claude Opus 5.5` line in the plan text.
- The seeded generator's random sequence changed (new branches consume random numbers), so the 40 seeded logs are different logs from before; every one still replays to its planned verdicts and the determinism assertions are unchanged.

## Known Stubs

None. This plan adds no UI, data source or placeholder.

## Threat Flags

None beyond the plan's register. T-69-21 (retired key spoofing) is covered by the positional `rotatedDevice` check with one text on read and write; T-69-22 by the `device.rotate` matrix row, the lead-on-owner denial and `rotationNotByOldKey`; T-69-23 by the parsed and cross-checked snapshot fields and the refused rotated signer; T-69-SC by the unchanged lockfile.

## Open for the owner and for later plans

1. `TeamLog.verifyAll` reports each device as `{ fingerprint, revoked }` (`src/team/eventLog.ts`, around line 289) and the session lists a device as "(revoked)" from that flag. A rotated key therefore shows as an ordinary active device in that report. Plan 10's key status lookup is the natural place to surface "rotated"; this plan did not change the report shape.
2. PR 2 is not opened here (plan 15 does that after PR 1 is on main).

## Self-Check: PASSED

- Commits `cdd8a72` and `1b4fd94` are ancestors of HEAD on `feat/team-signed-payloads`.
- `src/domain/team/types.ts`, `validate.ts`, `permissions.ts`, `materialize.ts` and the six test files exist and carry the rotation changes.
- The full set of team suites (550 tests) passes with 0 failures.
