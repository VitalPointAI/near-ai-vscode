---
phase: 71-identities-and-verified-credentials-core
plan: 14
subsystem: docs-and-verification
status: awaiting-checkpoint
tags: [security-md, readme, gate-docs, verification, d-08, d-21, o11]
requires:
  - "71-01 to 71-13: everything the docs state"
provides:
  - "SECURITY.md: '## Verified credentials and access decided by the data', after 'Your organization's sync hub', and a Known limitations row for a computer that holds keys offline"
  - "README.md: the Clearances bullet in Good to know"
  - "src/domain/credentials/statements.ts: the sentences the docs carry word for word; DECLARED_COUNTS_ONLY_LOWEST_TEXT in clearance.ts"
  - ".planning/phases/71-identities-and-verified-credentials-core/71-VERIFICATION.md"
affects: [48.1, 47, 33.1]
tech-stack:
  added: []
  patterns:
    - "Every sentence about credentials in SECURITY.md and README is a *_TEXT constant beside the code that makes it true, checked word for word by gateDocs.test.ts"
key-files:
  created:
    - src/domain/credentials/statements.ts
    - .planning/phases/71-identities-and-verified-credentials-core/71-VERIFICATION.md
  modified:
    - SECURITY.md
    - README.md
    - src/domain/credentials/clearance.ts
    - src/test/gateDocs.test.ts
    - .dockerignore
    - compliance/gaps.json
    - docs-site/content/security/road-to-production.md
decisions:
  - "The older self-declared clearance sentences ('Until verified credentials arrive', in the J2 and J4 staff templates too) are kept; the new section states the rule under credential rules, and their rewording waits for the extension's wallet and a new template version (G468)"
  - "G426's third limit (the hub checks evidence only in the part it can read) is stated in SECURITY.md"
metrics:
  completed: 2026-11-25
estimate:
  tokens: 75039
  tasks: 3
actuals:
  tokens: 9000
  tasks: 2
  commits: 2
plan_head_before: cd466d0a
plan_head_after: 8603520b
---

# Phase 71 Plan 14: The honest docs, the full suites once, and the verification record Summary

Tasks 1 and 2 are done. Task 3, the owner's approval of the integration PR, is a checkpoint for a person; no PR is opened from this branch.

- **SECURITY.md** has one new section, "Verified credentials and access decided by the data", after "Your organization's sync hub". Every sentence in it is a constant of the code that makes it true, and `gateDocs.test.ts` checks them word for word. Known limitations gains one row: a computer that holds keys offline is trusted until its next contact.
- **README** keeps "declared, not verified" for a computer with no organization, and gives the O11 sentence for your organization.
- **The older self-declared clearance sentences are kept.** `CLEARANCE_SELF_ASSERTED_TEXT` and `LABELS_NOT_ACCREDITATION_TEXT` begin "Until verified credentials arrive". The new section states the rule under credential rules. See deviation 1.
- **71-VERIFICATION.md** maps every requirement of the phase to tests that ran in the full suites. It also records the research verdicts, the owner items still open and what later phases consume.

## The sentences, and the code each states

| Constant | Where | What makes it true |
|---|---|---|
| `CREDENTIALS_ONLY_SOURCE_TEXT` | statements.ts | `clearancesInForce`, `checkEvidence` |
| `SIGN_IN_ONLY_TEXT` | statements.ts | workbench `token-facts.ts` and its token-claims test |
| `NEVER_ISSUE_TEXT` | statements.ts | `issuerAuthority` (D-07) |
| `EVIDENCE_BY_HASH_TEXT` | statements.ts | `checkEvidence` (D-09) |
| `FRESHNESS_AT_ACTION_TEXT` | statements.ts | the hub's evidence check and the session's key release |
| `HUB_CHECKS_WHAT_IT_READS_TEXT` | statements.ts | the hub opens only the base part (G426's third limit) |
| `MAX_OFFLINE_AGE_TEXT` | statements.ts | `checkFreshness` at an edge (O6) |
| `OFFLINE_TRUST_TEXT` | statements.ts | the key ring keeps keys a computer already holds (research pitfall 2) |
| `NOT_ACCREDITATION_TEXT` | statements.ts | D-21 |
| `DECLARED_NOT_VERIFIED_TEXT` | gate/clearances.ts (71-08) | the solo case (D-08) |
| `DECLARED_COUNTS_ONLY_LOWEST_TEXT` | credentials/clearance.ts | O11: the gate gives no declared clearance under credential rules, and key release opens only unmarked and lowest-level parts without credentials |

## Verification

**Tests added: 4,** all in `src/test/gateDocs.test.ts`:
- the section is there once, in its place;
- the section's sentences match the code word for word, with no compliance claim;
- the README sentences;
- the Known limitations row.

**Tests changed:** none, after the revert of deviation 1. `gateDocs`' and `gateLabels`' literal checks are as on `main`.

**The full suites, once each** (capped, one at a time, under the heavy-command lock, 2026-11-25; details in `71-VERIFICATION.md`):
- **Root lint and `npm test`:** 6,994 tests: 6,974 passed, 3 failed, 17 skipped. The 3 failures were deviation 1. After the revert, the failed files ran again: 150 of 150.
- **Hub lint and tests:** 491 tests: 487 passed, 1 failed, 3 skipped (they need an older Node). The failure was the hub image's `.dockerignore`, which lacked `statements.ts`. After the fix, `dockerContext` ran again: 5 of 5.
- **Workbench lint and tests** (real-hub tests on): 259 of 260, 1 skipped (it needs the built browser bundle).
- **Compliance lint and tests:** 614 of 614.
- **`resource-check.mjs`:** passed.
- **`build-road-to-production.mjs --check`:** passed.
- **`deploy/test/openbao.test.mjs` and `render-stateful.test.mjs`:** 31 of 42. All 11 failures are "helm was not found", an infrastructure limit of this machine. No deploy file changed in 71-13 or 71-14.

**Acceptance:** `grep -c "^## Verified credentials and access decided by the data" SECURITY.md` is 1. `71-VERIFICATION.md` names all 14 requirement ids. The plan's own check of that file passes.

## Deviations from Plan

**1. [Rule 1, found by the full root run] The older clearance sentences are kept.**
- **What I tried:** changing `CLEARANCE_SELF_ASSERTED_TEXT` and `LABELS_NOT_ACCREDITATION_TEXT` to begin "Without your organization's credential rules".
- **What broke:** the J2 and J4 staff templates embed both sentences. So three tests failed in the full root run:
  - "a staff template cannot change without a new template version" (J2);
  - the same test for J5;
  - the TeamUpdater preview, which saw the template change.
- **Why not record new versions:** that would ship an update to every staff team's template, a product change beyond this plan.
- **What I did:** reverted the change, with the test literals the change had touched. The new section states the rule under credential rules. Rewording the older sentences waits for the extension's wallet and a new template version, and is recorded in G468.
- **The failed files ran again after the revert;** see Verification.

**2. One more sentence than the plan names.** `HUB_CHECKS_WHAT_IT_READS_TEXT` states G426's third limit, which G426 said 71-14 would record in SECURITY.md. G426's remediation now points at it.

**3. Every point names the tests that show it,** as the sync hub section does. Each test reference is its own sentence after the code's sentence, so the code's sentence stays word for word, period included.

**4. Gap ids:** no new id. G468's remediation gains the sentence rewording (deviation 1).

**5. Tests first:** the four new `gateDocs` tests were written with the section, not run red on the base. They import `statements.ts`, which did not exist there, so they could not have compiled on the base.

## Open conditions

- **G350:** Ed25519 runs in no validated module; strict-FIPS sites use the P-256 fallback.
- **G425:** the credential context URL is not registered with w3id.org yet.
- **G426:** the hub takes first copies on trust; its third limit is now stated in SECURITY.md.
- **G427:** a hosted session makes no identity until the site sets STERLING_DID_DOMAIN.
- **G465:** the site's settings for the session and the issuer, then an end-to-end test.
- **G467:** the limit on computer place claims is not checked on a running OpenBao.
- **G468:** the VS Code extension does not build its wallet yet.
- **G469:** the browser's sync status does not name a held-back part yet.

## Not done here

- **Task 3 (checkpoint, a person):** the owner approves the agent-review gate run of the Phase 71 integration PR. Per the coordinator's instruction, this branch opens no PR, so the gate run does not exist yet.
- **DCAC-04 stays partial (plan work, no gap):** 71-09 Task 3 waits for 33-26.

## Self-Check: PASSED

- **Files:** `src/domain/credentials/statements.ts` and `71-VERIFICATION.md` exist.
- **Commits:** 98134b1a (Task 1) and 8603520b (the revert and the hub's `.dockerignore`) are on `feat/phase-71-13-14`.
- **Task 3:** a checkpoint for the owner, not done here.
