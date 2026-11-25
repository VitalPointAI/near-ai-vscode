---
phase: 33-live-multi-user-staff-projects
plan: 21
status: complete
subsystem: session-key certificates, the fold rules and asynchronous person-key signing (engine half of P7)
tags: [staff, replica, session-keys, person-key, d-60, d-62, mus-09]
requires: [33-03, 33-05]
provides: [session.certify, kindSchemas/session.ts, sessionKeys.ts, PERSON_KEY_KINDS, isPersonKeyKind, SESSION_REFUSALS, certificateProblem, certifiedWriter, sessionRefusal, sessionBindingBytes, sessionCertifyData, SESSION_MAX_LIFETIME_MS, RosterState.sessions, RosterView.sessionCertificate, RosterView.deviceQuarantines, VerifiedEntry.session, AsyncPayloadSigner, signPayloadAsync, signHeaderAsync, buildEntryAsync, ReplicaProjectDeps.sessionSigner, ReplicaProjectDeps.personSigner, ReplicaProject.signerOf, AppendOwnOptions.signer, anchorFile.ts]
affects: [33-22, 33-23, 33-24, 33-26]
tech-stack:
  added: []
  patterns: [certificate folded beside the roster line and never on it, first placed wins in a fixed order, proof of possession by the certified key, one person-key list for every fold and the server, clock-free fold with the lifetime checked from signed times]
key-files:
  created:
    - src/domain/replica/kindSchemas/session.ts
    - src/domain/replica/sessionKeys.ts
    - src/staff/replica/anchorFile.ts
    - src/test/replicaSessionCertify.test.ts
    - src/test/staffPersonKeySigning.test.ts
  modified:
    - src/domain/replica/kinds.ts
    - src/domain/replica/roster.ts
    - src/domain/replica/rosterMembers.ts
    - src/domain/replica/rosterView.ts
    - src/domain/replica/verify.ts
    - src/domain/replica/textFold.ts
    - src/domain/replica/productCells.ts
    - src/domain/replica/entry.ts
    - src/domain/team/signedPayload.ts
    - src/staff/replica/replicaProject.ts
    - src/staff/replica/versionActs.ts
    - .dockerignore
    - src/test/replicaBoundaries.test.ts
    - src/test/replicaKinds.test.ts
    - src/test/replicaTracer.test.ts
    - src/test/replicaProductCells.test.ts
    - src/test/replicaContracts.test.ts
    - src/test/replicaRoster.test.ts
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 30000
  tasks: 3
  commits: 2
completed: 2026-11-24
plan_head_before: 4dd90c92b685229a748e27ecf705df0ef5f5d9a0
plan_head_after: d270edca
---

# Phase 33 Plan 21: Session-key certificates (engine half) Summary

A person's short-lived session key, certified by one of that person's own devices, now writes the person's ordinary work into shared work, and every fold credits it to that person. Decisions and roster changes still need the person key: a session key that tries one is kept and does nothing. Revoking or quarantining the certifying device stops the session key from that point on, and the fold reads no clock. Person-key entries can be signed through an asynchronous signer, which is what your organization's key store needs.

## Base and branch

The work started from `origin/feat/phase-33-engine-wave-1` at `67d88c91` (33-12), with `origin/main` merged first (`4dd90c92`, no conflicts: #174 to #178, the 0.4.38 release, #175 and #176). It is pushed with `HEAD:feat/phase-33-engine-wave-1`.

Step 0 check: `isRosterWriterAt` 1, `'roster.require'` in kinds.ts 1, `nextClientId` 1. `grep -c "roster:" kinds.ts` gave 2, not 1, because `FAMILY_VALIDATORS` also has a `roster:` line (it was there before 33-03). Every name the plan reads was found, so the work went ahead.

## session.certify as built (one-way door)

`session.certify { member, device, sessionKey, slot, notAfter, sessionSig }` is the one kind of a new `session` family, with its own validator file (`kindSchemas/session.ts`). It is written by the certifying device itself, in the roster cell (the project's base stream), and never takes a roster position.

| Field | Rule |
|---|---|
| `member` | slug; must be the member of the signing device, active at the cited roster |
| `device` | 64-hex writer id; must be the entry's own writer |
| `sessionKey` | raw Ed25519 public key, 32 bytes base64url; its hash is the session writer id; it may not be a roster device's key |
| `slot` | 1 to 4095; must be the certifying device's own slot (its client ids then come from it, D-41) |
| `notAfter` | ISO time; after the entry's signed `at` and at most 24 hours after it (`SESSION_MAX_LIFETIME_MS`; the workbench asks for 12) |
| `sessionSig` | 64-byte Ed25519 signature by the session key over `sessionBindingBytes`: `near-ai/session-certify/v1`, a newline, then canonical `{ project, member, device, sessionKey, slot, notAfter }` |

Placement (roster fold, after the line): certificates are taken oldest cited roster first, then by entry hash, so every machine and the server place the same ones. A certificate citing a roster off the line waits (`missing-roster` or `roster-branch-not-chosen`). The first certificate placed for a session key wins; any other for the same key, from another device or the same one, is refused `session-key-reused`. A certificate made while its device is removed or quarantined is refused `session-device-stopped`; any other mismatch is `session-certificate-invalid`.

## The fold rule

`verify.ts` checks a roster device first. Only when the writer is no roster device does it look for a placed certificate, and then it checks the header with the certified key. The entry's member is the certificate's member, and `VerifiedEntry.session` carries the certifying device and slot. The text fold accepts a session writer's `doc.client` ids from that device's slot.

An entry by a certified session key changes nothing (kept, chain intact) when:
- its kind is a person-key kind: `person-key-required`;
- at the roster it cites, the certifying device is revoked, removed or quarantined, or a quarantine of that device applied after the certificate: `session-device-stopped`. An entry citing an earlier roster keeps folding.

A session key's roster changes and certificates are also refused `person-key-required` in the roster fold itself, so the roster never moves for them. Nothing in `sessionKeys.ts` reads the clock (`grep -c "Date" src/domain/replica/sessionKeys.ts` is 0); `notAfter` is for the server only.

## PERSON_KEY_KINDS as built

`project.genesis`, every roster kind (`member.invite`, `member.admit`, `member.update`, `member.remove`, `device.add`, `device.rotate`, `device.revoke`, `device.quarantine`, `device.release`, `hub.admit`, `hub.grant`, `hub.revoke`, `cell.create`, `cell.rekey`, `lead.handover`, `roster.choose`, `deputy.name`, `invite.void`, `roster.require`, `hub.readmit`), `session.certify`, `version.decide`, `version.release`, `version.supersede`, `version.withdraw`. Typing (`doc.client`, `doc.update`), `doc.compact`, `version.propose`, `version.verdict` and `version.submit` are not on it.

## Asynchronous signing and the project's signers

- `AsyncPayloadSigner { fingerprint, publicKey, sign(bytes): Promise<string | { refused }> }` and `signPayloadAsync` share every check with `signPayload` (one prepare step, one finish step), so the same key gives the same envelope.
- `signHeaderAsync` gives exactly the header `signHeader` gives. `buildEntryAsync` seals the body the same way as `buildEntry` and signs through it; a refusal comes back as it is and nothing is built.
- `ReplicaProjectDeps.sessionSigner` and `personSigner` (both optional). `ReplicaProject.signerOf(kind)` picks the person signer for a person-key kind when set, then the session key, then this device. With neither set, a single machine signs everything with its device key, as before.
- `appendOwn` takes an optional `signer`. An entry signed by this device goes through the store's own path as before; another key's entry (the session key's) is stored through the received path with the decode check.
- `versionActs` signs with `signerOf(kind)` and leaves out of its dependencies only the acts already on that signer's own chain. A refusal from the person signer returns `{ ok: false, reason: 'signer-refused', message: <the signer's text unchanged> }` and nothing is written.

## replicaProject.ts

It went from 1196 lines to 1148. The genesis pin and project.json helpers (`genesisPinFile`, `projectFile`, `anchorOf`, `sameAnchor`, the pin readers and writers) moved to `anchorFile.ts` (84 lines) and are re-exported, so no import changed. The signer hooks then added 23 lines. There are 52 lines of room under 1200 for later plans.

## Decisions for the owner

1. **Proof of possession in the certificate (`sessionSig`).** D-62 lists five fields. Without a signature by the session key, any member's device could certify another person's session key under its own member: that person's typing would be credited to someone else, and the real certificate would then be refused as reused. The added field follows the existing `x25519Sig` binding of `device.add`. Because the schema is a one-way door, this had to be settled now.
2. **A 24-hour ceiling on a certificate's lifetime**, judged from signed times only (`at` to `notAfter`). The fold stays clock-free, and a stolen session key cannot be given a long life by a compromised session.
3. **Session refusals are kept entries, not reducer refusals.** `person-key-required` and `session-device-stopped` are keep reasons, like `unauthorised`, so the session writer's chain stays intact and later ordinary entries still fold. In the roster fold, a session key's roster change is a refusal, like any roster change by a non-writer.
4. **Quarantine stops a session key for good from that position.** After a release, the person makes a new session key; a certificate made after the release works.

## Deviations from Plan

1. **[Rule 2, security] `sessionSig` added to the certificate** (decision 1 above).
2. **[Rule 3] Files outside the plan's list:** `rosterMembers.ts` (positions of quarantines and releases), `textFold.ts` (session client ids from the certifying device's slot), `productCells.ts` (session.certify is allowed in the base cell), `.dockerignore` (the hub image's closure), `anchorFile.ts` (moved code), and the count tests listed below.
3. **One commit for Tasks 1 and 2.** They change the same functions in `verify.ts` and `roster.ts`.
4. **"Identical to buildEntry":** the sealed body uses a random IV (D-32), so two builds never give the same bytes. The test checks that the same unsigned header gets the same signature through both paths, and that the asynchronous entry verifies and opens.
5. **Tests first:** the test files were written with the code. They could not run red on the base, which has no `sessionKeys.ts` to compile against.
6. **The 15-line budget in `replicaProject.ts`:** the hooks took 23 lines, after 71 lines had been moved out, so the file is 48 lines shorter than before.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0 and choom.

| Run | Result |
|-----|--------|
| Task 1 and 2: replicaSessionCertify, replicaBoundaries | 18 passed, 0 failed |
| Every `replica*` and `staffReplica*` file with staffSharedVersionActs, copyLint and architecture | 1063 passed, 2 failed: a kind count (50 to 51) and a quarantine deep-equal that now also sees the quarantine's position. Both updated with their reasons. |
| Re-run of those two files with replicaVersionDecisions and staffReplicaParity | 74 passed, 0 failed |
| Task 3: staffPersonKeySigning, staffSharedVersionActs, staffReplicaParity, copyLint, architecture, teamSignedPayload, every replica*, staffReplica*, staffLabel*, staffMultiUser*, staffHub*, staffLive* file, staffCompactor, staffContested | 1296 tests: 1293 passed, 0 failed, 3 skipped (the real-hub tracer tests without `NEAR_AI_HUB_NODE`) |
| `npm run lint` | exit 0 |
| Full hub suite and `npm run lint` in hub/ on Node 26.13.1 (run with 33-22's work in the tree) | lint exit 0; 433 tests: every existing test passed (429 passed, 3 skipped: the older-Node checks); the one failure was a new 33-22 test, fixed in 33-22 |

- **Tests added: 16.** `replicaSessionCertify.test.ts` has 11 (tracer, no certificate, invalid certificates, the person-key list, person-key kinds refused, ordinary kinds verify, revoke, quarantine and release, reused key, client ids, no clock). `staffPersonKeySigning.test.ts` has 5.
- **Tests changed: 5**, none weakened: the kind count in replicaKinds, replicaTracer, replicaProductCells and replicaContracts (53 to 54 kinds, 50 to 51 non-doc kinds, and the base cell now allows the session family), and the replicaRoster quarantine test, which now also checks the quarantine's recorded position.
- `git diff --quiet` on both baselines: unchanged.

## Known Stubs

None. Making the session key and asking your organization's key store to sign are 33-23; the native engine opens a project with its signers in 33-24.

## Threat Flags

None beyond T-33-N1, T-33-N2, T-33-N4 and T-33-N5. Note for 33-22 and later: an equivocation proof can only name a roster device's key, so a session key that forks its own chain is stopped by the server's places record and the certifying device's revocation, not by a fold quarantine.

## Self-Check: PASSED

- The new files exist: `kindSchemas/session.ts`, `sessionKeys.ts`, `anchorFile.ts`, `replicaSessionCertify.test.ts`, `staffPersonKeySigning.test.ts`.
- The commits `a2f11830` and `d270edca` are in HEAD.
