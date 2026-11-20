---
phase: 32-your-organizations-sync-hub
plan: 15
subsystem: replica (hub-side signed shapes)
status: complete
tags: [sync-hub, signed-payload, tls-binding, enrolment, invitation, hkdf]
requires: [32-01..32-13 merged on feat/phase-32-sync-hub]
provides:
  - "src/domain/replica/hubFile.ts: HUB_FILE_EXTENSION, HUB_FILE_REFUSALS, hubIdOf, isHubAddress, spkiPin, certPinOf, buildHubFile, readHubFile, SESSION_KEYING_LABEL, SESSION_KEYING_BYTES, CHALLENGE_BYTES, SESSION_REFUSALS, buildSessionAnswer, readSessionAnswer, enrolmentMac, checkEnrolmentMac"
  - "src/domain/replica/invite.ts: InviteHub, InvitePayload.hub, HUB_JOIN_INFO, hubJoinCheckKey, joinRequestHash, hubJoinMac, checkHubJoinMac, buildHubJoin, readHubJoin"
  - "src/domain/team/signedPayload.ts: purposes staff-hub-session, staff-hub-file, staff-hub-join and their GENERATED_PATHS"
affects: [32-19 enrolment, 32-20 sessions, 32-23 hub transport, 32-24 admitHub, 32-25 join through the hub]
tech-stack:
  added: []
  patterns: ["read hostile input as in invite.ts: size cap before parse, own properties, exact keys, fresh result objects", "constant-time MAC and keying compares", "HKDF-derived per-invitation check key so the hub never holds the join secret"]
key-files:
  created: [src/domain/replica/hubFile.ts, src/test/replicaHubFile.test.ts]
  modified: [src/domain/replica/invite.ts, src/domain/team/signedPayload.ts, src/test/replicaBoundaries.test.ts, src/test/replicaInvite.test.ts, src/test/teamSignedPayload.test.ts]
decisions:
  - "Session answer and hub join name the hub by its writer id (64 hex, D-35); the enrolment MAC names it by its hub id (hub- plus 16 hex), the slug hub.admit carries."
  - "buildInvite copies only address, certPin and writer from input.hub; an extra property of the caller's object is dropped, while readInvite refuses a hub with an extra key as malformed."
  - "readHubJoin also checks the posted join request's own signature (defence in depth); 32-25 still checks it as its plan says."
  - "isHubAddress uses node:net isIPv6 for bracketed IPv6 (pure, a Node built-in); the header names it."
  - "buildHubFile refuses an expiry that is not after now."
metrics:
  duration: "18 min"
  completed: 2026-11-20
estimate:
  tokens: 60031
  tasks: 3
actuals:
  tokens: 21281
  tasks: 3
  commits: 5
plan_head_before: fc3e6f0811c89d01cc46531f64f96313b59a8943
plan_head_after: afedc2357615562a60c8093a5c676423d074ddc9
---

# Phase 32 Plan 15: Hub file, session answer, enrolment MAC and hub join shapes Summary

One pure, hub-side definition of every signed item the sync hub and its clients exchange: the operator's `.near-staff-hub` file signed by the hub's own key, a session answer bound to one hub, project, challenge and TLS connection, the enrolment HMAC, the invitation's optional hub field, and an HKDF check key plus hub MAC and join envelope that let the hub check join requests without ever holding the join secret.

## What was built

- **Three purposes (D-60).** `PAYLOAD_PURPOSES` ends with `staff-hub-session`, `staff-hub-file`, `staff-hub-join`. `GENERATED_PATHS` exempts only `$.(challenge|keying)`, `$.(x25519|x25519Sig|enrolmentSecret)` and `$.hubMac`; private key material is still refused there, and address/project are still checked.
- **Hub file (D-41).** `buildHubFile` / `readHubFile`: payload `{v, hub, address, certPin, publicKey, writer, x25519, x25519Sig, enrolment, enrolmentSecret, expiresAt}`, `hub = hubIdOf(writer)`. Refusals `malformed`, `too-large` (16 KiB, before parsing), `bad-signature` (any field, or a signer other than the named key), `bad-binding`, `expired`. No message carries the secret.
- **Certificate pin (D-29, D-51).** `spkiPin(key)` and `certPinOf(pemOrDer)` hash the SPKI DER, so a renewed certificate with the same key keeps its pin.
- **Session answer (D-35).** `buildSessionAnswer` / `readSessionAnswer` with `SESSION_KEYING_LABEL = 'near-ai-hub-session/v1'`, 32-byte challenge and keying. The hub passes the values it expects (bytes or base64url text). Refusals: `malformed`, `bad-signature`, `wrong-hub`, `wrong-project`, `wrong-challenge`, `wrong-connection`. Challenge and keying are compared in constant time.
- **Enrolment MAC (D-41).** `enrolmentMac` / `checkEnrolmentMac`: HMAC-SHA256 over the canonical `{enrolment, hub, project, genesisHash, rosterHead}`. The check runs in constant time and returns false (never throws) on bad input.
- **Invitation hub field (D-47).** `InvitePayload.hub?: {address, certPin, writer}`, read with exact keys. A Phase 31 invitation reads deep-equal to its previous result.
- **Hub join (D-48).** `hubJoinCheckKey = HKDF-SHA256(secret, empty salt, 'near-ai/hub-join/v1' || invite id, 32)`, `joinRequestHash`, `hubJoinMac` / `checkHubJoinMac`, `buildHubJoin` / `readHubJoin` (signer must be the request's device, the request hash and invite id must agree; INVITE_REFUSALS ids).
- **Boundary (D-27).** `HUB_SIDE` lists `domain/replica/hubFile`. A new test proves its closure has no Yjs and no doc.ts.

## Tests (failing first)

| Task | Evidence before the change | After |
|------|----------------------------|-------|
| 1 | `npm run compile` failed: TS2307 "Cannot find module '../domain/replica/hubFile'"; TS2353 `'staff-hub-session'` not in `Record<PayloadPurpose>`; TS2322 for each new purpose | replicaHubFile 11 + teamSignedPayload 26: 37/37 pass |
| 2 | TS2305 for each missing export (`buildSessionAnswer`, `readSessionAnswer`, `enrolmentMac`, `checkEnrolmentMac`, `SESSION_*`, `CHALLENGE_BYTES`). With the compiled JS, the new boundary test `32-15: the hub file and session module is hub-side...` failed (1 of 33) because HUB_SIDE did not list it. Exemption teeth (D-66 mutation): deleting the three Phase 32 GENERATED_PATHS lines made 4 tests fail (round-trip, D-60 wrong-purpose, generated random fields, real token shapes), and restoring them made all pass | 52/52 pass (hubFile 19 incl. `wrong-connection`) |
| 3 | TS2305/TS2724 for `HUB_JOIN_INFO`, `buildHubJoin`, `checkHubJoinMac`, `hubJoinCheckKey`, `hubJoinMac`, `joinRequestHash`, `readHubJoin`, `InviteHub`, `HubJoinMacFields`, `HubJoinPayload`; TS2339 `hub` not on `InvitePayload`; TS2353 `hub` not on `BuildInviteInput` | replicaInvite 33 (was 24, +9) |

Final plan verification under the memory cap: replicaInvite, replicaHubFile, teamSignedPayload, replicaBoundaries and staffReplicaMembership passed 128/128 (0 fail, 0 skipped), and `tsc --noEmit` exited 0. I also ran the neighbouring replicaCellLeak, replicaCellKeys, replicaRosterTracer, replicaRoster, staffMultiUserCommands, staffReplicaCopy, staffReplicaProject and teamSecrets suites: 159/159 pass.

Acceptance greps: `'staff-hub-file'` in signedPayload.ts = 2 (needed at least 1). `'domain/replica/hubFile'` in replicaBoundaries.test.ts = 1. `near-ai/hub-join/v1` in invite.ts = 1.

## Commits

- 9faa954a feat(32-15): hub file purpose, three Phase 32 signed purposes and the certificate pin
- bfd1021e feat(32-15): session answer bound to the TLS connection, enrolment MAC, hubFile hub-side
- 7d05d434 feat(32-15): invitation hub field, hub check key, hub MAC and hub join envelope
- e1d5e91c test(32-15): write the em-dash checks of the hub file tests as escapes
- afedc235 refactor(32-15): name the hub join info once and the hub-side entry once

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Literal em-dash characters in test assertions**
- **Found during:** final checks after Task 3
- **Issue:** The "no em-dash" checks in replicaHubFile.test.ts had the character written literally, which breaks the no-em-dash rule for repo files.
- **Fix:** Wrote them as `\u2014` escapes. The behaviour is the same.
- **Commit:** e1d5e91c

**2. [Rule 3 - Blocking] Acceptance grep counts**
- **Issue:** The invite.ts header repeated the HKDF info text, and the boundary test repeated the HUB_SIDE literal, so two exact-count greps read 2 instead of 1.
- **Fix:** The header now names `HUB_JOIN_INFO`, and the test checks the stem through `stemOf`.
- **Commit:** afedc235

### Choices within the plan
- I added the GENERATED_PATHS entries in Task 1, as the plan's action says, so that hub files with random fields never fail at random. The Task 2 exemption tests therefore show their teeth through the D-66 mutation recorded above, not through a failing run on unchanged code.
- `readSessionAnswer` has no `too-large` reason: answers over 8 KiB are refused `malformed`, which keeps the plan's six reasons.
- A stated D-29 mutation: if `certPinOf` hashed the whole certificate DER instead of the SPKI, the "two certificates for one key share a pin" test would fail. The test asserts that the two certificate hashes differ.

## Decisions
The owner accepted every default in 32-CONTEXT.md, and this plan had no checkpoints. The decisions above are recorded in the frontmatter `decisions` list.

## Threat Flags
None. Everything added is pure, with no new endpoints or I/O. The planned mitigations T-32-54 to T-32-57 are each covered by the tests above. No package was installed (T-32-SC).

## Known Stubs
None.

## Self-Check: PASSED
- FOUND: src/domain/replica/hubFile.ts, src/test/replicaHubFile.test.ts
- FOUND commits: 9faa954a, bfd1021e, 7d05d434, e1d5e91c, afedc235 (all ancestors of HEAD)
