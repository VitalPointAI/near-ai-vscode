---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 12
subsystem: team-mode
tags: [team-mode, identity, key-history, backfill, archive, rollback, canary, fail-closed]

requires:
  - phase: 69-07
    provides: loadOrCreateDeviceIdentity, forgetCreatedDeviceIdentity and the D-22 rollback rule
  - phase: 69-11
    provides: appendKeyRecord, readKeyHistory and localKeyStatus over the local signed key history
provides:
  - "A person's key records its own creation: loadOrCreateDeviceIdentity writes the created record inside identity-create.lock, so a fresh install can sign and verify its first policy bundle against its own history"
  - "A key stored before any history exists is backfilled with one created record signed by that key; a broken history, or one whose active key is not the stored key, is archived beside the original and a fresh history starts"
  - "archiveKeyHistory: rename-only move of an unusable history to key-history.archived-<UTC compact time>-<6 hex>.json, clearing the saved end; nothing is deleted"
  - "forgetCreatedDeviceIdentity appends a revoked record signed by the key before deleting it, and only while the key's one history record is its own created record"
affects: [69-13, 69-15, 70, 71]

pr2_base: 6fd91a6a7be56d52ba9a9cb07297e511d744874a

actuals:
  tokens: 21000
  tasks: 2
  commits: 2
plan_head_before: 981c3e8ebc992746056904cf91b6c00299be5ff2
plan_head_after: 09cb31805dfa9165447e7c1cac9a763116fa42b6

tech-stack:
  added: []
  patterns:
    - "Lock order identity-create.lock then key-history.lock: the identity functions hold the first and the history calls take the second"
    - "An unusable history is never repaired or deleted: it is renamed aside and keys only it knew read as unknown (fail closed)"
    - "Rollback keeps the history a valid chain by withdrawing the key (a revoked record signed by that key) before removing it"

key-files:
  created: []
  modified:
    - src/team/identity.ts
    - src/team/keyHistory.ts
    - src/test/teamIdentity.test.ts
    - src/test/teamEnable.test.ts
    - src/test/helpers/teamCanary.ts

key-decisions:
  - "A brand-new key is appended straight onto a history whose last key was revoked (the chain continues: created, revoked, created); a key that already existed is archived into a fresh history when the history has records but no active key, as the plan says"
  - "If the created record cannot be written for a key this call just made, that key is forgotten again and the error is thrown, so no key is left without a history record"
  - "forgetCreatedDeviceIdentity decides by the replayed history: the stored key must be the active key and the saved head must be seq 1 (one record can only be that key's own created record); a broken or longer history returns false and deletes nothing"
  - "The canary scans the saved end through keyHistoryHeadNeedles (its full stored text), found nowhere outside SecretStorage"

patterns-established:
  - "Later plans that change the key (13) take identity-create.lock first and call appendKeyRecord, which takes key-history.lock"

requirements-completed: []
status: complete
---

# Phase 69 Plan 12: the identity writes and backfills its own history Summary

**A fresh install now creates its device key together with a signed `created` history record in one locked step, so its first policy bundle signs and verifies offline against its own history; an existing key without a record is backfilled, an unusable history is archived instead of trusted or deleted, and a failed Enable withdraws the key it made with a signed `revoked` record before forgetting it.**

## Task 1: tracer, a fresh install creates its identity with a created record and verifies its first bundle

Commit `630fddc`. `loadOrCreateDeviceIdentity` now takes `{ identityDir, now? }`. Inside `identity-create.lock` a new key is stored and read back, then `ensureCreatedRecord` reads the history: if it is broken or has an active key it is archived first, then `appendKeyRecord(identityDir, secrets, identity, { kind: 'created', key })` signs the record with the new key. An existing key whose history already names it active is left alone; an empty history gets a `created` record (backfill); a broken history, or one whose active key is another key, is archived and a fresh `created` record starts.

`archiveKeyHistory(identityDir, secrets, { now? })` in `keyHistory.ts` takes `key-history.lock`, renames `key-history.json` to `key-history.archived-<UTC compact time>-<6 hex>.json` in the same folder (it picks a name that does not exist yet, so an archive is never overwritten), clears the saved end, and returns the archived path, or `undefined` when there was no file (a lone saved end is still cleared). The module header now says archiving fails closed.

The tracer test: a fresh `MemorySecrets` and a temp folder give `created: true`; `readKeyHistory` is ok with head seq 1 and exactly one `created` record, signed by the key itself; a `policy-bundle` signed by the identity verifies through `localKeyStatus` with key state `active`; a second call returns `created: false` and leaves the history at one record.

Existing tests that counted secret names (`secrets.values.size`) now see the saved end of the history as a second secret. `teamEnable.test.ts` got a `storedKeys` helper that leaves out `KEY_HISTORY_HEAD_SECRET`, and the assertions about the device key use it; no assertion about the key was weakened.

## Task 2: backfill, archive instead of delete, the rollback rule with the history, and the canary

Commit `09cb318`. The new tests were written first and run red: exactly the three `forgetCreatedDeviceIdentity` tests failed (the archive and backfill tests already passed on Task 1's code), then the function was implemented.

- Backfill: a key made with `createDeviceIdentity` gets one `created` record signed by that key on the next `loadOrCreateDeviceIdentity`; `created` is false; a later call adds nothing.
- Archive, one byte changed: the archived file exists beside `key-history.json` with exactly the changed bytes (name matches the pattern), `key-history.json` holds only the fresh `created` record, the head matches (seq 1), and no archive means nothing else was removed.
- Archive, active key not the stored key: the old file is archived byte for byte, the head follows the fresh history, and a `policy-bundle` signed by the old key (which only the archived history knew) gives `unknown-key`, while one signed by the stored key verifies.
- A lone saved end with the history file removed is cleared and a fresh history starts with nothing to archive; a backfill whose append fails after the archive leaves the stored key and the archive in place; a key this call made is forgotten again when its `created` record cannot be written.
- Rollback: `forgetCreatedDeviceIdentity` (under the identity lock, history lock inside) returns false unless the stored fingerprint is the one named and the replayed history is ok with that key active and head seq 1; it then appends `{ kind: 'revoked', key }` signed by the key and deletes the secret. A failed Enable with no identity before it (all three failure paths) leaves records `created` then `revoked` for the same key, the second signed by the key, the chain replaying ok with no active key and no archive. An Enable after such a failure creates a new key whose `created` record follows (kinds created, revoked, created; the new key is the owner device; head seq 3). A failed Enable with an identity before it leaves the key, the history file bytes and the saved end unchanged. The plan 07 test "an identity that existed before a failed Enable is untouched" is kept as it was.
- `forgetCreatedDeviceIdentity` refuses and deletes nothing when the key has a history record after `created` (a rotation) and when the history is tampered with or missing.
- Canary: `teamCanary.ts` gains `keyHistoryHeadNeedles(storedHead)`. The scanner control test shows a copy of the saved end is found in a file and a git object; the SEC-01 test adds the head to its needles, asserts the head exists so the scan is meaningful, scans `key-history.json` (and all extension storage, git objects, `team.json` and the audit store) and finds nothing. A separate test checks the history file and the saved end hold no private key rendering (stored form, base64url, seed hex, seed base64url, seed base64).

## Verification

All commands run from the PR 2 worktree inside the owner-rules cap wrapper (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

| Command | Result |
| --- | --- |
| Task 1 verify: `npx tsc -p tsconfig.json && node --test dist/test/teamIdentity.test.js dist/test/teamKeyHistory.test.js` | 32 tests, 32 pass, 0 fail, 0 cancelled |
| Task 1 follow-up: `node --test --test-concurrency=1 dist/test/teamEnable.test.js dist/test/teamCommands.test.js dist/test/teamSession.test.js` | 74 tests, 74 pass |
| Task 2 verify: `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/test/teamIdentity.test.js dist/test/teamEnable.test.js dist/test/teamKeyHistory.test.js dist/test/teamCommands.test.js` | 96 tests, 96 pass, 0 fail, 0 cancelled |
| All team suites: `node --test --test-concurrency=2 dist/test/team*.test.js` | 613 tests, 613 pass, 0 fail |
| `npx tsc -p tsconfig.json` (the repo's `lint` is `tsc --noEmit`) | clean |

Acceptance: `grep -c "appendKeyRecord" src/team/identity.ts` is 3 and `export async function archiveKeyHistory` is on 1 line of `keyHistory.ts` (baseline 0 and 0); the kept D-22 test name is present in `teamEnable.test.ts`; `keyHistoryHead` appears in `teamCanary.ts` and `teamEnable.test.ts`; the archive tests assert the archived file exists beside `key-history.json` with exactly the old bytes; no em-dash in any touched file; `package.json` and the lockfile are unchanged against PR 1 head (T-69-SC). `git diff --name-only 981c3e8..HEAD` lists the five source and test files above (see deviations for `enable.ts`).

## Deviations from Plan

### Auto-fixed Issues

None. No product bug was found beyond what the plan describes.

### Other deviations

- `src/team/enable.ts` is in the plan's `files_modified` but needed no change: its rollback already calls `forgetCreatedDeviceIdentity` only when `created` is true, which is exactly the D-22 behavior the plan asks for to be kept.
- Commit trailers use the model that ran (`Claude Sonnet 5.5`), per the owner rules, not the `Claude Opus 5.5` line in the plan text.
- Nine existing `teamEnable.test.ts` assertions that counted every secret name (`secrets.values.size` or the full key list) now go through a `storedKeys` helper that leaves out the saved end of the history, since a forgotten key now legitimately leaves its history and head behind. Assertions about the device key itself are unchanged in meaning.
- The plan's verification line "No path in `src/team` deletes a key history file" holds for any history that existed before a call. The one `rm` of the history file in `src/team/keyHistory.ts` is plan 11's: when the very first record was just written and the head store then fails, `appendKeyRecord` removes the file it created in that same call to put things back. It cannot remove a history that existed before.
- A key created by this call whose `created` record cannot be written is forgotten again (the call throws). The plan did not say; leaving a key with no history record would break D-22's "created in this call" accounting.

## Known Stubs

None. No UI, data source or placeholder is added.

## Threat Flags

None beyond the plan's register. T-69-33 (a history edited to drop a revocation, then healed) is covered by archive-and-replace with every other key reading unknown, tested for a changed byte and for a mismatched active key; T-69-34 (rollback deleting a key or breaking the chain) by the created-only rule and the `revoked` record, tested on all three Enable failure paths and the refusals; T-69-35 (private key in the history file or the head) by the canary scanning the history file, the saved end, git objects, `team.json`, storage and the audit store; T-69-SC by the unchanged lockfile.

## Open for the owner and for later plans

1. An existing key that the history knows only as revoked (for example the revoke succeeded but removing the key then failed) is, by the plan's rule, archived and given a fresh `created` record, which makes it active again in the new history. Plan 13's revocation helper should delete the key in the same locked step so that state cannot arise; if the owner would rather such a key stay refused, the backfill should fail instead of archiving in that one case.
2. A person who clears secret storage keeps `key-history.json` but loses its saved end; the next first-need call now archives that history and starts a new one for the stored key (keys only the old history knew read as unknown). That is the recovery plan 11 left open.

## Self-Check: PASSED
