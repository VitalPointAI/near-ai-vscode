---
phase: "44"
slug: accreditation-evidence-and-compliance-dashboard
status: draft
threats_open: 2
asvs_level: 1
created: "2026-11-22"
---

# Phase 44 security audit

This is a partial audit. The table records confirmed findings and owner-managed controls reviewed during plan 44-19 close-out. The full plan threat register still needs sign-off.

| Threat | Status | Evidence |
| --- | --- | --- |
| T-44-06 | Mitigated locally | Both evidence uploads require the raw bundle scan outcome to be successful. The workflow contract tests cover the guard. |
| T-44-20 | Mitigated locally for the production fetch path | The guarded fetcher keeps its abort deadline through body consumption and limits streamed bytes before retaining an oversized chunk. The fetch regression exercises an oversized response without a content length. |
| T-44-27, T-44-67 | Open at the high threshold pending live verification | The daily workflow checks the main ref and scopes the secret to one step. The authenticated GitHub environment lookup returned HTTP 404 on 2026-11-22. The owner-managed branch policy and read-only credential permissions still require confirmation. |
| T-44-46 | Mitigated locally for generated bundles | Bundle generation runs the dashboard copy lint before writing output files or a manifest. The regression tests a rejected unsupported claim. |
| T-44-47 | Mitigated locally | The bundle writer refuses to replace existing output files or write through a symlink. The regression checks both refusals. The manifest independently validates bundle entries. |

No risks were accepted.
