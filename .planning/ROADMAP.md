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

## Milestone 2: A working core and a native NEAR agent runner

Started 2026-10-26 after the delivery audit (`.planning/AUDIT-2026-10-26.md`) found that phases 1-6 were mostly unreachable, faked, or built against API contracts that do not exist. Goal: every advertised capability works end to end on NEAR AI, Open-GSD runs on a clean-room agent harness inside the extension (no proprietary runtime), and private TEE models are the default.

Ground rules for this milestone:
- A plan is complete only when its behavior is reachable from the UI or a command and proven by a test that drives the real path. Source-text tests, fake processes speaking invented protocols, and tests that seed state production never creates do not count as evidence.
- Every external contract (NEAR endpoints, headers, catalog fields, Open-GSD file formats) is verified against the live service or installed files before code depends on it.
- The harness is a clean-room implementation built from public behavior descriptions; no Claude Code or Codex source is copied or bundled.

### Phase 7: Honest, working baseline

Make the shipped product truthful and functional before building on it. Fix Open-GSD detection (read installed VERSION files, not `npm list`). Load actual cost from `POST /v1/billing/costs` keyed by the `inference-id` header, show estimates in the sidebar, and request streamed usage. Label every model's privacy from NEAR's catalog (TEE-attested vs forwarded) and show "TEE verified" only from NEAR's attestation/signature endpoints. Put privacy preflight, the action policy, spend limits, and an emergency stop on every outbound chat path, with a TEE-only sovereignty mode. Add profile removal, sidebar artifact links, history, and next-action buttons. Remove dead options (NEAR account auth mode, staking/wallet entry points) and hide Tools features until Phase 11 makes them real. Correct README and SECURITY.md, require the sidebar assets in the release check, and replace source-text tests with behavior tests that drive `initializeChat` and the participant.

**Requirements:** FIX-01..08, PRIV-01, PRIV-02, PRIV-03, PRIV-05, COST-01, COST-02, COST-03, SAFE-01, GSD-02, CHAT-04, AUTH-01, SEC-03, TEST-02

**Status:** Complete 2026-10-26 (`phases/07-honest-working-baseline/07-01-SUMMARY.md`).

### Phase 8: Agent harness core

Build the runner's engine: a streaming tool-calling loop over NEAR's OpenAI-compatible `/v1/chat/completions` (verified on 2026-10-26 for parallel calls, round trips, and streamed deltas on GLM 5.3, GLM 5.3 Flash, Kimi K3/K2.6, Qwen 3.5, DeepSeek V3.2/V4.1 Flash) with retries, cancellation, turn limits, and per-turn cost. Implement the core tools (Read, Write, Edit, Glob, Grep, Bash with persistent sessions and background jobs, TodoWrite) with workspace containment, a permission engine driven by `nearAi.actionPolicy` plus allow/deny rules, approval cards with diffs and command previews, file checkpoints with one-click revert, and audit events. Add a local OpenAI-compatible provider kind so local runtimes use the same harness.

**Requirements:** HARN-01..08, SAFE-01, SAFE-02, MODEL-02, MODEL-03

### Phase 9: Open-GSD on the runner

Install Open-GSD's Claude runtime into extension-owned storage (never the user's `~/.claude`) and run it natively: load skills, commands, agents, and workflows; expand `$ARGUMENTS` and `@` includes; provide the Skill and SlashCommand tools; turn AskUserQuestion into interactive cards in the sidebar and buttons in `@nearai`; run `gsd-tools.cjs` with VS Code's bundled Node. Every installed GSD skill becomes discoverable with arguments. Progress, status line, and next actions come from real run events and STATE.md.

**Requirements:** RUN-01..06, GSD-01, GSD-03, GSD-04, GSD-05, CHAT-02, CHAT-03, CHAT-05

### Phase 10: Sub-agents, background work, context, and sessions

Implement the Agent/Task tool from GSD agent definitions (system prompt, tool allowlist, model tier mapped to NEAR models: deep = Kimi K3, default = GLM 5.3, fast = GLM 5.3 Flash), parallel and background agents with limits and notifications, and real agent events feeding the fleet view. Add context management (budget tracking, tool-output truncation, summarization-based compaction), continuity thresholds with automatic handoff and restore, durable local session transcripts with resume, WebFetch behind approval, and an assessment of the Workflow tool and MCP clients that GSD workflows reference.

**Requirements:** HARN-09..12, AGENT-01, AGENT-02, AGENT-03, AGENT-04, CTX-01..04, CHAT-04, OBS-01

### Phase 11: Teams, multimodal, generation, and memory on the runner

Rebuild the advanced features on the runner so they do real work: the onboarding team questionnaire creates an accepted project team (ONB-04); teams can be created, edited, and invoked as runner sub-agents; attachments are transcribed (Whisper) or understood (vision models) through NEAR; image generation uses FLUX via the real catalog shape; runs write facts to context memory and agents receive bounded slices; reputation updates from real outcomes.

**Requirements:** ONB-04, TEAM-01..04, MULTI-01..03, GEN-01, GEN-02, MEM-01..06, ROUTE-01, ROUTE-02, AGENT-05..07

### Phase 12: End-to-end verification, model selection, and release

Run the extension in a real VS Code extension host with automated UI tests, plus opt-in live tests against NEAR (a full GSD new-project, plan, and execute run on a sample repository). Evaluate GLM 5.3, Kimi K3, and DeepSeek V4.1 Flash on fixed coding tasks to confirm defaults. Verify NEAR's per-response attestation (`/v1/attestation/report`, `/v1/signature/{chat_id}`) so "TEE verified" reflects a checked signature rather than catalog metadata. Security review, accurate SECURITY.md and listing with real screenshots, then publish.

**Requirements:** TEST-01, TEST-03, SEC-01, SEC-02, SEC-03, PKG-01, PKG-02

### Deferred

NEAR account sign-in (AUTH-02) and wallet, staking, and entitlement (AUTH-04, COST-05, STAKE-01..03) wait for a documented NEAR AI contract; their entry points are removed in Phase 7 rather than shipped as stubs.

## Next action

Phase 8: plan with `/gsd-plan-phase 8`.
