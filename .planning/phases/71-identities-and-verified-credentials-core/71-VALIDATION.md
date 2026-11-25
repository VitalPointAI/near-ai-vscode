---
phase: "71"
slug: "identities-and-verified-credentials-core"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-24"
---

# Phase 71: Validation Strategy

> Per-phase validation contract for 14 plans in 9 waves. Every test uses fictional people, organizations, DIDs and keys (Example Organization, `did:webvh:...:example.org:people:alex`) in temporary stores.

`nyquist_compliant` stays false: every task has an automated check written first, but 71-02 is a research plan checked by its verdict lines, 71-14's full suites take longer than the per-task target, and each test file is created by its own task (tests first) rather than in a separate wave 0.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` through `scripts/run-tests.mjs` (root, Node 24); the hub's own run in `hub/` (Node 26.13.1); `npm --prefix workbench test` (Node 26.13.1); `deploy/test/*.test.mjs` through `scripts/run-tests.mjs` |
| **Quick run (root)** | `flock "$HEAVY_LOCK" systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run compile && node scripts/run-tests.mjs dist/test/<file>.test.js'` |
| **Hub run** | `cd hub && flock "$HEAVY_LOCK" systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 600 env PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run build && node ../scripts/run-tests.mjs dist/test/<file>.test.js'` |
| **Workbench run** | `flock "$HEAVY_LOCK" systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 600 env PATH="$HOME/.nvm/versions/node/v26.13.1/bin:$PATH" NODE_OPTIONS=--max-old-space-size=1536 npm --prefix workbench test` |
| **Full suites** | 71-14 only, once each, one at a time: root lint and tests (6G, 1800 s), hub lint and tests, workbench tests, `resource-check.mjs`, the OpenBao and hub chart render tests |
| **Estimated runtime** | root file under 60 s; hub file under 120 s; workbench unit under 300 s |

Never bare `node --test` and never an uncapped `npm test`.

---

## Sampling Rate

- **After every task commit:** the task's own `<automated>` command.
- **After every wave:** every new test file of the wave, `architecture.test.js`, `copyLint.test.js`, and the hub or workbench files when the wave touched them.
- **Blocking in every wave that touches them (authorization, crypto, data integrity):** the cross-check with Digital Bazaar and the W3C and DIF vectors; issuer authority and "agents and devices never issue"; `checkEvidence` determinism; `mayRelease` dominance; freshness refusals; the hub's compare-and-swap; key release.
- **Before `/gsd-verify-work`:** 71-14's full suites green once.
- **Browser checks:** none blocking. The Issue credential card's step-up is covered by workbench unit tests with fakes; a two-browser run of issuance is diagnostic, in the owner's check of the built image.

---

## Per-Requirement Verification Map

| Req | Behaviour | Plan | Test type | Automated command (file) | File exists |
|-----|-----------|------|-----------|--------------------------|-------------|
| VCRD-03 | Our proofs and Digital Bazaar's verify both ways; W3C vectors; JCS equals RFC 8785 for profile inputs | 01 | conformance, generator | `dist/test/credentialsConformance.test.js` | W0 |
| VCRD-02 | Narrow profile: fixed contexts, two suites, integers only, required dates and status | 01, 03 | unit | `dist/test/credentialsProfile.test.js` | W0 |
| VCRD-01 | Every credential type with exact claims, ClassificationAuthorityCredential included | 03 | unit | `dist/test/credentialsTypes.test.js` | W0 |
| VCRD-05 | Thresholds; present only what is asked | 03, 08 | unit | `dist/test/credentialsTypes.test.js`, `dist/test/gateWallet.test.js` | W0 |
| DLGT-01 | `did:key` from Phase 69 keys; `did:webvh` from a cached copy; minimal DID documents; people's DIDs at first sign-in; root DID offline | 04, 10 | unit, DIF vectors, workbench | `dist/test/didKey.test.js`, `dist/test/didWebvh.test.js`, `workbench/test/credentials-identity-service.test.ts`, `scripts/test/orgIssuer.test.mjs` | W0 |
| VCRD-04 | Status lists: build, sign, read, never un-revoke, newer lists, fail closed; exported to edges | 05, 11, 12 | unit, cross-check, hub | `dist/test/credentialsStatusList.test.js`, `dist/test/credentialsTrustExport.test.js`, `workbench/test/credentials-issuer-service.test.ts` | W0 |
| VCRD-06 | Device binding; a lost computer cut off by one revocation | 10 | unit | `dist/test/gateDeviceIdentity.test.js` | W0 |
| DCAC-01 | `credentials@1` and `agreements@1`; issuer authority; agents and devices never issue (property test); requirements only tighten | 06 | unit, property | `dist/test/policyCredentialsSection.test.js`, `dist/test/credentialsIssuerAuthority.test.js`, `dist/test/gateOrganizationStore.test.js` | W0 |
| DCAC-02 | Evidence cited by hash; same answer on every replica | 07 | unit, property | `dist/test/credentialsEvidence.test.js` | W0 |
| DCAC-03 | `mayRelease` for every holder; `eligibleForPosition` | 07 | unit, property | `dist/test/credentialsMayRelease.test.js` | W0 |
| DCAC-04 | Freshness at the hub, the preparer and the session; offline age; rekey card; session state; key release | 07, 09, 13 | unit, hub, workbench | `dist/test/credentialsFreshness.test.js`, `hub: dist/test/evidencePep.test.js`, `dist/test/staffRevocationWatch.test.js`, `workbench/test/credentials-credential-cache.test.ts`, `dist/test/staffKeyRelease.test.js`, `dist/test/gateHubTrustSource.test.js` | W0 |
| VCRD-07 | Gate clearance only from verified credentials in your organization; solo declared clearances unchanged | 07, 08 | unit | `dist/test/gateCredentialClearance.test.js`, `dist/test/gateLabelReads.test.js` | W0 |
| DCAC-05 | Issuance from the officer's session with step-up; status-list key and issuer role in OpenBao; revoke and suspend | 10, 12 | workbench, deploy | `workbench/test/credentials-issuer-service.test.ts`, `deploy/test/openbao.test.mjs` | W0 |
| DCAC-06 | Hub serves logs and lists; trust export and import | 09, 11 | hub | `hub: dist/test/trustRoutes.test.js`, `hub: dist/test/trustTransfer.test.js` | W0 |
| (D-18) | Tokens only authenticate | 13 | workbench, static | `workbench/test/credentials-token-claims.test.ts` | W0 |
| (D-21) | Docs say what the code does | 14 | word for word | `dist/test/gateDocs.test.js` | yes |

---

## Wave 0 Requirements

Each test file is created by the task that needs it, tests first, and run on the unchanged base where it fails. No separate scaffolding wave.

Workbench test files are flat (`workbench/test/credentials-*.test.ts`), because the workbench runner runs only `dist/test/*.test.js` and `dist/test/staff/*.test.js` (H-71-01).

---

## Manual-Only Verifications

| Behaviour | Requirement | Why manual | Instructions |
|-----------|-------------|------------|--------------|
| The three test-only packages are the real ones | D-20 | Package legitimacy is a person's check | 71-01 Task 1 |
| Integration PR | all | Owner's gate approval | 71-14 Task 3 |

---

## Validation Sign-Off

- [x] Every task has an `<automated>` verify or is a checkpoint
- [x] Sampling continuity: no three tasks in a row without an automated check
- [x] No watch-mode flags
- [ ] `nyquist_compliant: true` (stays false, reasons above)

**Approval:** pending
