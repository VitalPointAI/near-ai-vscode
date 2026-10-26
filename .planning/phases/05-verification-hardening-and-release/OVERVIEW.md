# Phase 5 Follow-up Overview: Credentials, Attribution, and Wallet Entitlements

This follow-up closes the release-blocking credential/profile, cost-attribution, and NEAR AI wallet-entitlement slices called out by ROADMAP and STATE.md, then closes the two verification blockers for persisted attribution integrity and release trust/packaging. A workspace project must explicitly select a named organization/company profile, validate its provider credential, and use only the scoped SecretStorage entry for that project/profile. Wallet staking is a separate non-custodial boundary: it uses a verified external wallet, verified network/validator configuration, exact transaction previews, explicit confirmation, read-only entitlement status, and non-sensitive history without accessing `~/.near-credentials` or carrying API-key/profile material.

## Execution waves

1. **Wave 1 — scoped provider identity:** `05-01-PLAN.md` adds versioned organization-profile contracts and persistence, project/profile SecretStorage isolation, explicit validation and switching, legacy-key migration, and host/UI wiring.
2. **Wave 2 — attributed telemetry:** `05-02-PLAN.md` snapshots selected organization/project attribution onto provider, activity, approval/audit, analytics, and export paths, then exposes validated filters and negative coverage.
3. **Wave 3 — external wallet entitlements:** `05-03-PLAN.md` adds verified read-only balance/stake/credit status, external-wallet authorization, exact approval-bound stake transactions, stale/unavailable handling, non-sensitive history, and wallet/profile/key leakage negatives.
4. **Wave 3 — attribution gap closure:** `05-04-PLAN.md` makes the session attribution snapshot authoritative for every rehydrated event and adds conflicting-ledger and legacy-unknown regressions.
5. **Wave 4 — release gap closure:** `05-05-PLAN.md` adds the Marketplace listing, trust/security report, dependency/provenance evidence, visual demos, and fail-closed VSIX content verification.

## Dependency graph

```text
05-01 ───> 05-02 ───> 05-03 ───> 05-05
              └───────> 05-04 ────┘
```

## Source coverage audit

| Source | Item | Covered by | Status |
|---|---|---|---|
| GOAL | Distinct NEAR AI API keys per workspace project and named organization/company profiles with selected-profile cost attribution | 05-01, 05-02 | COVERED |
| REQ | AUTH-01 — API keys use VS Code SecretStorage | 05-01 | COVERED |
| REQ | AUTH-03 — project/profile key isolation with no workspace/log/prompt/analytics/export leakage | 05-01, 05-02 | COVERED |
| REQ | MODEL-03 — explicit provider scope and no silent cloud fallback | 05-01 | COVERED |
| REQ | MODEL-04 — explicit active provider/organization profile and validation/switching | 05-01 | COVERED |
| REQ | COST-03 — live project/session request, token, estimate/actual, model, and budget analytics | 05-02 | COVERED |
| REQ | COST-04 — organization/project attribution, filters, and export | 05-02 | COVERED |
| REQ | TEST-01 — automated auth/provider/cost boundary verification | 05-01, 05-02 | COVERED |
| REQ | SEC-01 — threat model, least privilege, negative tests, redaction, and evidence | 05-01, 05-02 | COVERED |
| REQ | SEC-02 — SecretStorage-only credentials and exclusion from all durable/display surfaces | 05-01, 05-02 | COVERED |
| RESEARCH | Phase 2 OpenAI-compatible client with separate usage reconciliation and explicit unavailable values | 05-01, 05-02 | COVERED |
| RESEARCH | Phase 4 bounded atomic ledgers, allowlisted metadata, host-side analytics, and privacy redaction | 05-01, 05-02 | COVERED |
| CONTEXT | STATE.md: credentials scoped to explicit project and organization profile; no implicit cross-project reuse | 05-01 | COVERED |
| CONTEXT | STATE.md: analytics recomputed in the extension host from bounded records | 05-02 | COVERED |
| CONTEXT | STATE.md: provider fallback is never silent and audit records remain non-sensitive | 05-01, 05-02 | COVERED |
| REQ | AUTH-04 — explicitly authorized wallet/account access without local credential-file access | 05-03 | COVERED |
| REQ | COST-05 — read-only credit, entitlement/staking, validator, network, and refresh status | 05-03 | COVERED |
| REQ | STAKE-01 — verified validator staking with exact preview, explicit approval, tracking, and recovery | 05-03 | COVERED |
| REQ | STAKE-02 — wallet/API-key separation, fresh authorization, no signing material, no ~/.near-credentials mutation | 05-03 | COVERED |
| REQ | STAKE-03 — bounded non-sensitive stake/unstake/credit history and audit facts | 05-03 | COVERED |
| RESEARCH | NEAR AI Terms: non-custodial ownership, validator-mediated credits, delayed reflection, organization scope, and unlock period | 05-03 | COVERED |
| RESEARCH | NEAR Wallet Selector: external sign-in, account discovery, callback handling, and user-mediated transaction signing | 05-03 | COVERED |
| RESEARCH | NEAR reference staking lifecycle: deposit-and-stake, unstake, and delayed withdrawal | 05-03 | COVERED |
| RESEARCH | Exact NEAR AI entitlement endpoint/validator contract is not published in reviewed docs; verified release configuration and fail-closed behavior are planned | 05-03 | COVERED |
| CONTEXT | STATE.md Phase 05 decision: wallet/staking is separate from API-key profiles and never accesses ~/.near-credentials | 05-03 | COVERED |
| GAP | Verification blocker — rehydrated events can override session organization/project attribution | 05-04 | COVERED |
| GOAL | Release readiness requires accurate trust/security evidence and a clean release candidate VSIX | 05-05 | COVERED |
| REQ | PKG-01 — buildable/installable VSIX with documented local development and installation | 05-05 | COVERED |
| REQ | PKG-02 — accurate Marketplace listing with privacy, sovereignty, onboarding, transparency, visuals, troubleshooting, and roadmap | 05-05 | COVERED |
| REQ | SEC-03 — public trust/security report with permissions, boundaries, provenance, reproducible commands, review results, limitations, and remediation | 05-05 | COVERED |
| CONTEXT | STATE.md release decision: Marketplace presentation must explain product and privacy boundaries accurately | 05-05 | COVERED |
| CONTEXT | STATE.md security decision: release adds a public-facing trust/security report | 05-05 | COVERED |

## Security boundary

The only credential-bearing boundary is the extension-host `SecretStorage` adapter. Profile metadata, active selection, attribution snapshots, webview messages, local ledgers, audit records, analytics DTOs, and exports are non-secret allowlisted surfaces. The plan never reads, writes, migrates, or deletes files under `~/.near-credentials`.

## Verification gate

Each plan has focused automated tests plus the repository gates `npm run lint`, `npm test`, and `npm run package`. Gap-closure Plan 05-04 adds a direct persisted-ledger conflict test and preserves legacy-unknown semantics. Gap-closure Plan 05-05 adds `npm run verify:release`, dependency/provenance and production audit evidence, backdoor-oriented review results, Marketplace visual assets, and VSIX inclusion/exclusion tests. Negative tests must cover cross-workspace/profile access, unvalidated switching, legacy fallback, secret-shaped webview input, stale attribution, prompt/context leakage, export leakage, silent wallet submission, wrong network/validator, forged balances, key/seed exposure, local NEAR credential-file access, project API-key/profile leakage, and development-artifact leakage from the release archive.
