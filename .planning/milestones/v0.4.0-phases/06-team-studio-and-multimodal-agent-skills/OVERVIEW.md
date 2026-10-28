# Phase 6 Overview

Phase 6 adds a reusable team studio, scoped private/collective context-graph memory, and a policy-bound multimodal/generative capability layer on top of the Phase 4/5 host architecture. Named teams live independently of a project, but invocation creates an explicit project binding. Members and memory graphs remain bounded operational contracts, not prompt or credential containers. Attachments and generated artifacts use local, versioned metadata and source lineage; raw media and raw private context stay outside analytics and model context unless an explicit capability, privacy, approval, and budget decision authorizes it.

`06-AI-SPEC.md` is the phase design contract. It selects the existing typed TypeScript host orchestration approach, records official provider capability findings, defines fail-closed behavior for unknown endpoints/capabilities, and provides the evaluation rubric and negative-test matrix.

## Execution waves

1. **Wave 1 — reusable team studio:** `06-01-PLAN.md` creates the global named-team library, bounded member contracts, version/history/import/export behavior, project binding, invocation preview, and accessible chat controls.
2. **Wave 2 — capability-aware routing:** `06-02-PLAN.md` normalizes provider/model capability metadata, makes modality/skill compatibility a routing constraint, and preserves explainable reputation compatibility and team preview facts.
3. **Wave 3 — multimodal intake and lineage:** `06-03-PLAN.md` adds secure local attachment intake for image/video/audio/documents/structured data, privacy/local-only handling, derived-artifact orchestration, and source-to-output lineage.
4. **Wave 4 — guarded generation:** `06-04-PLAN.md` adds capability-bound image/video skills, provider adapters, model metadata, estimate/actual usage, cancellation, approval, budget, and publication controls, followed by full negative and packaging verification.
5. **Wave 5 — scoped context-graph memory:** `06-05-PLAN.md` adds private agent memory and collective team memory, typed graph facts/edges and tension, provenance/confidence/freshness/decay/conflict handling, bounded task slices, user revision controls, and accessible graph/table views.

## Dependency graph

```text
06-01 ─────> 06-02 ─────> 06-03 ─────> 06-04 ─────> 06-05
   │            │            │            │             │
   └────────────┴────────────┴────────────┴─────────────┴──> Phase 4/5 policy, attribution, analytics, and ledgers
```

The plans reuse `AgentProfileStore`, `ProjectInitialization`, `AgentOrchestrator`, `ReputationStore`, `PolicyGate`, `PrivacyPreflight`, `ApprovalService`, `ActivityStore`, `AuditStore`, `AnalyticsStore`, the host-only provider factory, and the strict `chatBridge` boundary. No plan installs a dependency, reads or modifies `~/.near-credentials`, invents a provider endpoint, or places raw media in prompts/analytics by default.

## Source coverage audit

| Source | Item | Covered by | Status |
|---|---|---|---|
| GOAL | Reusable named teams with bounded members, project invocation, secure multimodal intake, derived lineage, and guarded image/video generation | 06-01 through 06-04 | COVERED |
| REQ | TEAM-01 — named team CRUD, duplicate, version, archive, delete | 06-01 | COVERED |
| REQ | TEAM-02 — bounded member role/responsibility/skills/tools/routes/personality/autonomy/approval/budget contract | 06-01 | COVERED |
| REQ | TEAM-03 — preview responsibilities/routes/cost/privacy/capabilities and require explicit project binding | 06-01, 06-02 | COVERED |
| REQ | TEAM-04 — safe non-sensitive versioned import/export/rehydration | 06-01 | COVERED |
| REQ | MULTI-01 — guided image/video/audio/document/structured-data intake with type/size/preview/provenance/local-cloud handling | 06-03 | COVERED |
| REQ | MULTI-02 — modality classification, compatible routing, transformations, source/output relationships, unsupported reporting | 06-02, 06-03, 06-04 | COVERED |
| REQ | MULTI-03 — privacy preflight, local-only, redaction, approval, cost attribution, history, and no raw media by default | 06-03, 06-04 | COVERED |
| REQ | GEN-01 — first-class image/video skills with capability metadata, usage/cost, storage, lineage, cancellation, approval, publication | 06-04 | COVERED |
| REQ | GEN-02 — generation only when selected provider/model advertises it and all gates pass | 06-02, 06-04 | COVERED |
| REQ | MEM-01 — isolated versioned private agent and collective team memory namespaces without sensitive content | 06-05 | COVERED |
| REQ | MEM-02 — bounded task-specific graph slices with provenance, relevance, confidence, freshness, decay, privacy, and supplied-fact records | 06-05 | COVERED |
| REQ | MEM-03 — typed graph knowledge, actors/functions/capabilities, tension, conflict, revision, and retraction | 06-05 | COVERED |
| REQ | MEM-04 — inspect, search, filter, correct, merge, retract, export, and reset with scope labels | 06-05 | COVERED |
| REQ | MEM-05 — accessible interactive graph plus equivalent table/outline view | 06-05 | COVERED |
| REQ | MEM-06 — bounded auditable local-only-compatible memory operations | 06-05 | COVERED |
| RESEARCH | NEAR model metadata exposes modality, feature, readiness, context, and input/output/image/cache pricing fields | 06-02, 06-04 | COVERED |
| RESEARCH | NEAR documents image generation/edit and audio transcription routes, while the live catalog currently reports no audio/video input models | 06-03, 06-04 | COVERED |
| RESEARCH | OpenAI video contract is asynchronous and provider-specific; it must be adapter-declared, not inferred for NEAR | 06-04 | COVERED |
| RESEARCH | Existing OpenAI-compatible client, provider validation, estimate/actual reconciliation, and cancellation seam | 06-02 through 06-04 | COVERED |
| RESEARCH | Existing Phase 4 bounded ledgers, host-side analytics, privacy policy, approvals, budgets, and reputation routing | 06-01 through 06-04 | COVERED |
| CONTEXT | STATE Phase 06: reusable teams are versioned non-sensitive compositions, not credential containers | 06-01 | COVERED |
| CONTEXT | STATE Phase 06: member capabilities are allowlisted and checked against provider/model capabilities | 06-01, 06-02 | COVERED |
| CONTEXT | STATE Phase 06: multimodal/generated media inherits privacy, local-only, approval, budget, attribution, provenance, cancellation, and redaction rules | 06-03, 06-04 | COVERED |
| CONTEXT | STATE: host-side analytics, immutable profile/project attribution, no raw prompts by default, and no silent provider fallback | 06-02 through 06-05 | COVERED |

## Security and verification gate

Every plan contains a STRIDE register, least-privilege constraints, negative tests, redaction/media/memory-leak checks, bounded persistence, and a concrete automated command with an explicit failure direction. The phase gate is `npm run lint && npm test && npm run package`, supplemented by focused contract, routing, multimodal, generation, cancellation, approval, lineage, attribution, publication, graph semantics, scope isolation, and accessible memory-view tests. Human verification should inspect the team studio, attachment/generation cards, and graph/table memory controls against the AI-SPEC rubric after the automated gate passes.
