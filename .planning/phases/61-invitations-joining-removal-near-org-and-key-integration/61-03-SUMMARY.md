---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 03
subsystem: team-crypto
tags: [x25519, hkdf, aes-256-gcm, sealed-key, secret-detector, secretstorage]
status: complete

requires:
  - phase: 60-team-core-identity-signed-event-log-git-transport-roster
    provides: canonicalBytes, isStrictBase64url, assertNoSecrets, device identity storage pattern
provides:
  - src/team/keySeal.ts, node:crypto sealing of a key to one device (ephemeral X25519, ECDH, HKDF-SHA256, AES-256-GCM, AAD bound to team, member, device and key id)
  - X25519 seal identity in SecretStorage (nearAi.team.sealKey.<teamId>), deleted together with the Ed25519 device key
  - write-side detector exemptions for sealed nonce, tag and ciphertext by exact shape, and an X25519 PKCS#8 private key pattern
affects: [61-04, 61-05, 61-10, 61-11, 66]

plan_head_before: a6081336f8373c7e2f7332fa4bf4e07edfff42e9
plan_head_after: 76cfe2883f2bc8908d65d8e7a2c494866a55803d
actuals:
  tokens: 11200
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "a failed open is a verdict (undefined), never a throw, like verifySignature"
    - "sealTo re-rolls the ephemeral key and nonce when the draw would produce an entry the write-side detector flags or that holds the clear key, capped at 8 draws"
    - "detector exemption by exact key name and exact shape, with a token-prefix exclusion on ciphertext"

key-files:
  created:
    - src/team/keySeal.ts
    - src/test/teamSealedKey.test.ts
  modified:
    - src/team/identity.ts
    - src/domain/team/secrets.ts
    - src/test/teamSecrets.test.ts

key-decisions:
  - "sealTo takes plaintext of 16 to 512 bytes, the range that fits the detector's 22 to 700 character ciphertext exemption; anything else throws a plain error"
  - "The re-roll check uses findSecrets over the finished entry as well as the token-prefix and plaintext-containment checks, so the sealing side can never produce an entry the write guard would refuse"
  - "The randomness hook is a fourth positional parameter of sealTo (SealRandomness, default node:crypto), not part of the documented caller shape"
  - "A 16 character nonce cannot hold the 21 character X25519 PKCS#8 prefix, so the private-key check is meaningful for tag, ciphertext and publicKey-sized slots only"

requirements-completed: []  # TEAM-02 is only partly delivered here (sealing primitives); later plans finish it, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "A key sealed to a device opens only with that device's X25519 key loaded back from SecretStorage, and the sealed entry passes assertNoSecrets without holding the clear key"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamSealedKey.test.js#a key sealed to a device opens with the X25519 key loaded back from SecretStorage and the entry passes the write-side secret check"
        status: pass
    human_judgment: false
  - id: D2
    description: "The seal identity is stored as PKCS#8 DER base64 under nearAi.team.sealKey.<teamId>, a second create throws, and forgetDeviceIdentity removes both secrets"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamSealedKey.test.js#creating a seal identity stores one PKCS#8 X25519 key; #forgetDeviceIdentity removes the device key and the seal key together"
        status: pass
    human_judgment: false
  - id: D3
    description: "Changing team, member, device or key id in the context, or one character of nonce, tag, ciphertext or ephemeral key, or using another device's key, or a non-strict field, makes open return undefined without throwing"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamSealedKey.test.js (opening fails when ...; opening fails with another device private key; a field that is not strict base64url)"
        status: pass
    human_judgment: false
  - id: D4
    description: "1000 random sealed entries pass assertNoSecrets in a member.key-sealed shaped body and open again; a token-like first draw is rolled again; the cap throws after 8 identical bad draws"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamSealedKey.test.js#1000 sealed entries ...; #a draw whose ciphertext starts like a token is rolled again"
        status: pass
    human_judgment: false
  - id: D5
    description: "The detector exempts nonce, tag and ciphertext only by exact shape under exact key names, still catches a clear key under ciphertext (sk-, rt_, rpt-, adm_, oc_, sk_live_, JWT) and any stored X25519 or Ed25519 private key"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamSecrets.test.js (x25519 private keys ...; strict sealed shapes ...; a sealed field with the wrong length ...; a clear key or token placed under ciphertext ...)"
        status: pass
    human_judgment: false
---

# Phase 61 Plan 03: Sealed key delivery Summary

**A NEAR API key can be sealed to exactly one device (ephemeral X25519, ECDH, HKDF-SHA256, AES-256-GCM with team, member, device and key id as AAD), carried in the public log, and opened only by that device's SecretStorage key; the write-side secret guard accepts the sealed shapes and still refuses clear keys and stored private keys.**

## What was built

- `src/team/keySeal.ts`: `SEAL_SCHEME`, `SealedEntry`, `SealContext`, `sealContextBytes` (canonical bytes of purpose, team, member, device, key id), `sealTo`, `openSealed`, `wipe`. The HKDF salt is the ephemeral public key then the recipient public key; the info string is `near-ai/team-key-seal/v1`. Shared secret and derived key buffers are zero-filled after use.
- `src/team/identity.ts`: `SEAL_KEY_SECRET_PREFIX`, `sealKeySecretName`, `SealIdentity`, `createSealIdentity`, `loadSealIdentity`. `forgetDeviceIdentity` now deletes the seal key too, with the same signature.
- `src/domain/team/secrets.ts`: X25519 PKCS#8 pattern (`MC4CAQAwBQYDK2VuBCIEI`) in `SECRET_PATTERNS` and in the private-key-material check; exemptions for `nonce` (16 chars), `tag` (22 chars) and `ciphertext` (22 to 700 chars, not starting with a token prefix).

## Tasks

| Task | Name | Commits |
| ---- | ---- | ------- |
| 1 | Tracer: seal to a device whose X25519 key lives in SecretStorage, open it, pass the secret check | 6578eed (RED), 014feb0 (GREEN) |
| 2 | Binding, tamper and detector tests, including 1000 random sealed entries | 76cfe28 |

Tracer gate (auto mode): the tracer's verify command was re-run end to end and passed before Task 2 began.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] sealTo size and shape limits**
- **Found during:** Task 1
- **Issue:** The detector exempts ciphertext only up to 700 characters and from 22, and a recipient key that is not a strict 32 byte value would fail late with an opaque crypto error.
- **Fix:** `sealTo` throws a plain error for plaintext outside 16 to 512 bytes and for a recipient key that is not a strict 43 character base64url value.
- **Files modified:** src/team/keySeal.ts
- **Commit:** 014feb0

**2. [Rule 2 - Missing critical functionality] Re-roll also on any detector hit**
- **Found during:** Task 1
- **Issue:** The plan named only the plaintext-containment and token-prefix checks; a draw whose nonce, tag or ephemeral key tripped another detector pattern would make a later write fail.
- **Fix:** `leaksClearKey` also runs `findSecrets` over the finished entry.
- **Files modified:** src/team/keySeal.ts
- **Commit:** 014feb0

**3. [Ordering] The randomness hook landed in Task 1, not Task 2**
- **Issue:** Task 2 describes adding the hook; it was built together with `sealTo` because the re-roll loop needs the randomness source as an argument.
- **Effect:** Task 2 contained only tests (the re-roll tests passed on first run because the behaviour already existed). No coverage was lost; the forced-first-draw test and the cap test exercise it.
- **Commits:** 014feb0, 76cfe28

**4. [Test correction] X25519 key in a nonce slot**
- A 16 character nonce cannot hold the 21 character private-key prefix, so a test that expected a finding there was wrong; it now asserts only the tag is reported. Not a product change.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or file access; the new SecretStorage key `nearAi.team.sealKey.<teamId>` is covered by the plan's threat model (T-61-11 to T-61-14). T-61-14 (ciphertext permanence) is accepted and relies on plans 61-10 and 61-11 to revoke every sealed key on removal and rotate on device change.

## Verification

- `npx tsc -p tsconfig.json && node --test dist/test/teamSealedKey.test.js dist/test/teamIdentity.test.js dist/test/teamSecrets.test.js`: 56 pass, 0 fail (teamIdentity and the earlier teamSecrets tests unchanged).
- `node --test dist/test/team*.test.js`: 442 pass, 0 fail.
- `npm run lint` exits 0. No `vscode` import in `src/team/keySeal.ts`. No package changes.

## Self-Check: PASSED

- FOUND: src/team/keySeal.ts, src/test/teamSealedKey.test.ts, src/team/identity.ts, src/domain/team/secrets.ts, src/test/teamSecrets.test.ts
- FOUND commits: 6578eed, 014feb0, 76cfe28 (ancestors of HEAD)
