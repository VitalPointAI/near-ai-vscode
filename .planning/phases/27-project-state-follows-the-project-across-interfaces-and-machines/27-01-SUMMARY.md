---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 01
subsystem: state-sync
tags: [crypto, aes-gcm, scrypt, hkdf, brotli, padme, recovery-code, manifest]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-CONTEXT decisions D-02, D-09 and 27-RESEARCH Patterns 3, 4, 5 (no code dependency; wave 1)"
provides:
  - "src/domain/state/recoveryCode.ts: RECOVERY_CODE_BYTES (32), RECOVERY_CODE_CHARACTERS (52), generateRecoveryCode, formatRecoveryCode, parseRecoveryCode"
  - "src/domain/state/keys.ts: KDF_PARAMS, SCRYPT_MAXMEM, KdfParams, KdfRecord, SealedBlob, StateKeyPurpose, newDataKey, newSalt, newStateId, assertKdfParams, deriveKek, subKey, aadFor, seal, open, sealRaw, openRaw, wrapDataKey, unwrapDataKey, StateRefusedError"
  - "src/domain/state/objects.ts: ObjectClass, ObjectEntry, SealedPart, OpenPart, OBJECT_MAGIC, MIN_PADDED_BYTES, MAX_PART_BYTES, OBJECT_NAME, TREE_NAME, padmeLength, sealObject, openObject, ManifestHeader, SealedManifest, buildManifest, readManifestHeader, openManifest"
affects: [27-03, 27-11, 27-12, 27-13, 27-15, sync, restore, recovery-code-screen]

actuals:
  tokens: 12162
  tasks: 3
  commits: 4
plan_head_before: 17b5427f61fbe06559398ba0e43dbc0128962426
plan_head_after: d62e034499a097b91fb17153b7a97b5786bf4270

tech-stack:
  added: []
  patterns:
    - "Symmetric cryptography only: AES-256-GCM, HKDF-SHA256, scrypt over a generated code, so the sync format has no public-key step to harvest (D-18)"
    - "One HKDF subkey per object from a random 16-byte salt, plus a random 96-bit IV and AAD binding project, class, part index and part count"
    - "Every refusal is one StateRefusedError with a plain sentence and a reason code; nothing partial is returned"
    - "Check order before any plaintext leaves: complete set of parts, present, byte count, sha256 (timingSafeEqual), AEAD tag, length prefix, 256 MiB decompression limit"

key-files:
  created:
    - src/domain/state/recoveryCode.ts
    - src/domain/state/keys.ts
    - src/domain/state/objects.ts
    - src/test/stateRecovery.test.ts
    - src/test/stateObjects.test.ts
  modified:
    - .planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-01-PLAN.md
    - .planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/27-CONTEXT.md

key-decisions:
  - "Task 1 wire contract: owner chose adjust with exactly one changed value. Recovery code is 256 random bits (crypto.randomBytes(32)), 52 Crockford base32 characters in 13 groups of 4, not 160 bits / 32 characters / 8 groups. Recorded as D-18 in 27-CONTEXT.md."
  - "The 52 characters carry 260 bits, so the 4 leading pad bits are zero when encoding (the first character is always 0 or 1) and parseRecoveryCode returns undefined for a code whose pad bits are non-zero, refused like any wrong code"
  - "Everything else in the contract is as proposed: ref refs/heads/near-ai/state, scrypt N=2^17 r=8 p=1 with a 16-byte salt and 32-byte key recorded as kdf, AES-256-GCM, per-object HKDF-SHA256 key with info near-ai/state/v1/object, NAS1 objects with Padme buckets (8 per octave, 64 KiB floor, 8 MiB parts), manifest.json the only plaintext file"
  - "The kdf bound also caps scrypt memory (128*N*r at most 256 MiB), so a hostile manifest cannot ask for more than the cap even inside the N and r ranges"
  - "A wrong code and a damaged wrap are one refusal (wrong-code-or-damaged) because they cannot be told apart cryptographically; an empty or wrong-length code parses to undefined and the caller refuses it with that same message"

patterns-established:
  - "Pure state modules under src/domain/state take and return Buffers and strings; sealing, wrapping and opening never touch files or git"
  - "Property-style cases use a seeded xorshift generator, never Math.random, so a failure reproduces"

requirements-completed: [SYNC-03, SYNC-04, SYNC-05]

coverage:
  - id: D1
    description: "Task 1 wire contract confirmed by the owner (adjust: recovery code 256 bits, 52 characters, 13 groups) and recorded as D-18"
    verification: []
    human_judgment: true
    rationale: "An owner decision recorded in the planning files; no test asserts a decision was made"
  - id: D2
    description: "A recovery code is 256 generated bits shown as 52 Crockford characters in 13 groups of 4, with zero pad bits and a tolerant parser (case, spaces, hyphens, I/L as 1, O as 0); empty, whitespace, wrong-length, foreign-character and non-zero-pad-bit input parses to undefined"
    requirement: SYNC-04
    verification:
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#a recovery code is 256 generated bits shown as 52 characters in 13 groups of 4"
        status: pass
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#parseRecoveryCode reads the shown form, lowercase, no hyphens, spaces, and I/L/O typed for 1/1/0 as the same 32 bytes"
        status: pass
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#a code whose 4 leading padding bits are not zero is refused like a wrong code"
        status: pass
    human_judgment: false
  - id: D3
    description: "Tracer: code to scrypt key-encryption key to wrapped data key to sealed object to manifest and back returns the original payload, using a typed-differently spelling of the code"
    requirement: SYNC-04
    verification:
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#tracer: code to key-encryption key to wrapped data key to sealed object to manifest and back"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every refusal is one StateRefusedError with no partial plaintext: wrong code, tampered manifest, tampered object, truncated object, missing object, object sealed for another project or class, rolled-back seq, unsupported format, hostile kdf cost"
    requirement: SYNC-04
    verification:
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#a flipped byte in the wrapped key is wrong-code-or-damaged, and the right code unwraps"
        status: pass
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#an object cut short is truncated, detected before decryption"
        status: pass
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#a manifest older than the last one seen is rolled-back; the same or newer is fine"
        status: pass
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#a kdf record that asks for a huge or tiny cost is refused before any scrypt call"
        status: pass
      - kind: unit
        ref: "dist/test/stateObjects.test.js#an object sealed for one project does not open for another, and a hot object does not open as cold"
        status: pass
    human_judgment: false
  - id: D5
    description: "Padding: objects in one Padme bucket have identical byte length, overhead at most 12.5% above a 64 KiB floor over 200 seeded lengths, parts never exceed 8 MiB plus the envelope, measured in bytes of compressed UTF-8 JSON"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/stateObjects.test.js#padmeLength never shrinks, stays within 12.5% above the 64 KiB floor, and lands on 8 buckets per octave"
        status: pass
      - kind: unit
        ref: "dist/test/stateObjects.test.js#a payload over 8 MiB compressed is split into parts, none above 8 MiB plus the envelope, and opens whole"
        status: pass
      - kind: unit
        ref: "dist/test/stateObjects.test.js#padding and part limits are measured in bytes of the compressed UTF-8 JSON, not in characters"
        status: pass
    human_judgment: false
  - id: D6
    description: "No thread title, record id, model name or prompt text appears in the plaintext manifest or an object name; the plaintext manifest has exactly five keys and the object names are 128 random bits as hex"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "dist/test/stateRecovery.test.js#no thread title, record id, model name or prompt appears in the plaintext manifest or an object name"
        status: pass
    human_judgment: false
  - id: D7
    description: "A decompression bomb inside an authentic object is refused at the 256 MiB limit"
    requirement: SYNC-04
    verification:
      - kind: unit
        ref: "dist/test/stateObjects.test.js#an authenticated object that would expand past 256 MiB is refused instead of exhausting memory"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 01: Encrypted Wire Contract Summary

**A 256-bit generated recovery code unlocks, through scrypt (N=2^17) and a wrapped data key, padded AES-256-GCM objects with per-object HKDF subkeys and a sealed manifest, built from Node built-ins only, with every wrong-code, tamper, truncation, swap and rollback case refused as one plain StateRefusedError.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-11-13T13:49:30Z
- **Completed:** 2026-11-13T13:57:30Z
- **Tasks:** 3 (Task 1 resolved by the owner before dispatch)
- **Files modified:** 7 (5 created, 2 planning files edited)

## Task 1 decision record

Task 1 was a `checkpoint:decision` on the published wire contract. The owner resolved it before dispatch: **option `adjust`, one changed value.**

- **Changed:** item 2, the recovery code. It is now **256 random bits** (`crypto.randomBytes(32)`), shown as **52 Crockford base32 characters in 13 groups of 4**. The proposal was 160 bits, 32 characters, 8 groups.
- **Pad bits:** 52 characters carry 260 bits, so the 4 leading pad bits are zero when encoding (the first character is always `0` or `1`), and the parser refuses a code whose pad bits are non-zero, with the same plain message as a wrong code. Typing tolerance is unchanged. The code is still always generated, never chosen or shortened.
- **Unchanged:** ref `refs/heads/near-ai/state`; scrypt N=2^17, r=8, p=1, 16-byte salt, 32-byte key, recorded as `kdf`; AES-256-GCM, 96-bit IV, 128-bit tag; per-object HKDF-SHA256 key (info `near-ai/state/v1/object`); `NAS1` objects with Padme buckets (8 per octave, 64 KiB floor, 8 MiB parts); `manifest.json` the only plaintext file.
- **Why:** the owner asked about harvest-now-decrypt-later. The format uses only symmetric primitives, which Shor's algorithm does not break; Grover at best halves symmetric strength, so AES-256 keeps about 128-bit and a 256-bit code keeps about 128-bit quantum strength before counting scrypt's per-guess memory cost. Ciphertext stays in public git history, hence the larger code.
- **Recorded in:** `27-CONTEXT.md` as **D-18** (including the constraint that any later public-key step must use a hybrid X25519 plus ML-KEM exchange), and in `27-01-PLAN.md` (truths, contract item 2, behavior, threat T-27-01), committed together in one docs commit before Task 2 started.

## Accomplishments

- Recovery code module: generate, format and tolerant parse, with the zero-pad-bit rule and known vectors (all zero bytes, all one bits).
- Key module: scrypt key-encryption key (callback form, `maxmem` 256 MiB), kdf bounds checked before any scrypt call, HKDF subkeys, AEAD seal and open with a canonical-base64 and exact IV and tag length check, data-key wrap and unwrap.
- Object and manifest module: Padme-padded, brotli-compressed, AEAD-sealed objects split at 8 MiB, a strictly parsed plaintext manifest half, and a sealed half that carries `seq`, the object list and the index file.
- 27 tests on plain `node --test`: 19 in stateRecovery and 8 in stateObjects, all passing, covering every refusal named in SYNC-04 and D-09.

## Task Commits

1. **Task 1: Confirm the wire contract (resolved by the owner: adjust)** - `01e345a` (docs): plan text and D-18
2. **Task 2: Tracer, code to manifest and back** - `6f228e2` (feat)
3. **Task 3 RED: every refusal, padding, parts, AAD, rollback tests** - `8c66e3a` (test): 6 of 26 failed on the tracer implementation
4. **Task 3 GREEN: refusals implemented** - `d62e034` (feat)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

**RED evidence (Task 3):** against the Task 2 implementation, these failed on the planned assertion: object cut short (got `tampered`, wanted `truncated`), length prefix larger than the data (no `truncated`), object absent (no `missing-object`), manifest older than last seen (no `rolled-back`), hostile kdf (`deriveKek` threw synchronously instead of rejecting), manifest entry checks (no refusal). Semantic assessment: each target test ran and failed on its own assertion for the intended reason, not on a load or fixture fault. The remaining 20 passed because the tracer already authenticated, bound the AAD and bucketed sizes.

## Files Created/Modified

- `src/domain/state/recoveryCode.ts` - 256-bit Crockford recovery code
- `src/domain/state/keys.ts` - KDF, subkeys, AEAD envelope, data-key wrap, StateRefusedError
- `src/domain/state/objects.ts` - padded sealed objects, manifest header and sealed half
- `src/test/stateRecovery.test.ts` - code, tracer, and every refusal (19 tests)
- `src/test/stateObjects.test.ts` - padding buckets, parts, subkeys, AAD swap, decompression limit (8 tests)
- `27-01-PLAN.md`, `27-CONTEXT.md` - 256-bit values and D-18

## Decisions Made

See `key-decisions`. In short: the owner's one change (256-bit code) is recorded as D-18; the kdf bound also caps memory; a wrong code and a damaged wrap are one refusal.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] deriveKek threw synchronously for a hostile kdf record**
- **Found during:** Task 3 (RED run)
- **Issue:** `deriveKek` returns a Promise but validated the kdf before creating it, so a refusal escaped as a synchronous throw instead of a rejection and a caller using `await ... .catch` or `assert.rejects` would miss it.
- **Fix:** validation moved inside the Promise executor; every refusal is a rejection.
- **Files modified:** `src/domain/state/keys.ts`
- **Commit:** `d62e034`

**2. [Rule 2 - Missing critical] kdf memory bound**
- **Found during:** Task 2
- **Issue:** the plan bounds N, r and p separately, but N up to 2^20 with r up to 32 can ask for 4 GiB (threat T-27-05).
- **Fix:** `assertKdfParams` also requires `128 * N * r <= SCRYPT_MAXMEM`. Today that allows N=2^17 at r up to 16; raising the cost later means raising `SCRYPT_MAXMEM` in code.
- **Files modified:** `src/domain/state/keys.ts`
- **Commit:** `6f228e2`

**3. [Rule 2 - Missing critical] Decompression-bomb test and exact tag length**
- **Found during:** Task 3
- **Issue:** Node's GCM accepts short tags unless told otherwise (a tag-truncation weakness), and the 256 MiB limit had no test.
- **Fix:** every cipher is created with `authTagLength: 16` and IV and tag lengths are checked; a forged authentic object that inflates one byte past 256 MiB is refused as `tampered` (the test allocates about 256 MiB transiently).
- **Files modified:** `src/domain/state/keys.ts`, `src/domain/state/objects.ts`, `src/test/stateObjects.test.ts`
- **Commit:** `6f228e2`, `d62e034`

### Notes on the plan text (not code deviations)

- **AAD.** Contract item 4 says AAD `near-ai/state/v1|<stateId>|<class>`; Task 2's action and threat T-27-03 add the part index and count. The code uses `near-ai/state/v1|<stateId>|<class>|<part>|<of>`, which keeps the approved prefix and adds the binding the threat register asks for.
- **Manifest size versus entry count.** The 1 MiB manifest cap and the 10 000-entry cap are both enforced, but with full-size entries (about 150 bytes plain, about 200 base64-sealed) the 1 MiB cap binds first, at roughly 5 000 entries. Compaction (plan 12) keeps objects few, so this is not a problem, but 27-12 should not assume 10 000 usable entries.
- **Plan wording.** My first pass at the plan edit said a non-zero-pad code is one whose first character is "above F"; it is one whose first character is not `0` or `1`. Corrected in `27-01-PLAN.md`.
- **Additive exports** beyond the plan's list: `newStateId`, `assertKdfParams`, `KdfParams`, `sealRaw`, `openRaw`, `ObjectEntry`, `SealedPart`, `OpenPart`, `MAX_MANIFEST_BYTES`, `OBJECT_HEADER_BYTES`, `MANIFEST_NAME`, `MAX_OBJECT_ENTRIES`, `MAX_DECOMPRESSED_BYTES`.

**Total deviations:** 3 auto-fixed (1 bug, 2 missing-critical). **Impact:** none on scope; the contract is stricter than the plan text in three places.

## Authentication Gates

None.

## Known Stubs

None. No placeholder values, empty data sources or TODOs in the created files.

## Threat Flags

None. The three modules are pure (no network, file, git or vscode access) and add no surface beyond the plan's threat model.

## Issues Encountered

None. `systemd-run` capped every compile and test run; the largest transient was the 256 MiB decompression-limit test.

## Next Phase Readiness

Ready for 27-03 (state home, key storage) and everything that seals, pushes or restores a bundle. Callers must: parse the code with `parseRecoveryCode` and refuse `undefined` with `new StateRefusedError('wrong-code-or-damaged')`; pass `Buffer.from(header.kdf.salt, 'base64')` and `header.kdf` to `deriveKek`; persist the highest `seq` they have seen and pass it as `lastSeenSeq`.

## Self-Check: PASSED

- Files present: `src/domain/state/recoveryCode.ts`, `keys.ts`, `objects.ts`, `src/test/stateRecovery.test.ts`, `src/test/stateObjects.test.ts`, this SUMMARY.
- Commits present on the branch: `01e345a`, `6f228e2`, `8c66e3a`, `d62e034`.
- Acceptance criteria: stateRecovery 19 passing (needs 10), stateObjects 8 passing (needs 6); `maxmem` 1 in keys.ts; `scryptSync` 0; `vscode`, `node:fs` and `node:child_process` imports 0 in all three modules; `timingSafeEqual` 2 and `maxOutputLength` 1 in objects.ts.
- Plan verification: both test files pass under the memory cap; `npm run lint` (`tsc --noEmit`) clean.
