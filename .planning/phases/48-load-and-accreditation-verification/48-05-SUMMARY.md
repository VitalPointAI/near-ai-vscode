---
phase: 48-load-and-accreditation-verification
plan: 05
subsystem: compliance
status: complete
tags: [verification-register, section-10, desk-records, gaps, poam, VER-08, VER-09]
requires:
  - 48-01 hosted level ids (hosted-protected-a, hosted-protected-b, hosted-itsp-10-171) as gap profiles; no test here reads levels.json, so this plan's tests pass before and after 48-01 merges
provides:
  - docs/security/hosted-verification-records.md (Section 10 conditions, Verification register, 11 dated desk records)
  - gaps G321 to G346 and POA&M items g321 to g328, g331 to g333
  - the records document as a reviewed REQUIRED_DOCUMENTS entry (365-day window)
affects:
  - 48-06 (gate PR 1 carries the documents.ts edit; owner confirms the proposed target dates; checks the deployment collector's Keycloak minimum equals 26.8.0)
  - 48-07, 48-08 (close the per-component gaps G334 to G346 and the decided gaps G329, G330 with statements and rules)
  - 48-09, 48-10 (close the rig gaps G322, G323, G325 to G328, G331 with run files)
tech-stack:
  added: []
  patterns: [desk record = heading with Source, Checked and fenced verbatim quote; register reference grammar "Record: <heading>; gap Gnnn; rule <id>"]
key-files:
  created:
    - docs/security/hosted-verification-records.md
    - compliance/poam/g321.json ... g328.json, g331.json, g332.json, g333.json
  modified:
    - compliance/src/collectors/documents.ts (gate path)
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - compliance/test/collectorDocuments.test.ts
decisions:
  - The register has 18 rows, not 17: DESIGN section 12 gained a 15th row (cross-device passkey sign-in) in eecfdb56 after the plan was written; the test derives the count from DESIGN.md plus the three D-24 items
  - Keycloak minimum upstream version 26.8.0 (pin 26.8.2); the Red Hat build stays open as G321
  - BC-FIPS 2.1.3, the version Keycloak's FIPS guide asks for, is on no certificate yet (going into submission), so the Keycloak strict-mode condition points at G332
  - RKE2's FIPS page names its NGINX ingress, not Traefik, as FIPS-built; the Traefik FIPS build joins the Traefik experiment in G325
  - Debian and Alpine bases at Protected B map to theia-cloud (as Phase 47-04 places that condition); UBI 9 host FIPS mode maps to rke2 and the RHEL provider to workbench
metrics:
  duration: about 95 minutes
  completed: 2026-11-24
actuals:
  tokens: 19778
  tasks: 3
  commits: 6
plan_head_before: bbba39932adf4539852b4ca61820babe371ff6f7
plan_head_after: b6d3d70e853ce01f52582b26a484f6792c1bd871
---

# Phase 48 Plan 05: Verification register and section 10 map Summary

I re-read every desk source on 2026-11-23 and quoted it. That produced the hosted verification register: 18 rows, each closed by a dated record, decided with a gap that closes in Phase 48, or open with an owner role and a POA&M target date. It also produced a 49-condition DESIGN section 10 map, in which every condition names one hosted component and one gap. Gaps G321 to G346 are scoped to the hosted levels, and the document is a reviewed required document, so it goes stale after a year.

## Register rows (state and reference)

| # | Item | State | Reference |
|---|---|---|---|
| 1 | Load test to the target session count | open | G322 |
| 2 | Hub capacity at its per-hub target | open | G323 |
| 3 | Keycloak CVE-2026-6856 fix version | closed | record + G321 (Red Hat build) |
| 4 | HSM FIPS 140-3 certificates | closed (candidates) | record + G324 (chosen model) |
| 5 | Go FIPS module certificate status | closed | record |
| 6 | Traefik with Theia Cloud | open | record (desk part) + G325 |
| 7 | OpenBao kms-pkcs11 v0.3.0 | open | record (release) + G326 |
| 8 | Theia Cloud project health | closed | record |
| 9 | Prewarm pool with personal volumes | open | record (desk part) + G327 |
| 10 | Step-up re-authentication through the sidecar | open | G328 |
| 11 | Synced passkeys / `signInKeys` | decided | G329 (closes in 48) |
| 12 | Cross-device (hybrid) passkey caveat | decided | G329 (closes in 48) |
| 13 | Shared relying-party ID | decided | G330 (closes in 48) |
| 14 | Large smart-card revocation lists | open | G331 |
| 15 | Theia 1.77 supported Node range | closed | record (Phase 46 had not recorded it) |
| 16 | UBI 9 / RHEL 9 OpenSSL FIPS provider | closed | record (#5573) |
| 17 | BC-FIPS for Keycloak strict mode | closed (module certificates) | record + G332 (version coupling) |
| 18 | Harbor and Zot FIPS builds | open | record (what exists) + G333 |

## Values that differ from research's draft (re-read 2026-11-23)

1. **Keycloak, row 3.** Issue 48388 has three fix commits, not two (`ff8937e0...` as well); all three are ancestors of 26.8.0 and 26.8.2. CVE-2026-37982's actual title is "Execute-actions token replay allows unauthorized WebAuthn credential enrollment on victim account". CVE-2026-8830 (research A12, not checked) is fixed upstream in 26.6.3, and its fix commit `47b9aef7` is in 26.8.0 and 26.8.2. Red Hat's security data now names "Red Hat build of Keycloak 26.4.12" as fixed for CVE-2026-6856 (RHSA-2026:19596), but it still lists the Red Hat build as "Affected" and names no 26.6 or later fix. Bugzilla 2460004 is still NEW. For CVE-2026-8830, the Red Hat builds 26.4.13 and 26.6.3 are fixed. The minimum (26.8.0) and the pin (26.8.2) are unchanged.
2. **HSM, row 4.**
   - #4745 has updates dated 9/8/2026 and 9/23/2026, plus hardware PCA10051-01.
   - #4765's caveat starts "Interim validation".
   - The NIST page for #4684 describes "a PCIe card which typically resides within a custom computing or secure communications appliance". It does not name the Luna Network HSM 7, so the record does not claim that mapping.
   - The NIST active search also lists Luna T7 #5450, Luna M7 #5300 and Luna G7 #4962. Research did not list these, and the record does not include them.
   - The Utimaco vendor search still returns only #5223 and #4992, so the Se-Series remains unconfirmed.
3. **UBI 9, row 16.** The #5573 caveat reads "When operated in approved mode. ..." (research paraphrased it as "validated only when operated in approved mode"). Red Hat lists #5573 for RHEL 9.0 too, with module 3.0.1-3f45e68ee408cd9c.
4. **BC-FIPS, row 17.** Research did not check this. Keycloak's FIPS guide asks for bc-fips 2.1.3, bctls-fips 2.1.25, bcpkix-fips 2.1.13 and bcutil-fips 2.1.8. Bouncy Castle says "The 2.1.3 release is a patch release ... going into submission", so a new gap, G332, records that no certificate covers it yet. NIST #4943 shows software version 2.1.1, while Bouncy Castle's page says "BC-FJA 2.1.0 ( Certificate #4943 )". #4943 has an update dated 11/10/2026. The guide also says Bouncy Castle FIPS is "not officially validated with OpenJDK 25" and recommends OpenJDK 21.
5. **Traefik, row 6 (research A9).** The RKE2 FIPS page is titled "FIPS 140-2 Enablement" and says "RKE2 ships with FIPS compliant NGINX as its default ingress provider". Its body does not mention Traefik. So no source confirms a FIPS build of RKE2's Traefik, and that part is in G325.
6. **Prewarm, row 9.** The EduIDE wording has changed to "A pool serves temporary workspaces (`none`) only." (page source at commit a9c4cf54, 2026-11-21). The chart comment reads "Currently only false is fully supported."
7. **Harbor and Zot, row 18 (research A11).** Zot documents a run-time FIPS 140-3 mode (`GODEBUG="fips140=only"`, since v2.1.9), and its tests run in that mode. No release says it was built with a validated module version. Harbor has none: the only code-search hits are its AWS ECR adapter, and its website repository has no hits. This stays a gap (G333).
8. **Unchanged:** Go #5247 and #5581 (dates and caveats as quoted), Theia 1.77 (`>=24`, CI `[24.x, 26.x]`), kms-pkcs11 v0.3.0, Theia Cloud 1.2.0 (repository pushed 2026-11-20).

## New gaps and proposed target dates (for the owner at the 48-06 checkpoint)

| Gap | Title (short) | Owner | Controls | Closes |
|---|---|---|---|---|
| G321 | Red Hat build fix release for CVE-2026-6856 | owner | si-02 | target 2027-01-29 |
| G322 | Load test at the target session count | owner | cp-02.02, sc-05 | phase 48, target 2027-06-30 |
| G323 | Hub load per hub | owner | cp-02.02 | phase 48, target 2027-06-30 |
| G324 | Chosen HSM model certificate | owner | sc-12, sc-13 | target 2027-06-30 |
| G325 | Traefik experiment and RKE2 Traefik FIPS build | owner | sc-08, sc-13 | phase 48, target 2027-03-31 |
| G326 | kms-pkcs11 against the chosen HSM | owner | sc-12 | phase 48, target 2027-06-30 |
| G327 | Cold start for persistent workspaces | owner | cp-02.02 | phase 48, target 2027-03-31 |
| G328 | Step-up through the sidecar | owner | ia-11 | phase 48, target 2027-03-31 |
| G329 | `signInKeys` levels evidence rules | maintainers | ia-02, ia-05 | closesInPhase 48 |
| G330 | Shared relying-party ID rule | maintainers | ia-02, ia-05 | closesInPhase 48 |
| G331 | Large revocation lists | owner | ia-05.02 | phase 48, target 2027-03-31 |
| G332 | BC-FIPS version not on a certificate | owner | sc-13 | target 2027-03-31 |
| G333 | Harbor and Zot validated-module builds | owner | sc-13 | target 2027-02-26 |
| G334 to G346 | One per component: rke2, keycloak, theia-cloud, oauth2-proxy, openbao (key ceremony), hsm (export-controlled handling), ingress, image-registry, workbench, cert-manager, hub, site-storage, site-logging | maintainers | per condition | closesInPhase 48 |

Section 10 also points at the existing G2 (OpenBao tamper-evident audit store). Gaps added: 26. POA&M items added: 11. Gaps with closesInPhase "48": 15.

## levelsBlocked and evidenceProgress change

I built the real bundle twice with the same inputs, once with this branch's gaps and once with the base `gaps.json` and without the new POA&M files, then restored the files:
- **Existing 323 gaps:** no change in `levelsBlocked` or state. No existing gap was rescoped.
- **The 26 new gaps:** state `planned`, `levelsBlocked` 0. They carry only the hosted profile ids, and the hosted levels do not exist on this branch until 48-01 merges.
- **Dashboard rows:** identical apart from collection timestamps.
- **After 48-01 merges:** the new gaps will cover hosted-protected-a and hosted-protected-b rows for their controls. The hosted overlay's rows use itsp171 ids, so these gaps do not touch them. The rise in `levelsBlocked` for existing unscoped gaps comes from 48-01's levels, not from these gaps (research Pitfall 8). Re-run the bundle comparison after the merge.

## Verification

- Task 1 and Task 2 commands: lint, `gaps.test.ts` plus `collectorDocuments.test.ts` (22 run, 0 failed), validate and word-lint all clean.
- Task 3 command: lint, the full compliance suite (502 run, 0 failed, 0 skipped), validate and word-lint all clean. The first run had 3 failures: the bundle copy lint flagged "certified" in the G344 remediation. I reworded it to "session keys with a site-issued certificate" and the re-run passed.
- Tests added: 10 cases in `gaps.test.ts` and 1 in `collectorDocuments.test.ts`. The existing register count assertion moved from 323/315 to 349/326. Each new test failed on its base first (RED commits bcbef380, ac1e0067, d739b1c1).
- Acceptance greps:
  - `Last reviewed:` 1
  - documents.ts entry 1
  - `Source: https://` lines 40
  - `Checked:` lines 40
  - `"hosted-protected-b"` in gaps.json 26
  - `## Section 10 conditions` 1
  - `"closesInPhase": "48"` 15
- The document has no capacity figures (no number followed by sessions, people or users, and no GiB or vCPU figures), so the 48-03 docs check will not flag it.

## TDD Gate Compliance

Every task ran RED, then GREEN: bcbef380 then 9bc19b6c, ac1e0067 then 73fb14e5, d739b1c1 then b6d3d70e. No refactor commit was needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The register size in the plan is out of date**
- **Found during:** Task 2
- **Issue:** The plan pins 17 rows (DESIGN 12's 14 items plus 3). Commit eecfdb56 then added a 15th DESIGN 12 row (cross-device passkey sign-in), which D-26 and the plan's own truths treat as a decided item.
- **Fix:** 18 rows. The test counts DESIGN.md's section 12 table and adds the three D-24 items. The decided rows are 11, 12 and 13, and the rig rows use the new numbering (CRL is row 14).
- **Files:** compliance/test/gaps.test.ts, docs/security/hosted-verification-records.md
- **Commits:** ac1e0067, 73fb14e5

**2. [Rule 1 - Bug] A compliance-claim word in gap text**
- **Found during:** Task 3
- **Issue:** "certified session keys" in the G344 remediation failed the dashboard copy lint, which made 3 bundle tests fail.
- **Fix:** Reworded in the gap and in Section 10 row 46.
- **Commit:** b6d3d70e

**3. [Rule 3 - Blocking] Worktree base**
- **Found during:** startup
- **Issue:** The worktree branch was at main (d7b87328), so it could not fast-forward to the expected base. The orchestrator authorized a hard reset, and the permission classifier refused it twice.
- **Fix:** I made the new branch `worktree-agent-a638417b842c7415e-p48-05` at bbba3993 instead. That matches option 1 (a branch made directly from the base) and discards nothing; the old branch still points at d7b87328.

**4. Record placement, by judgement.** Open rows that have a desk part (6, 7, 9, 18) also carry a record. Every record heading, open or closed, is a required heading, so dropping a record makes the documents observation fail. Verbatim quotes sit in fenced `text` blocks. The word-lint skips fences, so quoted source words such as "compliant" or "certified", and the go.dev em dash, stay exactly as the source has them.

## Threat model

- T-48-17: every value was re-read and quoted with its source and date. Unconfirmed parts became gaps. SoftHSM2 appears only as "proves wiring only".
- T-48-18: the register test resolves every reference and pins the row count to DESIGN.
- T-48-19: the document is in REQUIRED_DOCUMENTS with a review date.
- T-48-SC: no package was installed beyond the existing lockfile.

## Gate files touched

`compliance/src/collectors/documents.ts` (one REQUIRED_DOCUMENTS entry), which joins gate PR 1 at 48-06. The other changes are in non-gate paths: `compliance/gaps.json`, `compliance/poam/`, `compliance/test/` and `docs/security/`.

## Known Stubs

None.

## Self-Check: PASSED

All 16 changed files exist, and commits bcbef380, 9bc19b6c, ac1e0067, 73fb14e5, d739b1c1 and b6d3d70e are on HEAD.
