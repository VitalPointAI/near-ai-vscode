# Phase 4 Overview

Phase 4 delivers the complete agent control plane: durable non-sensitive profiles and accepted role teams, memorable identities with quiet mode, privacy sovereignty enforcement, explainable decaying reputation routing, lifecycle controls, approval previews, budgets, emergency stop, audit/resume state, and live/durable fleet analytics.

## Execution waves

1. **Wave 1 — independent foundations:**
   - `04-01-PLAN.md` — agent profiles, memorable identities, initialization questions, recommended teams, acceptance/customization, and project persistence.
   - `04-02-PLAN.md` — privacy classification/preflight, sovereignty modes, local-only exclusions, policy gate, overrides, and privacy-negative tests.
2. **Wave 2 — coordinated routing:**
   - `04-03-PLAN.md` — explainable role routing, decaying reputation evidence, profile-aware orchestration, lifecycle limits, and safe resurrection.
3. **Wave 3 — execution safety:**
   - `04-04-PLAN.md` — approval previews, budget enforcement, emergency stop, audit events, and restart/compaction-safe resumable execution.
4. **Wave 4 — user-facing observability:**
   - `04-05-PLAN.md` — live fleet view, event timeline, per-agent drill-down, durable analytics, filtering, reputation evidence, cost/model/latency summaries, and export.

## Dependency graph

```text
04-01 ─────┐
           ├──> 04-03 ───┐
04-02 ─────┘             ├──> 04-04 ───> 04-05
04-02 ───────────────────┘
04-01 ───────────────────────────────────┘
```

The plans deliberately reuse Phase 2/3 seams: normalized provider usage and estimate/actual cost fields, the versioned atomic local ledger, redacted lifecycle metadata, strict webview messages, non-replaying continuation, and workspace containment checks. No product code or Phase 5 work is included in this phase plan.

## Source coverage audit

| Source | Item | Covered by | Status |
|---|---|---|---|
| GOAL | Agents, routing, approvals, analytics control plane | 04-01 through 04-05 | COVERED |
| REQ | ONB-04, AGENT-04/06/07, UX-02 | 04-01, 04-05 | COVERED |
| REQ | PRIV-02/03/04/05, SAFE-01, SEC-02 | 04-02, 04-04 | COVERED |
| REQ | ROUTE-01/02, AGENT-01/02/03/05, OBS-01 | 04-03, 04-05 | COVERED |
| REQ | COST-02/03, SAFE-02, CTX-03 | 04-04, 04-05 | COVERED |
| REQ | TEST-01, SEC-01 | All plans | COVERED |
| STATE | Non-sensitive profile persistence and credential-independent reset/delete | 04-01 | COVERED |
| STATE | Accepted role teams and project initialization recommendation | 04-01 | COVERED |
| STATE | Memorable identities, optional humor, quiet/professional mode | 04-01, 04-05 | COVERED |
| STATE | Explainable decaying reputation, auditable and reversible routing | 04-03 | COVERED |
| STATE | Sovereignty hard principle, preflight, redacted preview, local-only mode | 04-02 | COVERED |
| STATE | Approval-by-default, cost visibility, emergency stop, structured telemetry | 04-04, 04-05 | COVERED |
| RESEARCH | Phase 2 provider metadata and Phase 3 bounded/redacted local event patterns | 04-02 through 04-05 | COVERED |

## Continuous security gates

Every plan carries a STRIDE threat register, least-privilege enforcement actions, privacy-negative tests, secret/redaction assertions, bounded persistence, and exact automated verification. The phase-wide gate is `npm run lint && npm test && npm run package`; each plan also has focused `node --test` name-pattern checks. The plans do not install dependencies, touch `~/.near-credentials`, or alter Phase 5 release artifacts.
