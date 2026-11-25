---
phase: "71"
slug: "identities-and-verified-credentials-core"
status: awaiting-owner-gate
verified: 2026-11-25
branch: feat/phase-71-13-14
---

# Phase 71: Verification record (identities and verified credentials, core)

This is the one record of what Phase 71 proved. Each requirement lists the tests that show it, and every one of those tests ran in the full suites below. Suite totals are results, not a measure of work.

## Suites, run once each (2026-11-25)

Each suite ran capped (systemd-run memory limit, `choom`, a timeout), one at a time, under the shared heavy-command lock. The base was `feat/phase-71-13-14` at 98134b1a (`main` 99373e04 plus 71-13 and 71-14 Task 1).

| Suite | Command | Result |
|---|---|---|
| Root lint and tests | `npm run lint && npm test` (Node 24, 6G, 1,800 s) | Lint passed. 6,994 tests: 6,974 passed, 3 failed, 17 skipped. All three failures came from one change of this plan: rewording the self-declared clearance sentences changed the J2 and J4 staff templates (two template-version tests and the TeamUpdater preview). The change was reverted (8603520b). The failed files then ran again (`gateDocs`, `gateLabels`, `staffJ2Team`, `staffJ5`, `staffSetup`, `copyLint`): 150 of 150. |
| Hub lint and tests | `cd hub && npm ci && npm run lint && npm test` (Node 26.13.1) | Lint passed. 491 tests: 487 passed, 1 failed, 3 skipped (they need an older Node binary). The failure: the hub image's `.dockerignore` lacked the new `statements.ts`. It was added (8603520b), and `dockerContext` ran again: 5 of 5. |
| Workbench lint and tests | `npm --prefix workbench run lint && npm --prefix workbench test` (Node 26.13.1, `NEAR_AI_HUB_NODE` set so the real-hub tests run) | Lint passed. 260 tests: 259 passed, 0 failed, 1 skipped (it scans the built browser bundle, which the test run does not build). |
| Compliance lint and tests | `cd compliance && npm run lint && npm test` (Node 26.13.1) | Lint passed. 614 of 614. |
| Resource check | `node scripts/resource-check.mjs` | Passed: 141 resources, each with a reviewed entry. |
| OpenBao and hub chart renders | `node scripts/run-tests.mjs deploy/test/openbao.test.mjs deploy/test/render-stateful.test.mjs` | 42 tests: 31 passed, 11 failed. Every failure is "helm was not found": no `helm` binary is on this machine, so no chart rendered. This is infrastructure only, and no file under `deploy/` changed in 71-13 or 71-14. The tests that need no render passed, the OpenBao policy tests of 71-12 and D-25 among them. The renders still need a run with `helm` (CI's deploy job, or a machine with `HELM` set). |
| Road to production | `node scripts/build-road-to-production.mjs --check` | Passed: the page matches the register, and every SUMMARY cites its open conditions. |

The three requirement areas that the full suites alone do not cover:
- the chart renders above, which need `helm`;
- the browser bundle scan, which needs a workbench build;
- the hub's tests on an older Node.

Each is an environment limit of this run, not a failing test.

## Requirements and the tests that prove them

Each file below ran in the suites above. "Partly" means a part of the requirement waits for a plan or a site value named beside it.

| Requirement | What is proven | Tests | Result |
|---|---|---|---|
| DLGT-01 | `did:key` for devices and agents from the Phase 69 key, unchanged; `did:webvh` for people (made by their own backend at first sign-in, signed with their person key after the step-up) and for your organization's root (offline ceremony, pre-rotation); minimal DID documents; a person's log posted through their own hub session (71-13) | `src/test/didKey.test.ts`, `src/test/didWebvh.test.ts`, `workbench/test/credentials-identity-service.test.ts`, `scripts/test/orgIssuer.test.mjs`, `src/test/gateHubTrustSource.test.ts` (the post through the pinned connection) | Passed. In a hosted session no identity is made until the site sets `STERLING_DID_DOMAIN` (G427). |
| VCRD-01 | Every credential type of the profile with exact claims, ClassificationAuthorityCredential included; never inside a DID document | `src/test/credentialsTypes.test.ts` | Passed |
| VCRD-02 | One narrow profile: fixed contexts, two named suites, integers only, required dates and status; no JSON-LD | `src/test/credentialsProfile.test.ts`, `src/test/credentialsConformance.test.ts` | Passed. The context address is still to be registered with w3id.org (G425). |
| VCRD-03 | Our proofs and Digital Bazaar's verify both ways; the W3C vectors; JCS equals RFC 8785 for every input the profile allows | `src/test/credentialsConformance.test.ts` | Passed |
| VCRD-04 | Bitstring status lists: build, sign, read, a revocation never clears, newer lists only, fail closed; signed by the site's status-list key through an officer's step-up; carried to edges | `src/test/credentialsStatusList.test.ts`, `src/test/credentialsTrustExport.test.ts`, `workbench/test/credentials-issuer-service.test.ts`, `deploy/test/openbao.test.mjs`, `hub/test/trustRoutes.test.ts` | Passed. The exception is `openbao.test.mjs`'s chart renders, which need `helm` (see the suites); its policy tests passed. |
| VCRD-05 | Threshold credentials; only what a check asks is presented | `src/test/credentialsTypes.test.ts`, `src/test/gateWallet.test.ts` | Passed |
| VCRD-06 | A computer bound to its person by a DeviceBindingCredential in one of five slots of their own DID document; a lost computer cut off by one revocation | `src/test/gateDeviceIdentity.test.ts`, `workbench/test/credentials-device-slots.test.ts`, `src/test/credentialsEvidence.test.ts` | Passed. Binding in a hosted session waits for `STERLING_DID_DOMAIN` (G427); the claim limit is not yet checked on a running OpenBao (G467). |
| VCRD-07 | The gate's clearances come only from verified credentials under your organization's credential rules; a computer with no organization keeps its declared clearances, shown as declared, not verified | `src/test/gateCredentialClearance.test.ts`, `src/test/gateLabelReads.test.ts`, `src/test/gateDocs.test.ts` | Passed. The VS Code extension does not build its wallet yet, so under credential rules its gate gives no clearance (fails closed, G468). |
| DCAC-01 | `credentials@1` and `agreements@1` in the signed policy; issuer authority; agents and devices never issue (property test); requirements only tighten | `src/test/policyCredentialsSection.test.ts`, `src/test/credentialsIssuerAuthority.test.ts`, `src/test/gateOrganizationStore.test.ts` | Passed |
| DCAC-02 | Evidence cited by hash; 1,000 replicas holding different lists give the same answer | `src/test/credentialsEvidence.test.ts` | Passed |
| DCAC-03 | One `mayRelease` for every holder, staff and observers alike (2,000 random cases); `eligibleForPosition` | `src/test/credentialsMayRelease.test.ts` | Passed |
| DCAC-04 | Freshness at the moment of action: the hub on append, the session's state with Retry (71-13), key release at settle, at every read and on the reading path (71-13), an edge's maximum offline age | `src/test/credentialsFreshness.test.ts`, `hub/test/evidencePep.test.ts`, `src/test/staffKeyRelease.test.ts`, `workbench/test/credentials-credential-cache.test.ts`, `workbench/test/credentials-token-claims.test.ts`, `src/test/gateHubTrustSource.test.ts`, `workbench/test/staff/staff-live-engine.test.ts` | Partly. Left: the hub's revocation event to the lead and the rekey card (71-09 Task 3, which waits for 33-26's `staffRoomLive.ts`), and the wrap preparer's check (Phase 33.2, D-02). The browser does not yet name a held-back part in the sync status (G469). |
| DCAC-05 | Issuance, revocation and suspension only from an officer's own session, signed by their person key after a step-up; the status-list key and the issuer step-up role in OpenBao | `workbench/test/credentials-issuer-service.test.ts`, `workbench/test/credentials-issue-credential-card.test.ts`, `src/test/credentialsIssueForm.test.ts`, `deploy/test/openbao.test.mjs` | Passed, apart from the chart renders that need `helm`. Not reachable on a site until Phase 47 renders the settings (G465). |
| DCAC-06 | The hub serves logs and lists to staff members only; the trust export and its import at an edge | `hub/test/trustRoutes.test.ts`, `hub/test/trustTransfer.test.ts`, `src/test/credentialsTrustExport.test.ts` | Passed. First copies are taken on trust (G426). |

## Research verdicts (71-01, 71-02)

- **JCS:** PASS. `src/domain/team/canonical.ts` equals RFC 8785 for every input the profile allows (71-01).
- **did:webvh:** FULL. Hosting and caching at the hub, with the witness file where one is used (71-02).
- **Status lists:** FULL. 131,072 entries, random indexes, compare-and-swap at the hub (71-02).
- **FIPS posture (O8):** Ed25519 runs in no validated module anywhere in the stack. A site that requires validated modules uses the `ecdsa-jcs-2019` P-256 fallback (G350).

## Owner items

- **Answered:** items 1 and 2 (2026-11-24, "defaults"); D-23, the three test-only packages; D-25, a person claims their own computer slots (2026-11-25).
- **Still open, with the default the code uses:**
  - item 3: the context URL `https://w3id.org/sterling/credentials/v1`, to be registered before the first real credential (G425);
  - item 4: your organization's root DID key separate from the Phase 41 policy key;
  - item 5: a revoked credential triggers a rekey with the existing reason `clearance-lowered`.

## What later phases now consume

- **33.1 (assigned positions and handover):**
  - `checkEvidence` and the evidence slots `evidence` and `status` for the entry shapes;
  - `eligibleForPosition` for postings;
  - `mayRelease` for observers.
- **47 (site values and runbooks):**
  - render `STERLING_ORGANIZATION_POLICY`, `STERLING_ORGANIZATION_POLICY_KEY`, `STERLING_STATUS_LIST_KEY`, `STERLING_OPENBAO_ISSUER_ROLE` and `STERLING_DID_DOMAIN`;
  - name the officers in `credentialIssuers` at the key ceremony;
  - 47-19 calls `deploy/tools/credential-check.mjs`;
  - 47-20 and 47-31 file `sterling-revocation-request/1`.
- **48.1 (the hosted security plan):**
  - the key inventory: `status-list-<site>`, the issuer step-up role, the policy `credential-issuers`;
  - the statements in SECURITY.md "Verified credentials and access decided by the data".
- **33-28:** show `StaffStatusRow.access` (G469).
- **Later work on the VS Code extension:** build its wallet (G468).

## Open conditions

- **G350:** Ed25519 runs in no validated module; strict-FIPS sites use the P-256 fallback.
- **G425:** the credential context URL is not registered yet.
- **G426:** the hub takes first copies on trust; it checks evidence only in the part it can read (stated in SECURITY.md).
- **G427:** no identity is made in a hosted session until the site sets `STERLING_DID_DOMAIN`.
- **G465:** issuing and the session's check need the site's settings; then an end-to-end test against a real OpenBao and hub.
- **G467:** the limit on computer place claims is not yet checked on a running OpenBao.
- **G468:** the VS Code extension does not build its wallet yet.
- **G469:** the browser does not yet name a held-back part in the sync status.
- **No gap id, plan work:** DCAC-04's revocation event and rekey card (71-09 Task 3) wait for 33-26.
- **Owner's gate approval:** the integration PR (71-14 Task 3) has not been opened. This branch opens no PR.
