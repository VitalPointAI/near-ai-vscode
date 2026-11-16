---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 13
subsystem: team-mode
tags: [team-mode, identity, key-rotation, key-revocation, key-history, crash-repair, canary, fail-closed]

requires:
  - phase: 69-11
    provides: appendKeyRecord, readKeyHistory and localKeyStatus over the local signed key history
  - phase: 69-12
    provides: loadOrCreateDeviceIdentity with its created record, archiveKeyHistory and the hand-off about revoked keys left stored
provides:
  - "prepareDeviceRotation and commitDeviceRotation: a crash-safe two-step rotation of the person's own key; the commit records a rotated entry signed by the old key, keeps the old private key as the previous key and swaps the device key"
  - "loadPreviousDeviceIdentity and forgetPreviousDeviceIdentity for the kept previous key"
  - "revokeDeviceKey: a signed revoked record plus deletion of that key's private half in the same locked step"
  - "PENDING_DEVICE_KEY_SECRET and PREVIOUS_DEVICE_KEY_SECRET, and identityKeyNeedles in the canary helper covering all three private key names"
affects: [69-14, 69-15, 70, 71]

pr2_base: 6fd91a6a7be56d52ba9a9cb07297e511d744874a

actuals:
  tokens: 9800
  tasks: 2
  commits: 2
plan_head_before: 7a9121b15bfdce9e192af299b8691e96b6b72f2b
plan_head_after: cab4e8d6d89bcad394c60efa9c4e795487e8b745

tech-stack:
  added: []
  patterns:
    - "Lock order identity-create.lock then key-history.lock, kept: every new helper holds the first and appendKeyRecord takes the second"
    - "Idempotent key moves: each step of the swap checks what is already stored, so a crash after any step is finished by running the commit (or first need) again"
    - "repairKeyState runs inside the identity lock before a key is used: it finishes a recorded rotation and deletes any stored key the trusted history shows as revoked"
    - "Failure points are injected through a wrapped SecretStorageLike in the test, never through branches in product code"

key-files:
  created:
    - src/test/teamKeyRotation.test.ts
  modified:
    - src/team/identity.ts
    - src/test/helpers/teamCanary.ts
    - src/test/teamEnable.test.ts

key-decisions:
  - "A revoked key is never left stored: revokeDeviceKey appends the record and then deletes the key under the one identity lock, and a crash between the two is repaired by the next first need or revocation (the stored key is deleted, not archived and re-activated), which answers plan 12's hand-off without making the backfill fail"
  - "Revoking the current key also drops a rotation that was only prepared, because that pending key was never recorded and would otherwise block every later prepare"
  - "prepareDeviceRotation first makes sure the current key has its history record (the same step as first need), so a key from before the history existed can still be rotated"
status: complete
---

# Phase 69 Plan 13: rotate and revoke the person's own key Summary

**The person's key can now be rotated as a crash-safe two-step and revoked as a signed record, entirely through helpers in `src/team/identity.ts` (no command, menu or UI): payloads signed before a rotation still verify, later ones from the old key are refused as rotated with text that points to revocation, and a revoked key is refused for everything and its private half is deleted in the same locked step.**

## Effect on teams

A rotation through these helpers is local only. The new key is bound in no team roster and this phase signs no `device.rotated` event for it (no caller ships; L2's "Replace my device" flow signs one per team with the kept previous key, using plan 09's event), so until that event is in a team's log the person's session in that team is read-only under plan 07's not-bound rule. Because teams on main hold only their owner (D-13), revoking the kept previous key before then leaves no key that can sign that event, and the team stays read-only. The same paragraph is in the header of `src/team/identity.ts`.

## Task 1: tracer, rotate the person's key and see the verifier honour it on a solo payload

Commit `e20775b`.

- `prepareDeviceRotation(secrets, { identityDir, now? })` runs under `identity-create.lock`. It refuses (plain message, nothing created) when there is no current key, when a pending key already exists, or when a previous key from an earlier rotation is still kept. It makes sure the current key has its history record, generates an Ed25519 key, stores it under `nearAi.identity.pendingDeviceKey`, reads it back and returns `{ current, next }`. The current key stays the one in use, and no history record is written.
- `commitDeviceRotation(secrets, { identityDir, now? })` requires a pending key and a trusted history. When the history's active key is still the current key it appends `{ kind: 'rotated', key: current, next: pending }` signed by the current key; when the history already names the pending key active (a crash after the record) it appends nothing. It then finishes the moves with `finishRotationMoves`: the current key is stored as `nearAi.identity.previousDeviceKey`, the pending key becomes the device key, and the pending entry is deleted. Every step checks what is already stored, so it can be run again after a crash at any step.
- `loadPreviousDeviceIdentity` and `forgetPreviousDeviceIdentity` read and delete the previous entry. `loadDeviceIdentity` and the new loaders now share one private reader (`loadStoredKey`); the device key's two error messages are unchanged.
- The tracer test: a fresh identity signs bundle A at T0, prepare, commit at T1; bundle A verifies; a bundle by the old key at T2 gives `key-rotated` and its message mentions revoking; a bundle by the new key verifies; `loadDeviceIdentity` returns the new key and `loadPreviousDeviceIdentity` the old one; the pending entry is gone.

## Task 2: revocation, crash repair at every step, and the canary over all three key names

Commit `cab4e8d`.

- `revokeDeviceKey(secrets, { identityDir, key, now? })` under the identity lock (history lock inside). It refuses a key the history does not know or one already revoked, naming the reason and changing nothing. The record is signed by the key itself when it is the stored current key, otherwise by the active key, otherwise by the key itself if its private half is still stored. It then deletes whichever of the current, previous and pending entries holds that key.
- Plan 12's hand-off (a key the history knows only as revoked gets archived and re-created as active on the next first need): handled two ways. The record and the deletions happen under one lock, and `repairKeyState` (run at the start of `loadOrCreateDeviceIdentity` and of `revokeDeviceKey`, only when the history replays ok) deletes any stored current, pending or previous key that the history shows as revoked. A test makes the delete fail after the record was written, then checks the next first need creates a fresh key (`created: true`, history `created, revoked, created`, nothing archived) and that the old key stays `key-revoked`. Without `repairKeyState` that test fails.
- `repairKeyState` also finishes a half-done rotation when the history already names the pending key active, so first need in that state finishes the swap instead of archiving the history as plan 12's mismatch rule would (also tested, and it fails without the repair).
- Crash points are made with a wrapped secret store in the test: a failure storing the history's saved end (before the record: current key stays active, pending key stays, a repeated commit completes), failures storing the previous and then the device key (after the record: the next commit finishes with exactly one `rotated` record), and a failure deleting the pending entry.
- Canary: `teamCanary.ts` gains `identityKeyNeedles(stored, prefix)`, which returns every rendering (`deviceKeyForms`) of the values stored under the device, pending and previous names. The SEC-01 test in `teamEnable.test.ts` now builds the owner's needles with it, so it covers the two new names; no earlier assertion changed meaning. The new canary test scans the identity folder (history file included) with the needles from every stage (created, prepared, committed, revoked, fresh), with a planted-copy control. A final case installs the vscode stub, runs `loadOrCreateDeviceIdentity`, `signPayload`, `prepareDeviceRotation`, `commitDeviceRotation`, `revokeDeviceKey` on the previous and then the current key, and a fresh `loadOrCreateDeviceIdentity`, and asserts `stub.configUpdates` is empty; it also asserts no command id in `package.json` contains rotat or revok.

## Verification

All commands run from the PR 2 worktree inside the owner-rules cap wrapper (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

| Command | Result |
| --- | --- |
| Task 1 verify: `npx tsc -p tsconfig.json && node --test dist/test/teamKeyRotation.test.js dist/test/teamIdentity.test.js` | 24 tests, 24 pass, 0 fail, 0 cancelled |
| Task 2 verify: `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/test/teamKeyRotation.test.js dist/test/teamEnable.test.js dist/test/teamKeyHistory.test.js dist/test/teamManifest.test.js` (plus `teamIdentity`) | 102 tests, 102 pass, 0 fail, 0 cancelled (teamKeyRotation alone: 15 pass) |
| `node --test --test-concurrency=1 dist/test/teamBoundaries.test.js dist/test/teamCommands.test.js` | 24 tests, 24 pass |
| All team suites: `node --test --test-concurrency=2 dist/test/team*.test.js` | 630 tests, 630 pass, 0 fail, 0 cancelled |
| `npx tsc -p tsconfig.json` (the repo's `lint` is `tsc --noEmit`) | clean |

Acceptance: `grep -c` of the two new secret names in `identity.ts` is 1 and 1; `export async function commitDeviceRotation` is on 1 line; `device.rotated` appears 3 times and `read-only` twice in `identity.ts`; `stub.configUpdates, []` appears once in the rotation test; the package.json command check exits 0; `identityKeyNeedles` (using both new names) is in `teamCanary.ts`; no em-dash in any touched file; `git diff --name-only 7a9121b..HEAD` lists only `src/team/identity.ts`, `src/test/helpers/teamCanary.ts`, `src/test/teamEnable.test.ts` and `src/test/teamKeyRotation.test.ts`; `package.json` and the lockfile are unchanged (T-69-SC). Mutation check: removing the `repairKeyState` call from `loadOrCreateDeviceIdentity` makes exactly the two repair tests fail.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] A revoked key could be left stored after a crash**
- **Found during:** Task 2 (plan 12's hand-off)
- **Issue:** if the process died between the `revoked` record and the key deletion, the next first need would archive the history and make the revoked key active again.
- **Fix:** `repairKeyState` deletes stored keys the trusted history shows as revoked, before any key is used.
- **Files modified:** `src/team/identity.ts`
- **Commit:** `cab4e8d`

**2. [Rule 2 - Missing critical functionality] A prepared rotation would have been stuck after revoking the current key**
- **Found during:** Task 2
- **Issue:** revoking the current key left the pending key stored, so `prepareDeviceRotation` would refuse forever ("already prepared") while `commitDeviceRotation` could never succeed (no active key).
- **Fix:** revoking the current key also deletes an unrecorded pending key. The pending key had never been recorded anywhere.
- **Files modified:** `src/team/identity.ts`
- **Commit:** `cab4e8d`

### Other deviations

- The Task 2 tests were written together with the implementation rather than seen failing first. Instead, the two tests that depend on the new first-need repair were shown to fail with the repair removed (mutation check above). The other behaviors (`revokeDeviceKey`, the refusals) had no earlier code to fail against.
- `prepareDeviceRotation` takes the full `IdentityLockOptions` (`identityDir` and an optional `now`), a superset of the plan's `{ identityDir }`, because it may need to write the current key's `created` record.
- Commit trailers use the model that ran (`Claude Sonnet 5.5`), per the owner rules, not the `Claude Opus 5.5` line in the plan text.
- The SEC-01 test's owner needle labels changed from `device key form N` to `owner device key form N` (and pending, previous); no assertion depends on the old label.

## Known Stubs

None. No UI, data source or placeholder is added.

## Threat Flags

None beyond the plan's register. T-69-36 (a copied old key after rotation): revocation refuses the key for everything and deletes its private half, tested for the previous key at claimed times before and after the rotation; the rotated-key text points to revocation. T-69-37 (crash between rotation steps): the pending key is kept until the commit, the commit is idempotent and finishes after a record, tested at the record, at both key stores and at the pending delete, and first need finishes a half-done swap. T-69-38 (pending and previous private keys): SecretStorage only; the canary scans cover all three names and the settings case finds no configuration update. T-69-SC: lockfile unchanged.

## Open for the owner and for later plans

1. No command, menu or UI calls these helpers. L2's "Replace my device" flow and Phase 71 must append a `device.rotated` event per team signed with the kept previous key before that previous key is revoked or forgotten; until then the person is read-only in their teams after a local rotation (see "Effect on teams"). Plan 14's disposition record should carry this.
2. `forgetPreviousDeviceIdentity` is unlocked and simple on purpose; the later flow decides when the previous key may be dropped.

## Self-Check: PASSED

- Files found: `src/team/identity.ts`, `src/test/teamKeyRotation.test.ts`, `src/test/helpers/teamCanary.ts`, `src/test/teamEnable.test.ts`.
- Commits found as ancestors of HEAD: `e20775b`, `cab4e8d`.
