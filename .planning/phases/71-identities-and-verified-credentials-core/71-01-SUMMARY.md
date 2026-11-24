---
phase: 71-identities-and-verified-credentials-core
plan: 01
subsystem: credentials
status: complete
tags: [verified-credentials, data-integrity, eddsa-jcs-2022, jcs, rfc8785, multibase, multikey, conformance]
requires: []
provides:
  - "src/domain/credentials/multibase.ts: base58btc, the z prefix, Multikey 0xed01 / 0x1200 public keys (no import)"
  - "src/domain/credentials/dataIntegrity.ts: CredentialSigner, createProof, verifyProof, proofConfigHash, documentHash, dataIntegritySigningInput, DATA_INTEGRITY_FAILURES"
  - "test/fixtures/credentials/w3c-eddsa-jcs-2022: the W3C Appendix B.3 vectors with the W3C licence"
  - "Three exact-pinned test-only devDependencies with pass-with-conditions compliance entries"
affects: [71-03, 71-04, 71-05, 71-06, 71-07, 71-10, 71-12]
tech-stack:
  added:
    - "@digitalbazaar/vc 7.3.0 (devDependency, test oracle only)"
    - "@digitalbazaar/eddsa-jcs-2022-cryptosuite 1.0.0 (devDependency, test oracle only)"
    - "@digitalbazaar/vc-bitstring-status-list 2.0.1 (devDependency, for 71-05's cross-check)"
  patterns:
    - "One canonicalizer: Data Integrity bytes come only from canonicalBytes in src/domain/team/canonical.ts"
    - "Reference packages load through a variable-specifier dynamic import inside src/test only, with a static document loader that refuses every other address"
key-files:
  created:
    - src/domain/credentials/multibase.ts
    - src/domain/credentials/dataIntegrity.ts
    - src/test/credentialsConformance.test.ts
    - test/fixtures/credentials/w3c-eddsa-jcs-2022/vectors.json
    - test/fixtures/credentials/w3c-eddsa-jcs-2022/LICENSE.md
    - .planning/phases/71-identities-and-verified-credentials-core/71-01-PACKAGE-CHECK.md
  modified:
    - package.json
    - package-lock.json
    - compliance/resources.json
decisions:
  - "Owner 2026-11-24 (\"approved\"): the three Digital Bazaar packages are exact-pinned devDependencies for cross-check tests only, never shipped (D-23)"
  - "The profile is stricter than the specification on two points: exactly one proof per credential, and the proof's @context must equal the credential's (a prefix would leave the extra contexts unsigned)"
  - "The compliance entries are pass-with-conditions: no build provenance, the cryptosuite's two-year-old only release, a static document loader in tests"
metrics:
  duration: "46 min (2026-11-24, including the owner's checkpoint wait)"
  completed: 2026-11-24
estimate:
  tokens: 85044
  tasks: 3
actuals:
  tokens: 16452
  tasks: 3
  commits: 4
plan_head_before: b1ce8ada
plan_head_after: 36ac569d
---

# Phase 71 Plan 01: JCS conformance and the eddsa-jcs-2022 tracer Summary

Our own eddsa-jcs-2022 on node:crypto and the existing canonical JSON reproduce the W3C example proof byte for byte, and credentials verify both ways with Digital Bazaar's reference cryptosuite through `@digitalbazaar/vc`; 2,000 seeded profile values give the same bytes as the reference RFC 8785 implementation.

JCS verdict: PASS

## What was built

- **Task 1 (package check, owner gate):** `71-01-PACKAGE-CHECK.md`. Registry metadata only, nothing installed or run. All 25 packages of the tree have valid npm registry signatures and matching checksums, there are no install scripts and no advisories, and all are under permissive licences. The owner approved on 2026-11-24.
- **Task 2:** `npm install --save-dev --save-exact --ignore-scripts` for exactly the three approved versions. The lockfile adds only their own tree, with the same versions and integrity as the checked tree (`undici` dedupes to the existing 7.30.1). Three `compliance/resources.json` entries: `scope test`, `build-and-test`, `pass-with-conditions`. `resource-check.mjs` passes, and no file outside `src/test` imports them.
- **Task 3 (tracer):**
  - `multibase.ts` (no import) and `dataIntegrity.ts`.
  - The W3C vectors, stored unchanged.
  - `credentialsConformance.test.ts` with 15 tests:
    - the W3C hashes and proofValue byte for byte;
    - tamper refusals in the document, the proof options and the proofValue;
    - named refusal reasons;
    - number refusals before anything is signed;
    - domain separation from signed-payload and team-event inputs;
    - base58btc and Multikey round trips;
    - the Digital Bazaar cross-check both ways, with negative controls;
    - the reference reproducing the W3C proofValue;
    - the 2,000-value RFC 8785 generator;
    - the UTF-16 key order.

## Inputs the profile must refuse

Floats, -0, NaN, Infinity and integers beyond 2^53-1 are refused before signing with reason `not-canonical`. So are lone surrogates, undefined, sparse arrays, non-plain objects, and nesting deeper than 16. These all come from `canonical.ts`. Everything else the profile allows (text, true and false, null, safe integers, lists, objects) is byte-equal to RFC 8785.

## Verification

- Failing first: before the new modules existed, `npm run compile` failed on the missing `../domain/credentials/*` modules.
- `credentialsConformance`, `teamSignedPayload`, `architecture` and `copyLint`: 83 of 83 pass.
- `resource-check.mjs` passes. `scripts/test/resource-check.test.mjs` passes 14 of 14. `secret-scan.mjs` over the branch is clean.
- Acceptance greps:
  - `^import` in `multibase.ts`: 0;
  - `canonicalBytes` in `dataIntegrity.ts`: 3;
  - `npm:@digitalbazaar/` entries: 3;
  - imports outside `src/test`: 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `@digitalbazaar/vc` needs a suite object, and the usual one (`@digitalbazaar/data-integrity`) is not an approved package**
- **Found during:** Task 3.
- **Fix:** I did not install a fourth package. Instead, a small test-only suite adapter is written in the test file. Every byte that matters in it comes from the reference packages: the JCS form and both hashes from `eddsa-jcs-2022-cryptosuite`, the @context rule, Ed25519 from `ed25519-multikey`, and base58btc from `base58-universal`. `@digitalbazaar/vc` runs its own credential checks and its issuance purpose. A self-check (the reference re-verifies what it issued) shows the glue is sound.
- **Files:** `src/test/credentialsConformance.test.ts`. **Commit:** 13948057.

**2. [Rule 1 - Copy lint] Two refusal messages used the glossary word "profile"**
- **Fix:** I reworded the messages and kept the baseline unchanged. **Commit:** f46df77d.

## Known Stubs

None.

## Threat Flags

None. The threat register's mitigations are in place:
- T-71-01: vectors, the two-way check, one canonicalizer and refusal before signing.
- T-71-02: the domain-separation test.
- T-71-03: devDependencies only, plus the import grep.
- T-71-SC: the owner-checked packages, exact pins, `--ignore-scripts` and the compliance entries.

## Self-Check: PASSED

All created files exist. Commits f46df77d, d4842b11, 768c7149 and 13948057 are on `feat/phase-71-wave-1`.
