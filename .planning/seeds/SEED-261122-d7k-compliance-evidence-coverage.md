---
id: SEED-261122-d7k
status: dormant
planted: 2026-11-22
planted_during: "Phase 44 close-out"
trigger_when: "When continuing Phase 44 evidence collection or planning subsequent accreditation evidence work"
scope: "Evidence coverage for each applicable control, prioritized by profile"
---

# Compliance evidence coverage priorities

Cover Unclassified and Protected A first as the minimum baseline. Then extend coverage toward Protected B, the Classified appliance baseline, and the adjacent overlays, including ITSP.10.171, CPCSC Level 1, Controlled Goods, and ITAR.

For each applicable control, show dated evidence and its source, or identify the missing evidence and who owns it. Reuse evidence across profiles where the same scope and assessment objective apply. Keep documented exclusions, inherited controls, and organization-owned evidence visible. Keep the current Classified appliance reference and no product claim until evidence and the relevant authorization support a change.

## Evidence standard

Write an implementation statement only after verifying that the control is implemented for the stated scope. Link it to evidence that shows the control in effect. Use a dated screenshot when it demonstrates the behavior or setting. For controls that are better verified another way, use a reproducible test result, configuration snapshot, audit record, or signed artifact as appropriate. Record the assessed version or environment and keep sensitive evidence in the authorized assessor location.

Keep the control open when the implementation is missing or the evidence is insufficient. Record the specific gap and who owns it, and track the remedy under Phase 44.1 or the delivery phase that already covers it. These gaps are follow-up work for assessment readiness while the application is being developed.

## Where to start

The first scheduled bundle listed 13 Unclassified and 417 Protected A control rows. Nine Unclassified rows and 287 Protected A rows had no implementation statement. Start with these mapping gaps alongside missing or skipped collection results, using the existing dashboard and evidence rules to track progress.

The first Unclassified pass has three groups:

- Existing mappings with tests reported as unrun: AC-03 access enforcement, CP-09 system backup, and SC-07 boundary protection. The first scheduled bundle contains zero test rows. Its previous-bundle reader carries forward observations only, while test rules read test rows. The manifest-verified main-push dashboard from run 45046469330 shows all three as Met for the same commit. Preserve the original commit and freshness when addressing the carry-forward gap.
- Check the scheduled workflow's source selection separately. It currently picks the latest successful main CI run, including manual runs that publish no bundle. Prefer the main-push artifact for the scheduled commit when available, while preserving the existing treatment of prior observations.
- Missing implementation statements: AC-02 account management, AU-02 event logging, CM-02 baseline configuration, IR-01 incident response policy and procedures, SA-09 external system services, SI-02 flaw remediation, SI-03 malicious code protection, SI-04 system monitoring, and SI-05 security alerts, advisories, and directives. Map each to existing evidence where supported and record the remaining gaps.
- Organization-owned evidence: MP-02 media access.

## Breadcrumbs

- [Phase 44 evidence scope on main](https://github.com/VitalPointAI/near-ai-vscode/blob/1b8ce2686e526a72a3d9fed687cfb44d2bdc8a4e/.planning/phases/44-accreditation-evidence-and-compliance-dashboard/44-CONTEXT.md)
- [First scheduled evidence run](https://github.com/VitalPointAI/near-ai-vscode/actions/runs/45046485353)
- [Same-commit CI evidence carry-forward fix](https://github.com/VitalPointAI/near-ai-vscode/pull/156)
