---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 11
subsystem: team-mode
tags: [team-mode, key-history, hash-chain, ed25519, key-status, fail-closed, file-lock]

requires:
  - phase: 69-10
    provides: signPayload, verifyPayload (purpose key-record), KeyStatusLookup and NO_KNOWN_KEYS
provides:
  - "A local, append-only, signed and hash-chained key history for a person without a team (created, rotated, revoked records)"
  - "replayKeyHistory: a pure replay that gives a KeyStatusLookup of the same kind a team roster gives, failing closed to every key unknown"
  - "readKeyHistory, appendKeyRecord and localKeyStatus in src/team/keyHistory.ts, with the head (seq and hash) kept in SecretStorage"
affects: [69-12, 69-13, 69-15, 70, 71]

pr2_base: 6fd91a6a7be56d52ba9a9cb07297e511d744874a

actuals:
  tokens: 13725
  tasks: 2
  commits: 2
plan_head_before: 6ab73ca3e45da45229cf4164fad77f0cc131e45b
plan_head_after: a72a03b98e43cb36421f88e74c19914ba014d300

tech-stack:
  added: []
  patterns:
    - "A replay decides who may sign each record from the state so far, then hands verifyPayload a status that answers active for exactly those keys and unknown for every other"
    - "The history file is checked against a head kept where an edit to the file cannot reach (SecretStorage), so a valid but shortened chain is still caught"
    - "Read, check, write the file and then the head all happen inside one file lock; the new history is replayed before anything is written"

key-files:
  created:
    - src/domain/team/keyRecords.ts
    - src/team/keyHistory.ts
    - src/test/teamKeyHistory.test.ts
    - src/test/helpers/keyHistoryChild.ts
  modified: []

key-decisions:
  - "keyRecordHash hashes the whole signed envelope (signature included), so re-signing or editing any byte of a record changes the hash the next record names"
  - "The replay reads a record's payload twice: once from the untrusted record to decide which keys may sign it, and again from the copy verifyPayload returns; the verified copy is what is applied"
  - "A key can appear in the history once: a created or rotated-to key that the history already used is refused, so a revoked key can never be brought back"
  - "A rotated key may revoke itself and the active key may revoke any key, but a rotated key may not revoke the key that replaced it"
  - "A failed head store after the file write puts the file back as it was, so a failed append never leaves a history that reads as edited"

patterns-established:
  - "Later plans that write a record call appendKeyRecord with the signer and a change; identity-create.lock is taken before key-history.lock wherever both are held"

requirements-completed: []
status: complete
---

# Phase 69 Plan 11: local signed key history Summary

**A person with no team keeps a signed, hash-chained record of their keys (created, rotated, revoked) in a local file, and replaying it gives the same kind of key status lookup a team roster gives; any damage to the file reads as every key unknown, and a cut-short chain is caught by a head kept in SecretStorage.**

## Task 1: tracer, a created record is written, read back and verifies a solo payload

Commit `77d77b5`. `keyRecords.ts` holds the types and constants from the plan plus `replayKeyHistory`, which walks the records in order: `seq` counts from 1, `prev` is the hash of the previous signed record, the record passes `verifyPayload` for purpose `key-record` against a status that answers active only for the key allowed to sign it, and the record's `at` equals the envelope's `signedAt`. In this task only `created` was implemented (the new key signs itself and no key may be active); every other kind failed closed. The head check follows the walk: records with no head, a head with no records, a head longer than the file, or a head that names a different last record all fail.

`keyHistory.ts` reads `<identityDir>/key-history.json` (absent is empty, over `MAX_KEY_HISTORY_BYTES`, unreadable or not JSON fails closed) and the head JSON under `nearAi.identity.keyHistoryHead`. `appendKeyRecord` takes `withFileLock(identityDir, 'key-history.lock', ...)`, reads and replays (refusing to build on a broken history), signs the next record with `signPayload`, replays the new history against its new head before writing anything, writes the file with `writeFileAtomic`, then stores the head, all inside the lock. `localKeyStatus` returns the replay's lookup.

The tracer test appends a `created` record for a run-time Ed25519 signer, reads it back (active key and head seq 1), verifies a `grant` signed by that key through `localKeyStatus`, shows a stranger's payload gives `unknown-key`, and checks that neither the file nor the saved head holds the private key as DER base64, PEM body, JWK `d`, or the raw seed in base64 or hex.

## Task 2: rotation, revocation, fail-closed tampering and two writers

Commit `a72a03b`. The tests were written first and run red (12 of 19 failed, since `rotated` and `revoked` were not yet understood), then `replayKeyHistory` was extended.

- `rotated`: signed by the active key, `key` must be the active key, `next` a key the history never used. Afterwards `next` is active and `key` reads `rotated` with `since` equal to the record's `at` and `replacedBy` the next fingerprint.
- `revoked`: the key must be known and not already revoked; the signer is the key itself (while active or rotated) or the active key. The key then reads `revoked` with `since` the record's `at`. Revoking the active key leaves no active key, and a later `created` for a new key is allowed.
- Fail closed, each asserting not ok, a plain reason with no em-dash and every key unknown: one byte of a record changed (payload, signature, `signedAt`), two records swapped, a middle record removed, a record re-signed by another key, a wrong `prev`, a `seq` gap, `at` differing from `signedAt`, version 2, a wrong shape, 1001 records, a file over the byte limit, not JSON, a valid shortened chain while the saved head names the last record, a head missing with records present, a head with an empty history (file removed), an unreadable head, a head that matches nothing, and a whole valid history made by someone else (valid alone, refused against this person's head). Hostile input (throwing Proxies, circular objects) never throws.
- D-21 through the lookup: a payload by the rotated key claimed one millisecond before the rotation verifies (key state `rotated`); at the rotation instant, after it or far after it gives `key-rotated`; a payload by a revoked key gives `key-revoked` whatever its `signedAt`.
- Appends: a rotation that no longer fits (the key was already rotated) is refused with "Nothing was added to the key history", and the file and head are unchanged; an edited file makes the next append refuse; a head store that fails restores the file (or removes a first-record file).
- The race: two forked children are each given the same active key over the IPC channel and one shared file-backed secret store, wait for a "go" from the parent, and both try to rotate to different new keys. Exactly one succeeds, the other is refused because the key is no longer active, and the final history replays ok with seq 1 and 2 and the head matching. It passed 7 of 7 runs in a row.

A mutation check confirmed the head tests bite: removing the head comparison in the compiled replay failed the truncation and the whole-history-replaced tests; the source was untouched.

## Verification

All commands run from the PR 2 worktree inside the owner-rules cap wrapper (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

| Command | Result |
| --- | --- |
| Task 1 verify: `npx tsc -p tsconfig.json && node --test dist/test/teamKeyHistory.test.js dist/test/teamBoundaries.test.js` | 7 tests, 7 pass, 0 fail, 0 cancelled |
| Task 2 verify: `npx tsc -p tsconfig.json && node --test --test-concurrency=1 dist/test/teamKeyHistory.test.js && node --test dist/test/teamSignedPayload.test.js dist/test/teamKeyStatus.test.js` | 19 tests then 29 tests, all pass, 0 fail, 0 cancelled, exit 0 |
| `node --test dist/test/teamSignedPayload.test.js dist/test/teamKeyStatus.test.js dist/test/teamBoundaries.test.js` | 34 tests, 34 pass |
| All team suites: `node --test --test-concurrency=2 dist/test/team*.test.js` | 598 tests, 598 pass, 0 fail |
| Race test alone, six extra runs | 6 of 6 pass |
| `npx tsc -p tsconfig.json` (the repo's `lint` is `tsc --noEmit`) | clean |

Acceptance: `export function replayKeyHistory` on 1 line of `keyRecords.ts`; `nearAi.identity.keyHistoryHead` on 1 line and `KEY_HISTORY_LOCK_FILE` on 2 lines of `keyHistory.ts`; `fork(` on 1 line of the test; 19 passing tests (at least 18 needed); teamBoundaries passes with the new files; no em-dash in any new file. `git diff --name-only 6ab73ca..HEAD` for the plan's own commits lists exactly the four files in `files_modified`; `package.json` and the lockfile are unchanged (T-69-SC).

## Deviations from Plan

### Auto-fixed Issues

None needed in the product code. One test of mine was wrong, not the product: the "head cannot be stored" test reused a secret store that already held a head for another folder, so the first-record case correctly failed closed for the wrong reason; it now uses a fresh store.

### Other deviations

- Commit trailers use the model that ran (`Claude Sonnet 5.5`), per the owner rules, not the `Claude Opus 5.5` line in the plan text.
- Additions beyond the plan text, all fail-closed: a key can appear in the history only once (so a revoked key cannot be created again); an unreadable or malformed saved head fails the history; a failed head store restores the file; the new history is replayed before anything is written.
- The plan says `keyRecords.ts` imports `./keyStatus` and `./signedPayload`; `NO_KNOWN_KEYS` is a value import from `./keyStatus` and `verifyPayload` a value import from `./signedPayload`, neither creating a cycle (`signedPayload` imports `keyStatus` as a type only).

## Known Stubs

None. No UI, data source or placeholder is added.

## Threat Flags

None beyond the plan's register. T-69-30 (edited, reordered or re-signed records) is covered by the hash chain, the per-record signer check and the fail-closed tests; T-69-31 (a truncated history hiding a revocation) by the head in SecretStorage and its three tests (shortened, missing, alone); T-69-32 (interleaved writes) by `key-history.lock` and the forked race; T-69-SC by the unchanged lockfile.

## Open for the owner and for later plans

1. A crash between writing the file and storing the head leaves the file one record ahead of the head, which reads as a changed history and fails closed (no key is trusted). The plan fixes this order (file, then head) and says a head that does not equal the last record fails, so no recovery was built. A process that is killed at that exact moment is the only way to get there; the append itself restores the file when the head store fails. If the owner wants a recovery step (for example "accept a file exactly one valid record ahead of the head, signed by the active key"), that is a later plan's call.
2. The head lives in SecretStorage, so a person who clears secret storage gets "records but no saved end" and every key reads unknown until a later plan (12 or 13) offers a plain recovery. That is the intended fail-closed behavior for this plan.
3. Plan 12 needs `appendKeyRecord(identityDir, secrets, identity, { kind: 'created', key: ... })` and must take `identity-create.lock` before `key-history.lock`.

## Self-Check: PASSED

- Commits `77d77b5` and `a72a03b` are ancestors of HEAD on `feat/team-signed-payloads`.
- `src/domain/team/keyRecords.ts`, `src/team/keyHistory.ts`, `src/test/teamKeyHistory.test.ts` and `src/test/helpers/keyHistoryChild.ts` exist.
- The full set of team suites (598 tests) passes with 0 failures.
