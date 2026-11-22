---
phase: "44"
slug: accreditation-evidence-and-compliance-dashboard
status: blocked
threats_open: 2
asvs_level: 1
created: "2026-11-22"
---

# Phase 44 security audit

The ASVS Level 1 audit covered 89 plan threat entries at integration commit `75393a3c`. It found two high-severity entries for the same GitHub environment and credential. The audit incorporates documented owner approvals and verification of the operational controls.

| Threat | Status | Evidence |
| --- | --- | --- |
| T-44-06 | Mitigated locally | Both evidence uploads require the raw bundle scan outcome to be successful. The workflow contract tests cover the guard. |
| T-44-20 | Mitigated locally for the production fetch path | The guarded fetcher keeps its abort deadline through body consumption and limits streamed bytes before retaining an oversized chunk. The fetch regression exercises an oversized response without a content length. |
| T-44-27, T-44-67 | Open at the high threshold | The daily workflow checks the main ref and scopes the secret to one step. The authenticated GitHub environment inventory on 2026-11-22 lists `agent-review`, `agent-review-gates` and `marketplace`. The main-only `compliance-settings` policy and read-only credential require owner setup and live verification. |
| T-44-23, T-44-SC (44-06) | Closed | Plan 44-06 records approval of `parse5@7.3.0` and `yaml@2.9.1` before installation. The exact lockfile pins and CI use of `--ignore-scripts` implement the install controls. |
| T-44-32, T-44-SC (44-09) | Closed | Plan 44-09 records the dated human checkpoint and the four approved pins, including Trestle 5.2.1. The approved OSCAL tracer passed in scratch with the plan's systemd 4 GiB memory cap, zero swap and a 90-second timeout. |
| T-44-40 | Closed | `compliance/src/import/cpcsc-level-1.ts` throws on any ID difference from the pinned list. The separately scheduled source watcher records changes for operators. |
| T-44-53 | Closed | Plan 44-16 records the 11 passing licence checks and the dated approval to commit public source data. The owner subsequently approved the official ITSG-33 statements for the assessor package. |
| T-44-70 | Closed | The authenticated branch-protection read confirmed `require_code_owner_reviews: false` and one required approving review. |
| T-44-46 | Mitigated locally for generated bundles | Bundle generation runs the dashboard copy lint before writing output files or a manifest. The regression tests a rejected unsupported claim. |
| T-44-47 | Mitigated locally | The bundle writer refuses to replace existing output files or write through a symlink. The regression checks both refusals. The manifest independently validates bundle entries. |

The four entries below the blocking threshold are T-44-11, T-44-26 and T-44-60, which lack an accepted-risk entry, and T-44-54, which retains the owner spot-check condition. GitHub has recorded owner and independent reviewer approval for catalogue PR #154 at `1c79424e`.

The accepted-risk log is empty.

## Security Audit 2026-11-22

| Metric | Count |
|---|---|
| Threats found | 89 |
| Closed | 83 |
| Open | 6 |
| Blocking | 2 |
