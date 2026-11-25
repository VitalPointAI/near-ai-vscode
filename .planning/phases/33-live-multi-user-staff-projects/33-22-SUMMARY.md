---
phase: 33-live-multi-user-staff-projects
plan: 22
status: complete
subsystem: session keys at your organization's server, and the client's session answer and first push (hub half of P7)
tags: [hub, staff, replica, session-keys, person-key, d-60, d-61, d-62, mus-09]
requires: [33-07, 33-08, 33-21]
provides: [APPEND_REFUSALS session-expired, APPEND_REFUSALS person-key-required, APPEND_REFUSALS too-many-sessions, SESSION_REFUSALS session-expired, SESSION_REFUSALS revoked, LIMITS.liveSessionKeysPerDevice, ProjectRoster.sessionOf, ProjectRoster.standingAt, ProjectRoster.liveSessionsOf, ClockStanding, SessionAnswerPayload.certificate, SessionAnswerPayload.certificateEntry, HubTransportOptions.certificate, SESSION_EXPIRED_SENTENCE]
affects: [33-23, 33-24, 33-26]
tech-stack:
  added: []
  patterns: [one fold for the server and every client, certificate carried in the session answer and stored by the first push, device entries pushed before session-key entries, refuse only what the server can read]
key-files:
  created:
    - hub/test/sessionCertify.test.ts
    - src/test/staffHubSessionKey.test.ts
  modified:
    - hub/src/append/rosterCache.ts
    - hub/src/append/checks.ts
    - hub/src/http/session.ts
    - hub/src/http/routes.ts
    - hub/src/limits.ts
    - src/domain/replica/hubFile.ts
    - src/domain/replica/hubWitness.ts
    - src/domain/team/signedPayload.ts
    - src/domain/staff/liveSentences.ts
    - src/staff/replica/hubTransport.ts
    - src/staff/replica/hubSync.ts
    - src/staff/replica/liveReplicator.ts
    - src/test/staffLiveReplicator.test.ts
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 28000
  tasks: 3
  commits: 2
completed: 2026-11-24
plan_head_before: 1253f2ab
plan_head_after: 7308ae64
---

# Phase 33 Plan 22: Session keys at your organization's server Summary

Your organization's server now takes a person's certified session key for sessions and appends, only while the certificate is before its `notAfter` by the server's clock and the person's device still stands. It refuses a person-key kind from a session key wherever it can read the entry, and it limits each device to four live certificates. The client signs its session with the session key, names and carries the certificate, pushes the certificate before the session key's own entries, and shows "Your session key has ended. Sign in again." when the key has ended.

## Base and branch

33-21 was pushed first (`451f7953`). `origin/main` had moved again (#180 the 33.1 native re-plan, #181 the Phase 47 site stack), so it was merged (`1253f2ab`). The one conflict was the ROADMAP progress table: this branch's Phase 33 row (2/20, in progress) was kept with main's Phase 33.1 row (0/17, planned). That merge was pushed before the 33-22 work was committed.

Step 0 check, at the base `1253f2ab`: `export function certifiedWriter` in sessionKeys.ts 1; `needs-update` in checks.ts 3; `restoring` in checks.ts 3. Each is at least what the plan asks.

## Refusal table as built

| Where | Answer | Status | When |
|---|---|---|---|
| Append, per entry | `not-admitted` | 200, in `refused` | a writer that is no roster device and has no placed certificate (as for any unknown writer today) |
| Append, per entry | `session-expired` | 200, in `refused` | the session key's certificate is at or past `notAfter` by the server's clock |
| Append, whole batch | `session-expired` | **403**, not retried | the pushing session key's own certificate has ended (its token normally ends first) |
| Append, per entry | `person-key-required` | 200, in `refused` | a session key's entry of a person-key kind, in the base cell or a cell granted to the server |
| Append, per entry | `revoked` / `quarantined` | 200, in `refused` | the certifying device is revoked, removed or quarantined at the server's head, or the session key's own log forked |
| Append, per entry | `too-many-sessions` | 200, in `refused` | a device's fifth `session.certify` while four of its certificates are before `notAfter` |
| Session answer | `session-expired` | 403 `session-refused` | the certificate has ended |
| Session answer | `revoked` / `quarantined` | 403 `session-refused` | the certifying device no longer stands |
| Session answer | `not-admitted` | 403 `session-refused` | no certificate, or not the one the fold places for this key, or another key's |
| Bearer token | `token-expired` | 401 | the token never outlives `notAfter` |
| Bearer token | `revoked` / `quarantined` | 401 | the certifying device stopped standing after the session opened |

The sentences: `session-expired` is "Your session key has ended. Sign in again." on the server and on the client. `person-key-required` is the fold's own sentence, "Only the person's own key can make this change."

## How it works

- **One fold.** The server's roster cache already folds the base stream with the extension's `foldRoster`, so it reads the certificates 33-21 places. `ProjectRoster.standing` covers a session key: its own log's places first, then its certifying device, then the fold's `certifiedWriter` at the head. `standingAt(writer, now)` adds `notAfter`. `accessList` includes a session key wherever its certifying device is, so reads, presence, event audiences and the append access check work for it unchanged.
- **The session answer carries the certificate.** A fresh session key has no certificate at the server yet, so it cannot be judged by a hash alone. The answer names the certificate's entry hash and carries the sealed entry. The server folds that entry over its roster, without storing it, and checks the chain to the person's device. Until the first push stores the certificate, the token stands where the certifying device stands. A device's answer carries neither field, so device sessions are byte for byte as before.
- **The first push.** `syncOnce` pushes a stream's device entries before any session key's, so the certificate (a device entry in the base stream) always goes first. In the server's batch check, a `session.certify` refolds the overlay, so the session key's later entries in the same batch are judged with it.
- **The client.** `HubTransportOptions.certificate` takes the certificate entry. `syncOnce` pulls and checks a session key's entries with its certified key, and the witness tracks session keys the roster vouches for. A `session-expired` answer ends the exchange `refused` with its sentence. The live replicator does not look again for an ended key (the person signs in again), and `liveSentences` words it the same way.
- **Restore mode.** A session key's checkpoint ask counts for its certifying device, so a hosted person still helps end restore mode.

## Decisions for the owner

1. **The session answer carries the certificate entry, not only its hash.** The plan's own Task 3 has a fresh session key open its session before its first push stores the certificate. A hash alone cannot be checked then, and the only other way in is an unauthenticated write path. Carrying the entry lets the server check the chain at session time without storing anything. The answer stays under its 8 KiB limit, and the sealed body is on the signer's generated-value list, so random base64url never trips the secret scanner.
2. **An unknown session writer stays `not-admitted` at the server.** The plan says "held as unknown-writer, as today". At the server, "as today" is `not-admitted`, which the client already retries. Clients still hold it as `unknown-writer`.
3. **The server refuses a person-key kind only where it can read the kind:** the base cell and any cell granted to it. Every client's fold refuses the rest (33-21). This follows the CR-01 rule: refuse only what the server can prove.
4. **Expired certificates are not pruned from the roster cache.** The plan asked to prune them from memory. The cache already holds every base-stream entry, so pruning would save almost nothing. Worse, a pruned certificate would turn `session-expired` into `not-admitted` once the cache reloads. The live limit bounds what one device can add at a time.
5. **A certificate must cite a roster the server holds.** In a hosted session the person's roster is already at the server. A certificate citing a newer roster is refused `not-admitted` until that roster reaches the server.

## Deviations from Plan

1. **[Rule 1] Token before the first push.** The first hub run showed that a fresh session key's token was refused at its first call, because the certificate was not stored yet. The token now carries the certifying device (`vouchedBy`) and stands where that device stands until the certificate is stored.
2. **[Rule 3] Files outside the plan's list:** `hub/src/http/routes.ts` (session-expired 403, the restore ask), `src/domain/replica/hubFile.ts` (the answer's certificate fields), `src/domain/team/signedPayload.ts` (the generated-value path), `src/domain/replica/hubWitness.ts` (session keys in the witness), `src/domain/staff/liveSentences.ts` and `src/staff/replica/liveReplicator.ts` (the sentence and no probe for an ended key), and `src/test/staffLiveReplicator.test.ts`.
3. **One commit for Tasks 1 and 2.** They change the same checks in `checks.ts`, `rosterCache.ts` and `session.ts`.
4. **No changes to `hub/test/append.test.ts` or `hub/test/session.test.ts`.** Every new case is in `sessionCertify.test.ts`. The existing files run unchanged and pass.
5. **Tests first:** the test files were written with the code. The first full hub run had the new tracer-session test failing for the reason in deviation 1, before the fix.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0 and choom; the hub ran on Node 26.13.1.

| Run | Result |
|-----|--------|
| Hub `npm run lint` and the full hub suite, first pass | lint exit 0; 433 tests: 429 passed, 1 failed (the session-before-first-push test, deviation 1), 3 skipped (the older-Node checks) |
| Hub: sessionCertify, session, append, limits, logging after the fix | 113 passed, 0 failed |
| Client: staffHubSessionKey, staffLiveTracer, staffLiveReplicator, staffLiveSentences, staffHubTransport, staffHubSyncLive, replicaHubFile, replicaHubWitness, replicaBoundaries, teamSignedPayload, copyLint, architecture, with `NEAR_AI_HUB_NODE` set | 240 tests: 239 passed, 1 failed (the real-hub test: the certificate cited a roster the server did not hold yet, decision 5). The test now syncs the person's roster first, as a hosted session does: 4 passed, 0 failed, over the real hub child. `npm run lint` exit 0. |
| Boundary run: every `replica*` and `staff*` extension test with teamSignedPayload, copyLint, architecture, hubIsolation and relayIsolation, real-hub tests on | **2008 passed, 0 failed, 0 skipped**; `npm run lint` exit 0 |
| Full hub suite again on the committed state | hub `npm run lint` exit 0; **433 tests: 430 passed, 0 failed, 3 skipped** (the older-Node checks, which need `NEAR_AI_HUB_OLD_NODE`) |

- **Tests added: 13.** `hub/test/sessionCertify.test.ts` has 8. `src/test/staffHubSessionKey.test.ts` has 4: the real-hub session and first push, session-expired to refused, the session answer's fields, and the push order. `staffLiveReplicator.test.ts` gained 1 (session-expired: refused and no probe).
- **Tests changed: 0.**
- `grep -c "session-expired" hub/src/append/checks.ts` is 3. `grep -c "liveSessionKeysPerDevice" hub/src/limits.ts` is 1. `hubTransport.ts` is 1156 lines. Both baselines are unchanged.

## Known Stubs

None. The workbench makes the session key and asks your organization's key store to certify it in 33-23. The native engine opens the transport with the certificate and the project with its signers in 33-24.

## Threat Flags

None beyond T-33-N1, T-33-N6 and T-33-N7. The new session-answer fields widen what the server parses before authentication. They are size-bounded, shape-checked, and the carried entry is only folded, never stored. No log line was added.

## Self-Check: PASSED

- The new files exist: `hub/test/sessionCertify.test.ts` and `src/test/staffHubSessionKey.test.ts`.
- The commits `34de713b` and `7308ae64` are in HEAD.
- `git diff --quiet` on both baselines against `1253f2ab`: unchanged.
