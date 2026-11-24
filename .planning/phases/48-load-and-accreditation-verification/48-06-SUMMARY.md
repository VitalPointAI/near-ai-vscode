---
phase: 48-load-and-accreditation-verification
plan: 06
subsystem: ci
status: checkpoint (owner approval of gate PR 1 pending; PR not opened by the executor)
tags: [ci, compliance, deployment-evidence, loadtest, test-reports, gate]
requires: [48-01, 48-02, 48-03, 48-05]
provides:
  - "deployment collector input (reference export + public site trust list) in the main and daily bundles"
  - "load-test type check and unit tests in the compliance job"
  - "workbench and deploy test reports read once those packages exist, with a workflow-files invariant"
  - "KEYCLOAK_MIN_FIXED cross-check against the dated desk record"
affects: [48-07, 48-08, 48-09]
key-files:
  modified:
    - .github/workflows/ci.yml
    - .github/workflows/compliance-scheduled.yml
    - scripts/test/workflow-files.test.mjs
    - compliance/test/collectorDeployment.test.ts
    - .planning/ROADMAP.md
---

# 48-06 Summary: CI wiring for gate PR 1

## What it does

Every main build and every daily bundle now runs the `deployment` collector on the reference site's export
(`compliance/site-evidence/reference.json`) with the public site trust list (`compliance/attestations/site-signers.json`).
The export does not exist yet, so the collector runs and fails with `export-missing`: the dashboard says plainly that no
hosted evidence has arrived. Every pull request now type-checks and runs the load-test unit tests. The compliance job
reads the `workbench` and `deploy` test reports as soon as those packages exist in the checkout, and a workflow-files
test then requires each to have a job that writes and uploads its report.

## Changes

- `ci.yml`, compliance job: a "Load-test unit tests and type check" step after `npm --prefix compliance test` (same presence
  condition; exits 0 when `loadtest/package.json` is absent, so old hotfix checkouts pass); the inputs script imports
  `existsSync`, adds `workbench` when `workbench/package.json` exists and `deploy` when `deploy/test` exists, and adds the
  `deployment` input beside `documents` and `crypto` (the existing `documents ... crypto` text is unchanged).
- `compliance-scheduled.yml`: the same `deployment` input, so an export older than 7 days turns Stale without a commit.
- `workflow-files.test.mjs`: the load-test step's order, guard and type check; the presence rules; a new test that both
  public workflows name the deployment input exactly once and no other `site-evidence/` path or site trust list; the
  report-upload test generalised to every package the reports list names (base list pinned to root, relay, hub;
  conditional ones checked only when present).
- `collectorDeployment.test.ts`: `KEYCLOAK_MIN_FIXED` equals the single `Minimum upstream version:` line under the
  Keycloak heading of `docs/security/hosted-verification-records.md` (26.8.0; no change to the constant was needed).

## Merge of origin/main

`origin/main` (#168 GHCR release.yml, #169 container-release publication approval) merged with no conflicts; release.yml is
main's version unchanged.

## Local tracer bundle (inputs as the workflow writes them, kind pr, no VSIX)

- `collectors.json` deployment row: `{"id":"deployment","ran":true,"ok":false,"error":"export-missing"}`.
- `hosted-protected-a`: 15 components; met 0, partly met 2, not met 302, your organization's responsibility 113.
- `hosted-protected-b`: 15 components; met 0, partly met 2, not met 302, your organization's responsibility 113.
- `hosted-itsp-10-171` (overlay): 15 components; your organization's responsibility 131.

## Verification (run once at the boundary, capped)

compliance 530/530, `cli.ts validate` clean, docs-site 64/64, loadtest 43/43 (with tsc clean), root `scripts/test/*.test.mjs` 189/190, the one failure being orgIssuer.test.mjs, which needs the compiled `dist/` (MODULE_NOT_FOUND); after `npm ci --ignore-scripts && npm run compile` it passed 8/8. resource-check: 54 resources, all reviewed.

## Owner checkpoint (Task 3): what the owner approves

1. Gate files (by `gateFileChanges` against main): `.github/workflows/ci.yml`, `.github/workflows/compliance-scheduled.yml`,
   `compliance/attestations/site-signers.json`, `compliance/components/{cert-manager,hsm,image-registry,ingress,keycloak,
   oauth2-proxy,offline-bundle,openbao,rke2,site-logging,site-storage,theia-cloud,workbench}.json`, `compliance/levels.json`,
   `compliance/src/{bundle,cli,controlText,riskAcceptance,rules,siteExport}.ts`, `compliance/src/collectors/{deployment,documents}.ts`,
   `compliance/src/commands/site-export.ts`, `scripts/test/workflow-files.test.mjs`.
2. Hosted scope: separate levels `hosted-protected-a`, `hosted-protected-b` and the `hosted-itsp-10-171` overlay; whether
   hosted CPCSC, Controlled Goods or ITAR overlays are wanted now (default: not now).
3. The `documents.ts` `REQUIRED_DOCUMENTS` entry making `docs/security/hosted-verification-records.md` a reviewed required
   document (365-day window).
4. The empty site trust list `compliance/attestations/site-signers.json` (`{"signers": []}`); a dedicated operator key is
   added when the rig exists; 7-day export window.
5. POA&M target dates: G321 2027-01-29; G333 2027-02-26; G325, G327, G328, G331, G332 2027-03-31; G322, G323, G324, G326
   2027-06-30 (G329, G330 close in Phase 48).
6. The reference rig as the only public evidence source (customers see their own site in a local view).
7. Approve the gate check on the PR.

PR URL and gate run URL: not opened by the executor (orchestrator instruction); to be added when the PR opens.
