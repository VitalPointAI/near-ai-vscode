---
phase: 102-institutional-joint-staff-teams
plan: "11"
completed: "2026-11-27"
status: verified-local
requirements: [LANG-02]
---

# 102-11 Reviewed English and French renditions for the fictional library fixture

The registered J9-CL02 fixture produces an immutable fictional library service comparison. An English (en-CA) and a French (fr-CA) version each carry a manual authoring marker and their own digest. One review covers the exact pair, original draft, admitted citation metadata and policy revision. The fixture review is held by a separate authority from the agent and source custodian.

With current recipient access, the fixture can record a selected language or language-tagged bilingual HTML in memory. It escapes authored text and preserves the original citation identities, revisions and hashes. A changed source or rendition requires a fresh exact review. The fixture checks the staged record, current sources and consent, exact pair review and recipient access under one interlock immediately before recording.

After a source correction, the separately authorized history path returns the old source version, per-language digests and review receipt. It checks the former pair, current policy and consent, present history permission and continuity of the logical source identities. A withdrawn history grant and an unknown pair produce the same unavailable result. Historical access covers only review metadata. The recorder and history reader run exclusively inside the test harness.

## Verification

- The current recording test initially failed to compile because the fixture recorder was missing. The completed recording slice at `41940e272` compiled and passed all 50 focused tests. Local evidence is in `/tmp/sovai-rendition-red.sPh7lA/verification.log` and `/tmp/sovai-rendition-green.OPkq3k/verification.log`.
- The history test initially failed to compile because the metadata route was missing. With the history route present, the capped TypeScript compile and the institutional tracer and architecture suites passed all 50 tests with zero skips. Local evidence is in `/tmp/sovai-rendition-history-red.BaySoL/verification.log` and `/tmp/sovai-rendition-history-green.OX1g99/verification.log`.

**LANG-03** tracks model-generated renditions, including evaluation and approval of exact model artifacts and deployments. This fixture uses human-authored English and French.

## Open conditions

- **G17** remains open for verified production reviewer identity, separation of duties and authorization evidence for review and release.
- **G62** remains open for governed access to real sources, confinement of real material and historical metadata, and production export permission.
