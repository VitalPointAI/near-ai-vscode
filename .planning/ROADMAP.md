# Roadmap

### Phase 1: Extension foundation, onboarding, and GSD synchronization

Create the VS Code extension scaffold, development/build/test pipeline, settings model, SecretStorage integration, visual first-project GSD onboarding flow with project-shaping questions and recommended agent-team setup, and an installable VSIX path. Add startup and daily Open-GSD stable-release checks, global runtime installation/update, project synchronization, context-monitor verification, resumable handoffs, privacy preflight and sovereignty controls, progress reporting, and failure recovery.

### Phase 2: NEAR AI client, model catalog, and cost telemetry

Implement the typed provider boundary for NEAR AI and local OpenAI-compatible runtimes, with explicit provider selection, project-scoped NEAR AI organization/key profiles, streaming, model/pricing discovery where available, request metadata, usage/cost estimation, actual-cost reconciliation, organization/project cost attribution, cancellation, retries, verification status, and no-silent-cloud-fallback behavior.

### Phase 3: Chat workspace, motion, activity, and Open-GSD command bridge

Build the chat UI and conversation state, expose Open-GSD commands and project artifacts, stream command progress, and link responses to workspace files and planning state. Add a compact NEAR logo animation that communicates reasoning/thinking, streaming, waiting for approval, completion, and failure without implying hidden chain-of-thought disclosure; respect reduced-motion preferences and provide accessible text/status semantics. Include verbose progress cards, interactive prompts, activity history, live session summaries, and a persistent info line beneath chat showing GSD project/phase/plan progress, execution state, agents, and cost context modeled on this chat experience.

### Phase 4: Agents, routing, approvals, and analytics

Implement sub-agent generation and lifecycle controls, persistent/resurrectable agent profiles, memorable agent identities with configurable light-humor progress updates, explainable reputation-aware role routing, privacy preflight and data-sovereignty enforcement, approval previews, tool permission enforcement, budgets, emergency stop, audit events, and resumable execution. Add a live agent-fleet view, event timeline, per-agent drill-down, persistent local analytics, organization/project cost attribution, reputation evidence, cost/model/latency summaries, filtering, and export.

**Plans:** 5/5 plans executed

Plans:
- [x] 04-01-PLAN.md — profiles, identities, project initialization, and accepted role teams
- [x] 04-02-PLAN.md — privacy preflight, sovereignty policy, local-only enforcement, and negative tests
- [x] 04-03-PLAN.md — explainable reputation-aware routing and agent orchestration
- [x] 04-04-PLAN.md — approval previews, budgets, emergency stop, audit, and resumable execution
- [x] 04-05-PLAN.md — live fleet, timeline, drill-down, durable analytics, filtering, and export

### Phase 6: Team studio and multimodal agent skills

Add a developer-friendly reusable agent-team builder inspired by role-based agent platforms: users can compose named teams, define member roles, skills, tools, model routes, personalities, tone/style, autonomy, approvals, and budgets, then save, version, import/export, and invoke those teams for selected projects. Add private per-agent memory and collective team memory backed by an inspectable context graph with scoped slices, provenance, confidence, decay, contradiction/tension handling, and an interactive graph/table explorer. Add secure multimodal project intake for image, video, audio, document, and structured-data attachments, modality-aware orchestration, provenance and derived-artifact tracking, and first-class image/video generation skills routed only to compatible models with privacy, cost, budget, cancellation, and approval enforcement.

**Requirements:** TEAM-01, TEAM-02, TEAM-03, TEAM-04, MULTI-01, MULTI-02, MULTI-03, GEN-01, GEN-02, MEM-01, MEM-02, MEM-03, MEM-04, MEM-05, MEM-06

**Plans:** 11/11 plans executed (10 executed, 1 gap-closure plan)

Plans:
- [x] 06-06-PLAN.md
- [x] 06-07-PLAN.md
- [x] 06-08-PLAN.md
- [x] 06-09-PLAN.md
- [x] 06-10-PLAN.md — accessible interactive context graph/table explorer and exact approval-bound memory actions
- [x] 06-11-PLAN.md — repair executable webview assembly and runtime-prove memory and graph interactions
- [x] 06-01-PLAN.md — reusable named team studio, bounded member contracts, versioning, import/export, and project invocation
- [x] 06-02-PLAN.md — capability-aware model routing, compatibility checks, and reputation-aware selection
- [x] 06-03-PLAN.md — secure multimodal intake, privacy enforcement, derived artifacts, and provenance lineage
- [x] 06-04-PLAN.md — capability-bound image/video generation, cost/usage, cancellation, approval, and publication controls
- [x] 06-05-PLAN.md — private and collective scoped context graphs, memory slices, revision controls, and accessible graph/table views

### Phase 5: Verification, hardening, account entitlements, and release

Exercise end-to-end flows, close the scoped NEAR AI credential/profile and organization/project attribution boundary, and add an explicitly authorized NEAR wallet/entitlement flow for verified staking, credit-balance, and stake-status visibility. Run continuous security/privacy gates, perform credential and backdoor-oriented review, verify failure recovery and accessibility, complete packaging and Marketplace documentation, publish the trust/security report, and produce a release candidate VSIX. Staking remains separate from API-key profiles and never accesses local NEAR credential files.

**Requirements:** AUTH-01, AUTH-03, AUTH-04, MODEL-03, MODEL-04, COST-03, COST-04, COST-05, STAKE-01, STAKE-02, STAKE-03, CHAT-04, AGENT-03, OBS-01, TEST-01, SEC-01, SEC-02, PKG-01, PKG-02, SEC-03

**Plans:** 5/5 plans executed

Plans:
- [x] 05-01-PLAN.md — scoped SecretStorage credentials, named profiles, migration, validation, and explicit switching
- [x] 05-02-PLAN.md — organization/project cost attribution through activity, audit, analytics, filters, and export
- [x] 05-03-PLAN.md — external wallet authorization, verified staking/entitlement status, exact transaction previews, and safe history
- [x] 05-04-PLAN.md — immutable persisted ActivityStore attribution on reload with legacy-unknown security regressions
- [x] 05-05-PLAN.md — trust/security report, Marketplace listing, dependency evidence, and clean VSIX packaging verification

## Next action

Phase 6 Plans 06-01 through 06-11 are implemented and summarized. The remaining work is final human Marketplace/extension-host review.
