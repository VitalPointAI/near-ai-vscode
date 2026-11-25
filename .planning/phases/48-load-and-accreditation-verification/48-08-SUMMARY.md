---
phase: 48-load-and-accreditation-verification
plan: 08
subsystem: compliance
status: checkpoint (Task 3, owner approval of gate PR 3, pending; no PR opened, by instruction)
tags: [compliance, hosted, statements, evidence-rules, section-10, VER-04, VER-05, VER-08]
requires: [48-05, 48-06, "47 waves 4 to 7 on main", "48-08 batch 1 (#175)"]
provides:
  - statements and evidence rules for keycloak, oauth2-proxy, theia-cloud, openbao, rke2, image-registry, ingress, cert-manager, site-storage, site-logging, offline-bundle and the hub on Kubernetes
  - compliance/evidence-rules/hosted-identity.json and hosted-secrets.json (new), more rules in hosted-platform.json and hub.json
  - hostedEvidence.test.ts: Keycloak Met with a fresh export, Stale at 8 days, missing-result without one; every deploy-only statement Met from the passing report
  - 24 section 10 rows and register rows 11 and 12 naming rule ids
affects: [48-09 (reference export and signer key, G482), 48-10 (final section 10 sync), 44.1 (applicability)]
key-files:
  created:
    - compliance/evidence-rules/hosted-identity.json
    - compliance/evidence-rules/hosted-secrets.json
  modified:
    - compliance/components/{keycloak,oauth2-proxy,theia-cloud,openbao,rke2,image-registry,ingress,cert-manager,site-storage,site-logging,offline-bundle,hub}.json
    - compliance/evidence-rules/hosted-platform.json
    - compliance/evidence-rules/hub.json
    - compliance/gaps.json
    - compliance/test/hostedEvidence.test.ts
    - compliance/test/levels.test.ts
    - compliance/test/gaps.test.ts
    - compliance/test/fixtures/hosted/deploy-report.ndjson
    - docs/security/hosted-verification-records.md
    - docs-site/content/security/road-to-production.md
decisions:
  - Statements that need the running site carry a deployment observation rule beside their test rules, so they read missing-result until the reference export lands (G482), never Met from the render alone
  - Register rows 11 and 12 name keycloak.ia-05.sign-in-keys; row 13 keeps G330, because the realm check proves only that the relying-party ID is a bare domain name, not that it is the shared parent domain of the DNS layout
  - hsm gets no statement; the only openbao seal statement is that the install preflight refuses SoftHSM2 outside the lab
  - rke2 cm-06 says CIS profile, as the test proves; the STIG profile stays in G334
  - The per-component gaps are narrowed to what is still waiting, never deleted; those whose rows all switched now close by evidence
metrics:
  completed: 2026-11-25
actuals:
  tasks: 2
  commits: 16
plan_head_before: 32007751db9e9a85bfaf163cc1098c790b29a10e
plan_head_after: 0880727e1e41b3f33ccf01740e88d523a8a92a09
---

# Phase 48 Plan 08: Phase 47 component statements and the hub Summary

Twelve hosted components now say what the built deployment does, each statement tied to Phase 47 tests by exact name, to a deployment observation, or to the dated records. Keycloak's sign-in statement is the tracer: it reads Met with the realm tests and a fresh signed export, Stale at 8 days and missing-result with none. hsm stays empty.

The branch `feat/phase-48-statements` carries both 48-07 and 48-08, as instructed. The `commits: 16` above is measured over the whole branch. The 48-08 commits are 79b8a4d3, 966cdc51, d73ab9b4, 53dbcaf9, 5aaf0eb9, 9dd769b0, aaba9b9d, 8f229556 and 0880727e, plus cbcc4eb0, which it shares with 48-07.

## Per component (13 components of this set)

| Component | Statements added (control) | Rules by kind | Still waiting (gap) |
|---|---|---|---|
| keycloak | ia-02 passkey-only realm; ia-05 signInKeys levels; ia-11 step-up level; au-12 events; ac-02 administrator-only accounts; sc-08 Postgres TLS; sc-28 Postgres volumes; si-02 CVE-2026-6856 fix version | 14 test, 4 deployment, 1 documents | strict FIPS mode with BC-FIPS (G332); live evidence (G335, G482); Red Hat build (G321) |
| oauth2-proxy | sc-08 TLS verify; sc-23 secure cookies; ia-05 client secret from files; ia-02 forwarded identity and trusted path | 5 test | Go FIPS module build (G337) |
| theia-cloud | cm-02 pinned images; cm-06 session settings and Pod Security; sc-08 site chain; sc-23 chart sidecar defaults replaced; au-12 session audit; si-07 images verified on site | 12 test, 4 deployment | FIPS JRE rebuild, no Debian or Alpine bases (G336); live evidence (G482) |
| openbao | ac-03 per-person policies; ac-05 two custodians for key moves; ia-11 step-up role; sc-08 TLS; sc-12 no SoftHSM2 seal outside the lab; au-12 audit device; au-05 sealed or failing-audit alerts | 16 test, 1 deployment | HSM seal with a validated model (G324); kms-pkcs11 test (G326); tamper-evident audit store (G2); key ceremony (G338) |
| hsm | none | none | Level 3 model certificate (G324); kms-pkcs11 (G326); export-controlled handling (G339) |
| rke2 | au-02 audit policy; cm-06 server config and Pod Security; sc-07 site-only egress; sc-28 Secrets encryption; au-08 site time; sc-13 FIPS hosts (export) | 12 test, 1 deployment (plus batch 1's cm-07) | FIPS build with Canal, STIG profile (G334) |
| image-registry | si-07 signed admission; ia-05 no default credentials; au-12 registry audit (export) | 4 test, 2 deployment | scanning, SBOM storage, OIDC (G341); validated-module builds (G333) |
| ingress | sc-08 HAProxy (plus batch 1's cm-07) | 1 test (plus 1) | HAProxy FIPS (G340); Traefik (G325) |
| cert-manager | sc-12 OpenBao-backed issuers (plus batch 1's sc-17) | 2 test (plus 1) | closes by evidence (G343) |
| site-storage | sc-28 encrypted class and volume key; cp-09 backups and escrow | 7 test | closes by evidence (G345) |
| site-logging | au-09 site store; au-05 shipping alerts | 6 test | closes by evidence (G346) |
| offline-bundle | si-07 import refusals | 8 test | no section 10 condition |
| hub | cm-06 hardened StatefulSet; sc-07 several hubs, own TLS, no Ingress | 6 test | session keys with a site-issued certificate (G344) |

## Section 10 and register

These 24 section 10 rows now name a rule: 3, 6, 7, 8, 10 to 13, 15 to 18, 29, 33, 35, 37, 43 to 45 and 47 to 49. Rows 38, 41 and 42 were switched by 48-07. Rows 4 and 28 were switched in batch 1. The remaining rows keep their gaps: 1, 2, 5, 9, 14, 19 to 27, 30 to 32, 34, 36, 39, 40 and 46. Register rows 11 and 12 name `keycloak.ia-05.sign-in-keys`. Row 13 keeps G330.

## Hosted counts (local bundle, deploy and workbench report fixtures, no export, no root report)

| Level | Control rows met | Partly met | Not met | Your organization's | Component cells Met | Missing result | No statement yet |
|---|---|---|---|---|---|---|---|
| hosted-protected-a | 0 | 21 | 283 | 113 | 41 | 21 | 4,494 |
| hosted-protected-b | 0 | 21 | 283 | 113 | 41 | 21 | 4,494 |
| hosted-itsp-10-171 (overlay) | 0 | 0 | 0 | 131 | 0 | 0 | 0 |

Before this work, hosted-protected-b had 2 partly met control rows and 4,543 no-statement cells. The 21 missing-result cells are the deployment observation rules waiting on G482. No control row reaches Met, because every other in-scope component still has no statement for that control (see Applicability).

## Verification

Run once at the boundary, with memory caps:
- compliance: 556 run, 556 passed. Separately, gaps.test, bundle.test and roadToProduction after G482: 37 passed.
- `cli.ts validate`: clean.
- resource-check: 141 resources.
- word-lint on the records: clean.
- `build-road-to-production --check`: clean.
- workflow-files, component-catalogue and resource-check root tests plus the docs-site tests: 116 run, 108 passed at first. The 8 serveOverlay failures came from a missing `sirv`, because docs-site had no install. After `npm --prefix docs-site ci --ignore-scripts`, all 8 passed.
- The deploy suite was run locally with the pinned helm 4.3.2: 197 passed. Its rows are the fixture.

Tests added or changed:
- hostedEvidence: 4 new tests: the Keycloak rule set, Met, Stale and missing-result, deploy-only Met, and failed or absent.
- levels.test: one existing test now skips components that have a statement. A stated row must still never read Met or No statement yet.
- gaps.test: the register count went from 420 to 423.

The RED commits failed on their base first (79b8a4d3, d73ab9b4).

## TDD Gate Compliance

- Task 1: RED 79b8a4d3, then GREEN 966cdc51.
- Task 2: RED d73ab9b4, then GREEN 53dbcaf9, 5aaf0eb9, 9dd769b0 and aaba9b9d.

## Deviations from Plan

1. **[Rule 1] A levels.test assertion encoded the empty start.** The test "every hosted platform row of hosted Protected B ac-02 reads No statement yet" failed once Keycloak had an ac-02 statement. It now checks the empty components exactly as before, and requires a stated component to be neither Met nor No statement yet in a bundle without evidence. Batch 1 made the same change to its sibling test.
2. **[Rule 2] Gaps G480 to G482 added.** These are considerations the plan did not foresee: the container suite has no report, the compliance job does not wait for the workbench job, and there is no reference export or signer key yet.
3. **Branch and PR.** The plan names `feat/phase-48-statements-deployment` and its own gate PR. As instructed, the work is on `feat/phase-48-statements` together with 48-07, and no PR was opened.
4. **No per-component commits.** The rule files are shared by area, so the commits are grouped by area (identity, secrets, platform, hub) instead.

## Owner checkpoint (Task 3, gate PR 3)

Gate files touched by this plan:
- `compliance/components/{keycloak,oauth2-proxy,theia-cloud,openbao,rke2,image-registry,ingress,cert-manager,site-storage,site-logging,offline-bundle,hub}.json`
- `compliance/evidence-rules/{hosted-identity,hosted-secrets,hosted-platform,hub}.json`

To spot-check, read any three statements against the tests they cite. Confirm that no statement rests on SoftHSM2 (the openbao sc-12 statement says SoftHSM2 is refused) and that no hosted tailoring was added (hostedEvidence checks this). Then approve the gate check once a PR exists.

## Applicability (for 44.1, no mechanism here)

Phase 48 has no per-component applicability mechanism. A component-definition `not-applicable` responsibility reads Not met (unreviewed) unless a tailoring record backs it, and hosted tailoring is ruled out (research Pitfall 5). So I recorded no Not-applicable value.

Most of the remaining no-statement cells are controls a component takes no part in. For example, hsm has no part in ac-17, and offline-bundle has no part in ia-02. Each such cell exists only because its family's default responsibility is shared. 44.1's applicability work is the place to settle these.

## Known Stubs

None.

## Open conditions

- The hosted deployment observation rules read missing-result until the reference site's operator key and signed export are committed (G482).
- Keycloak's version, live authenticators and shipped events wait on that evidence (G335).
- Keycloak strict FIPS mode: the BC-FIPS version is not on a certificate (G332).
- The relying-party ID check proves domain syntax only, not the shared parent domain (G330).
- RKE2 FIPS build with Canal and the STIG profile (G334).
- Theia Cloud FIPS JRE rebuild and no Debian or Alpine bases (G336).
- oauth2-proxy Go FIPS module build (G337).
- Registry scanning, SBOM storage and OIDC (G341); validated-module registry builds (G333).
- HAProxy FIPS provider (G340); Traefik with Theia Cloud (G325).
- HSM model certificate (G324) and kms-pkcs11 against it (G326); export-controlled hardware handling (G339).
- OpenBao key ceremony (G338); tamper-evident audit store (G2).
- Hub session keys with a site-issued certificate (G344).
- Step-up re-authentication through the sidecar on the rig (G328).

## Self-Check: PASSED

The three new files exist (hosted-identity.json, hosted-secrets.json, and this summary). Commits 79b8a4d3, 966cdc51, d73ab9b4, 53dbcaf9, 5aaf0eb9, 9dd769b0, aaba9b9d, 8f229556, cbcc4eb0 and 0880727e are on HEAD.
