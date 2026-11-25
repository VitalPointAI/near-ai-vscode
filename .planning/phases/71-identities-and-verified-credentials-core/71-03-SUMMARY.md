---
phase: 71-identities-and-verified-credentials-core
plan: 03
subsystem: credentials
status: complete
tags: [verified-credentials, vc-2.0, eddsa-jcs-2022, ecdsa-jcs-2019, p-256, fips, credential-types, thresholds]
requires:
  - "71-01: multibase.ts, dataIntegrity.ts (CredentialSigner, createProof, verifyProof), JCS verdict PASS"
provides:
  - "src/domain/credentials/profile.ts: issueCredential, readCredential, verifyCredential, credentialHash, CREDENTIAL_PROFILE_REFUSALS, CREDENTIAL_SUITES"
  - "src/domain/credentials/types.ts: CREDENTIAL_TYPES, PERSON_ATTRIBUTE_TYPES, ROLE_TYPES, parseClaims, thresholdsFor, credentialTimeMs, isDid"
  - "src/domain/credentials/context.ts: VC_V2_CONTEXT, OUR_CONTEXT_URL, OUR_CONTEXT_DOCUMENT (frozen)"
  - "src/domain/credentials/ecdsaJcs2019.ts: createEcdsaProof, verifyEcdsaProof (P-256, IEEE P1363 only)"
  - "test/fixtures/credentials/w3c-ecdsa-jcs-2019: the W3C Appendix A.5 P-256 examples with the W3C licence"
affects: [71-05, 71-06, 71-07, 71-08, 71-10, 71-12]
tech-stack:
  added: []
  patterns:
    - "Read first, then verify: readCredential gives issuer and verification method without a key, so the caller resolves the key; verifyCredential never resolves a DID"
    - "Scales come from the caller (the policy's, or the gate's presets), never imported into src/domain/credentials (architecture rule scale-presets)"
key-files:
  created:
    - src/domain/credentials/profile.ts
    - src/domain/credentials/context.ts
    - src/domain/credentials/types.ts
    - src/domain/credentials/ecdsaJcs2019.ts
    - src/test/credentialsProfile.test.ts
    - src/test/credentialsTypes.test.ts
    - test/fixtures/credentials/w3c-ecdsa-jcs-2019/vectors.json
    - test/fixtures/credentials/w3c-ecdsa-jcs-2019/LICENSE.md
  modified:
    - src/domain/credentials/dataIntegrity.ts
decisions:
  - "A credential's proof must be made by a verification method of its own issuer (`<issuer>#...`), checked before any signature (issuer-mismatch)"
  - "DeviceBindingCredential claims are { device: the Phase 69 fingerprint dev-<32 hex>, class: managed | personal | edge } (identity research section 3)"
  - "BitstringStatusListCredential is read by the same format with our signed `version` claim beside the W3C fields, so two copies of one list are ordered without a clock (71-05, 71-09)"
  - "Credential times are UTC with a capital Z, seconds or exactly three fraction digits; validFrom must come before validUntil"
metrics:
  duration: "about 1 h 10 min (2026-11-24, shared with 71-04; most of it waiting for the shared heavy-command lock)"
  completed: 2026-11-24
estimate:
  tokens: 90047
  tasks: 3
actuals:
  tokens: 24900
  tasks: 3
  commits: 4
plan_head_before: c197af2f236805050d855a813a85d6a2237fcfca
plan_head_after: 5f9db12a
---

# Phase 71 Plan 03: The narrow VC 2.0 credential format, every credential type, and the ecdsa-jcs-2019 suite Summary

One format decides what a credential is: two fixed contexts, one type of seventeen with exact claims, required dates and status entries, one proof by the issuer's own verification method in eddsa-jcs-2022 or (O8) ecdsa-jcs-2019 on P-256, whose W3C P-256 example verifies with node:crypto.

## What was built

- **Task 1 (`profile.ts`, `context.ts`):**
  - `readCredential(value, scales, { signed })` checks the shape before any signature, in this order: members, contexts, type, canonical numbers, id, issuer, dates, status entries, claims, then the proof's suite and its verification method.
  - `verifyCredential(value, { publicKey, scales, at? })` adds the proof check with the caller's key. `at` checks only the date window, so the caller decides the time.
  - `issueCredential(signer, unsigned, suite, { scales, created? })` refuses before the signer is called.
  - `credentialHash` is SHA-256 of the JCS bytes of the whole credential, proof included.
  - `OUR_CONTEXT_URL` is `https://w3id.org/sterling/credentials/v1`, once. The frozen context document defines every type and claim name under a `#` vocabulary.
- **Task 2 (`types.ts`):** the type table as built (below), `parseClaims` with exact keys and own properties only, `thresholdsFor` (Secret on `ca-classified` gives Confidential and Secret), `ROLE_TYPES`, `PERSON_ATTRIBUTE_TYPES`. `DelegationCredential` is reserved for Phase 71.1 and refused.
- **Task 3 (`ecdsaJcs2019.ts`):** the second suite, which mirrors `dataIntegrity.ts` and shares its steps. Signatures are the 64-byte IEEE P1363 form only; DER is refused. The profile dispatches on `proof.cryptosuite` and refuses a key of the other kind (`suite-key-mismatch`). `ecdsa-jcs-2019` is a W3C Recommendation (15 May 2025, section 3.3); its Appendix A.5 examples are frozen as vectors.

### The type table as built

| Type | Claims (besides `id`) | Rules |
|---|---|---|
| MembershipCredential | organization | text, 1 to 256 |
| ClearanceCredential | scale, atLeast | scale in the caller's table; level on it |
| CompartmentCredential | compartment | label token, never `RELEASABLE-TO-NONE` |
| ServiceCredential | serves | regular-force, reserve-force, public-servant, contractor, allied-military, industry |
| NationalityCredential | nationality | label token (ISO alpha-3 or a group token), never `RELEASABLE-TO-NONE` |
| AffiliationCredential | organization | text |
| ExportEligibilityCredential | regime, basis | regime CGP, ITAR or EAR |
| AccessAgreementCredential | agreement, scope | scope `organization`, `project:<id>` or `section:<id>` |
| VisitClearanceCredential | request, site, from, until | from before until |
| ObserverAccessCredential | project, position, cells, until | cells sorted, distinct, not empty |
| IssuerRoleCredential | credentialType, scale?, upTo?, compartments?, regimes? | credentialType a person-attribute type; scale and upTo together |
| SecurityContactCredential | scope | as above |
| ReleaseAuthorityCredential | scope | as above |
| ClassificationAuthorityCredential | scale, upTo, scope | scope may also be `own-items` |
| RoleCredential | role, scope | role lowercase name |
| DeviceBindingCredential | device, class | subject a did:key; device `dev-<32 hex>`; class managed, personal or edge |
| BitstringStatusListCredential | type, statusPurpose, encodedList, version, ttl? | type `BitstringStatusList`; purpose revocation or suspension |

### Refusal ids

`CREDENTIAL_PROFILE_REFUSALS`: not-an-object, unknown-member, missing-member, wrong-context, wrong-type, bad-id, bad-issuer, bad-dates, bad-status, bad-claims, issuer-mismatch, suite-key-mismatch, not-yet-valid, expired, plus the nine proof reasons of 71-01 (not-canonical, already-signed, unsupported-suite, bad-proof, bad-created, context-mismatch, wrong-purpose, bad-key, bad-signature). Claims refusals reuse the gate's shape reasons (`unknown-field`, `missing-field`, `wrong-type`, `not-allowed-here`, `empty-list`, `not-sorted`, `duplicate`, `not-available-yet`).

## Verification

- Failing first: before the modules existed, `npm run compile` failed on the missing `../domain/credentials/*` imports of the new tests.
- `credentialsTypes` 30 tests (13 written plus one generated per type), `credentialsProfile` 19, `credentialsConformance` 15 (71-01, unchanged, still green after the shared-steps refactor), `architecture`, `copyLint`: all pass (capped runs, 2026-11-24).
- Acceptance greps: the context URL appears once in `context.ts`; `ClassificationAuthorityCredential` is in `types.ts`; `ieee-p1363` is in `ecdsaJcs2019.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The scale presets cannot be imported into `src/domain/credentials`**
- **Found during:** Task 2.
- **Issue:** the plan says to reuse `SCALE_PRESETS` from `labels.ts`, but the architecture rule `scale-presets` refuses that import outside `src/domain/gate` (scales come through the policy).
- **Fix:** `parseClaims`, `thresholdsFor`, `readCredential`, `verifyCredential` and `issueCredential` take the scale table from the caller. Tests pass `SCALE_PRESETS`. The plan's "ca-gc-classified" is the preset `ca-classified`; a policy may name its own scale ids.
- **Commit:** af75c0a3.

**2. [Rule 3 - Blocking] Shared proof steps moved into `dataIntegrity.ts`**
- **Issue:** the second suite needs the same proof configuration and proof reading. Copying them would duplicate the narrow rules (one proof, `@context` equality).
- **Fix:** `proofConfigFor`, `readSecuredProof`, `proofSignature` and `refuseProof` are exported, and `createProof` and `verifyProof` use them. `CredentialSuite` names both suites. Behaviour is unchanged: the 15 conformance tests pass.
- **Commit:** 8407fe2b.

**3. Task order:** Task 2 was committed before Task 1, because the format reads claims through `parseClaims`.

**4. [Rule 1 - Copy] Two refusal sentences used the glossary word "issuer"**
- **Fix:** reworded ("whoever issued it"). **Commit:** 9335e3d1.

## Open conditions

- G350: Ed25519 still runs in no validated module. This plan delivers the ready fallback suite. A strict-FIPS site also needs validated builds of Node and OpenBao, which do not exist yet.

- G425: the context address `https://w3id.org/sterling/credentials/v1` (owner item 3, D-05) is to be registered with w3id.org before the first real credential (appliesAt now, blocks production, closes in Phase 71). Verification never fetches it.

## Known Stubs

None.

## Threat Flags

None. T-71-06 to T-71-09 are mitigated as planned:
- T-71-06: fixed contexts, exact claims, one type, suite matched to the key, and the issuer's own method.
- T-71-07: any other context is refused before the proof.
- T-71-08: one threshold per credential.
- T-71-09: r then s only, DER refused, suite and key kind cross-checked.

## Self-Check: PASSED

All created files exist. Commits af75c0a3, 8407fe2b and 5f9db12a are on `feat/phase-71-wave-2`.
