---
gsd_state_version: "1.0"
milestone: v0.5.0
milestone_name: Trusted-source knowledge base
status: planning
last_updated: "2026-10-28T15:04:47.993Z"
last_activity: 2026-10-28
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Current position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-10-28 — Milestone v0.5.0 started

## Decisions

- Support NEAR AI API-key authentication. NEAR account sign-in is deferred until NEAR AI documents a token-exchange contract (2026-10-26).
- *(Superseded 2026-10-26)* ~~Automatically install the stable Open-GSD runtime on first activation~~. Open-GSD is installed only when the user runs a GSD workflow in a project set up with the extension and it is missing; the extension activates only in workspaces containing `.planning/.near-ai/`.
- Require approval for risky actions by default.
- Treat onboarding, chat/GSD, model/routing controls, cost visibility, and agent controls as the initial product slice.
- Preserve Open-GSD as the workflow engine and make its artifacts/state visible rather than replacing them.
- Default the developer experience to transparent, fairly verbose progress reporting modeled on this chat, with concise mode as an opt-in later setting.
- Track structured agent/model/tool lifecycle events for live counts, activity history, cost analytics, and resumable conversations without storing private prompts by default.
- Personalize sub-agent presentation with memorable names and occasional optional humor, while keeping exact operational state authoritative and providing a quiet/professional mode.
- Future routing will use explainable, decaying, role-specific agent reputation rather than opaque online weight updates; every score change must be auditable and reversible.
- Agent profiles will persist only non-sensitive identity, capability, routing, and reputation parameters; profiles must support rehydration, version migration, reset, export, and deletion independently of credentials.
- Project initialization will recommend a role-based agent team after concise discovery questions, require user acceptance/customization before execution, and persist the accepted team configuration as project planning state.
- Sovereignty is a hard product principle: outbound context requires privacy preflight, redacted preview, explicit policy evaluation, local-only exclusions, and an auditable non-sensitive decision record.
- Provider architecture must support local OpenAI-compatible runtimes as first-class options; local-only mode blocks cloud inference and network actions unless explicitly overridden, and provider fallback is never silent.
- Release quality includes a complete Marketplace presentation that explains the product and its privacy boundaries accurately rather than relying on the README alone.
- Security is a continuous GSD gate: security-sensitive plans require threat modeling, least privilege, negative tests, redaction/secret checks, dependency review, and evidence; release adds a public-facing trust/security report.
- [Phase 02]: Preserved streamChat compatibility while adding metadata-rich streamChatEvents lifecycle events.
- [Phase 02]: Kept unavailable model pricing explicit rather than fabricating estimated costs.
- [Phase 03]: Kept provider authentication and NearAiClient calls in the extension host; the webview receives only typed display messages and model options.
- [Phase 03]: Used lifecycle streaming events and request-local cancellation guards so cancellation is explicit and overlapping requests cannot corrupt UI state.
- [Phase 03]: Added explicit accessible NEAR motion states with reduced-motion fallback.
- [Phase 03]: Added validated searchable Open-GSD command discovery and project-aware continuation prompts.
- [Phase 03]: Added a typed cancellable Open-GSD Codex command runner with workspace-scoped argv and redacted progress events.
- [Phase 03]: Exposed planning artifact links only for discovered .planning files under the workspace root.
- [Phase 03]: Persist operational-only activity/session summaries in a versioned bounded local ledger with atomic replacement and no raw prompts by default.
- [Phase 03]: Reopen restores non-executable session context and continuation without replaying stored commands.
- [Phase 03]: Added session-bound typed structured prompts with real Open-GSD stdin response delivery.
- [Phase 03]: Normalized redacted lifecycle cards feed both accessible live UI and durable activity history.
- [Phase 03]: Validated and preserved safe Open-GSD runtime phase, tool/action, model, agent, attempt/retry, and approval metadata through live cards and durable activity.
- [Phase 03]: Kept one panel-owned ActivityStore as the command lifecycle boundary and awaited terminal writes before history refresh.
- [Phase 3]: Exposed the uniquely resolved current GSD phase directory as a typed, manifest-approved artifact action with realpath containment.
- [Phase 04]: Profile IDs remain authoritative while memorable names are display-only and collision-handled.
- [Phase 04]: Profile and team artifacts use allowlists and reject credentials, prompts, raw context, commands, and unrestricted paths.
- [Phase 04]: Project initialization requires acceptance or customization before execution and persists only operational team state.
- [Phase 04]: Unknown classifications block by default; safe scoped requests can pass without a sensitive classification.
- [Phase 04]: Local-only mode blocks cloud inference and network boundaries; exact-scope one-time overrides remain auditable and cannot bypass action approval or emergency stop.
- [Phase 04]: Audit records retain classifications and redacted previews, never raw context or credential literals.
- [Phase 4]: Reputation is role-specific, bounded, decaying, explainable, resettable, opt-out capable, and exploration-aware rather than a permanent exclusion mechanism.
- [Phase 4]: Restarted running/waiting agents rehydrate as paused resumable state and require a fresh policy-gated resume.
- [Phase 04]: Risky capabilities require exact-scope, time-limited approval previews with redacted provider/data/cost context.
- [Phase 04]: Layered budgets and emergency stop block new work while preserving safe terminal bookkeeping and estimated-versus-actual cost reporting.
- [Phase 04]: Audit and resume records are bounded, redacted, non-executable, and require fresh policy/approval after restart.
- [Phase 04]: NEAR AI credentials must be scoped to an explicit project and organization profile in SecretStorage; no key may cross workspace/profile boundaries implicitly, and cost telemetry must retain only non-sensitive organization/project attribution.
- [Phase 05]: Wallet/staking is a separate, explicit-authorization boundary from API-key profiles. Use verified network/validator/account data, show exact transaction previews and entitlement status, and never access or mutate `~/.near-credentials`.
- [Phase 06]: Reusable teams are versioned non-sensitive compositions, not credential containers; member capabilities are allowlisted and must be checked against provider/model capabilities before invocation.
- [Phase 06]: Multimodal inputs and generated media inherit privacy preflight, local-only mode, approval, budget, attribution, provenance, cancellation, and redaction rules; raw media does not enter analytics by default.
- [Phase 06]: Agent-private and team-collective memory are separate scoped namespaces over an inspectable context graph. Retrieval is a bounded, provenance-aware slice; graph facts retain confidence, freshness, conflicts/tensions, and correction history rather than silently overwriting knowledge.
- [Phase 06]: Graph visualization is optional presentation over host-controlled allowlisted DTOs; Neo4j or another graph backend is not assumed until persistence, privacy, offline, and dependency tradeoffs are verified.
- [Phase 4]: Analytics are recomputed in the extension host from bounded ActivityStore, AuditStore, and ReputationStore records; the webview never supplies authoritative counts.
- [Phase 4]: Quiet mode changes labels only and never suppresses authoritative operational facts.
- [Phase 05]: SecretStorage keys use only hashed project scope, stable profile ID, version, and credential kind; raw paths, names, and credentials never enter keys.
- [Phase 05]: Dispatch requires an explicit selected profile with successful provider validation; stale or unvalidated profiles cannot load models or send chat requests.
- [Phase 05]: Legacy global credentials are migration-only inputs and never a provider dispatch fallback.
- [Phase 05]: Capture immutable host-derived organization/profile and workspace-project snapshots at request start so later profile switches cannot relabel history.
- [Phase 05]: Aggregate estimate and actual provider usage independently by request ID, preserving unavailable values and avoiding duplicate audit cost.
- [Phase 05]: Recompute attribution-aware analytics in the host and expose only bounded allowlisted filters, drill-down DTOs, and safe exports.
- [Phase 05]: Persisted ActivityStore events must clone the normalized owning session attribution during reload; event-level persisted ownership is never trusted.
- [Phase 05]: Release verification derives the VSIX name from package metadata, checks required assets/runtime modules, and rejects development entries.
- [Phase 05]: Marketplace and security claims remain qualified to provider-reported TEE state, unavailable wallet configuration, and prepared-only account sign-in.
- [Phase 05]: No runtime dependency was added; production dependency tree remains empty and dev-only tooling is documented separately.
- [Phase 06]: Reusable teams are global, non-sensitive compositions; project invocation stores an immutable member snapshot and never carries credentials, prompts, raw context, commands, or unrestricted paths.
- [Phase 06]: A reusable team must be explicitly bound to an accepted project before orchestration can use it; later global edits do not rewrite the binding.
- [Phase 06]: Unknown, oversized, malformed, sensitive, or capability-expanding import fields fail closed rather than being silently coerced.
- [Phase 6]: Provider/model capability is proven only by current, declared, freshness-bound metadata; model names never imply modality or generation support.
- [Phase 6]: Capability compatibility is a hard eligibility stage before role-specific reputation and bounded exploration.
- [Phase 6]: Unknown, stale, malformed, contradictory, unready, unpriced, or privacy-incompatible routes fail closed with explicit reasons and no silent fallback.
- [Phase 06]: Multimodal attachments are staged locally with bounded safe metadata and opaque host-owned raw handles; raw media is excluded from records, prompts, analytics, exports, and graph memory by default.
- [Phase 06]: Unknown, unsupported, oversized, forged, symlinked, traversal, and privacy-incompatible inputs fail closed; cloud transfer and raw-content use require explicit approval.
- [Phase 06]: Derived artifacts retain bounded source-output lineage, inherited privacy/provenance, cancellation, budget, restart, and recovery state.
- [Phase 06]: Generation is capability-bound with exact provider-operation metadata; NEAR exposes only documented image endpoints and no invented video endpoint.
- [Phase 06]: Generation and publication require separate exact approvals, bounded workspace storage, provenance, attribution, and redacted observability.
- [Phase 06]: Keep private-agent, collective-team, project, and shared memory in independently keyed scopes with no implicit scope widening.
- [Phase 06]: Persist bounded typed provenance-bearing facts and relationships; reject credentials, raw private content/media, unrestricted paths, and executable instructions.
- [Phase 06]: Require explicit provider-boundary approval and matching fingerprints for memory export or cross-provider use; local-only requests fail closed.
- [Phase 06]: Persist mediaGeneration and mediaPublication only through strict bounded team tool and approval allowlists.
- [Phase 06]: Validate exact host-created binding fingerprints on project reload and before orchestration routing/deployment.
- [Phase 06]: Reject invalid or authority-expanding persisted member snapshots rather than truncating them into usable contracts.
- [Phase 06]: Webview sends bounded stable-ID intent only; host derives project scope, binding, provider/model, capabilities, privacy, and cost.
- [Phase 06]: Exact persisted team/version/project bindings are required before invocation; forged or mismatched scope fails closed.
- [Phase 06]: Production multimodal chat now uses strict opaque attachment protocol, host-derived current capability routing, exact approval, cancellation, recovery, and bounded lineage status.
- [Phase 06]: Provider-boundary execution is fail-closed: absent documented adapters reject cloud/TEE routes rather than silently falling back to local output.
- [Phase 06]: Require host-created exact memory approval descriptors with bounded previews, fingerprints, expiry, one-shot consumption, and fail-closed mismatch handling.
- [Phase 06]: Expose graph inspection as bounded host DTOs with accessible interactive graph, semantic table, and keyboard-navigable outline fallback.
- [Phase 06]: Keep graph rendering dependency-free; sanitize host graph DTOs before webview delivery and consume memory approval fingerprints once.
- [Phase 06]: Plan 06-11 uses callback-safe generated script assembly and dependency-free runtime webview tests.

- [2026-10-26] Milestone 2: Open-GSD runs on a clean-room agent harness inside the extension over NEAR AI's OpenAI-compatible API; no Codex or Claude Code runtime is invoked or bundled.
- [2026-10-26] Default model is `z-ai/glm-5.3` (TEE-attested via Tinfoil, 1M context, fastest tool calling in the 2026-10-26 probe). Runner tiers: deep = Kimi K3, default = GLM 5.3, fast = GLM 5.3 Flash. Non-TEE models stay selectable and are labelled as forwarded.
- [2026-10-26] NEAR's Anthropic-compatible `/v1/messages` serves Anthropic-backed models only, and those are forwarded to Anthropic; it is not used.
- [2026-10-26] A plan is complete only when its behavior is reachable from the UI and proven by a test of the real path (see `.planning/AUDIT-2026-10-26.md`).

## Risks to resolve

- Confirm exact NEAR sign-in and token exchange APIs available to a desktop VS Code extension.
- Define the supported Open-GSD integration mechanism and process boundary.
- Determine which usage/cost signals are available synchronously per request versus through reporting APIs.
- Design a secure approval boundary for shell, filesystem, network, and git operations.
- Confirm the exact Open-GSD installer flags for the VS Code-hosted runtime before enabling production auto-update; the current adapter uses the documented package/channel and Codex global/local scope convention.
- Confirm the host's native context-metrics bridge; Open-GSD's context monitor is authoritative where its lifecycle hooks are available, with extension-level checkpoint fallback required for hosts that do not expose those hooks.

## Verification status

- Passed: npm registry install, `package-lock.json` generation, strict TypeScript lint, compile, 3 unit test files, package manifest validation, startup activation declaration, workspace structure, and VSIX packaging.
- Pending: extension-host smoke test and runtime validation of the Open-GSD updater/context-monitor integration.
- Passed for Phase 2 Plans 02-01 and 02-02: client metadata, usage/cost estimation and reconciliation, retry/cancellation behavior, strict TypeScript lint, full unit suite, and VSIX packaging.
- Process correction: later prototype work briefly preceded formal phase-plan execution; the missing plans are now recorded and future work follows plan → execute → verify → summarize gates.
- Phase 3 Plan 03-01 automated verification passed; interactive VS Code extension-host/live-provider smoke verification remains human-needed.
- Phase 3 Plan 03-08 automated verification passed: current-phase directory discovery, typed artifact opening, containment regressions, full tests, and VSIX packaging.
- Phase 4 Plan 04-05 automated verification passed: live fleet projection, durable timeline/analytics filters, drill-down/export redaction, chat protocol controls, full tests, lint, and VSIX packaging.
- Git commits remain unavailable in this mounted workspace because `.git` is not a usable repository; Plan 04-05 records `commits: 0` honestly.

## Quick tasks completed

| Task | Result |
| --- | --- |
| Initial project setup | Complete |

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 02 P01 | 1h 5m | 1 tasks | 2 files |
| Phase 02 P02 | 20m | 1 tasks | 2 files |
| Phase 03 P01 | 35m | 1 tasks | 3 files |
| Phase 03 P02 | 45m | 1 tasks | 9 files |
| Phase 03 P03 | 35m | 2 tasks | 7 files |
| Phase 03 P04 | 1h 20m | 2 tasks | 7 files |
| Phase 03 P05 | 45m | 2 tasks | 8 files |
| Phase 03 P06 | 35m | 2 tasks | 9 files |
| Phase 03 P07 | 15m | 2 tasks | 3 files |
| Phase 3 P8 | 45m | 2 tasks | 4 files |
| Phase 04 P01 | 25m | 2 tasks | 7 files |
| Phase 04 P02 | 30m | 2 tasks | 5 files |
| Phase 4 P3 | approximately 1h | 2 tasks | 5 files |
| Phase 04 P04 | approximately 1h | 2 tasks | 7 files |
| Phase 4 P5 | approximately 1h 20m | 2 tasks | 9 files |
| Phase 05 P01 | approximately 20m | 3 tasks | 13 files |
| Phase 05 P02 | 1h 15m | 3 tasks | 17 files |
| Phase 05 P03 | approximately 2h 30m | 3 tasks | 11 files |
| Phase 05 P04 | 20 minutes | 2 tasks | 2 files |
| Phase 05 P05 | 10m | 2 tasks | 9 files |
| Phase 06 P01 | 28m | 3 tasks | 10 files |
| Phase 6 P2 | 1h 10m | 3 tasks | 10 files |
| Phase 06 P03 | 18m | 3 tasks | 11 files |
| Phase 06 P04 | 0 | 3 tasks | 14 files |
| Phase 06 P05 | 1h 15m | 3 tasks | 12 files |
| Phase 06 P06 | 23m | 2 tasks | 6 files |
| Phase 06 P07 | 35 | 2 tasks | 6 files |
| Phase 06 P08 | 39m | 2 tasks | 6 files |
| Phase 06 P09 | 1h 10m | 2 tasks | 8 files |
| Phase 06 P10 | 20m | 2 tasks | 4 files |
| Phase 06 P11 | 2h | 3 tasks | 2 files |

## Session

**Last session:** 2026-10-26T05:43:55.408Z
**Stopped at:** Completed 06-11-PLAN.md
**Resume file:** None

- 2026-10-26: Live eval confirmed GLM 5.3 as the default chat model. All three candidates passed; GLM 5.3 was fastest (41 s vs 685 s for Kimi K3) and private. DeepSeek V4.1 Flash was cheapest but forwarded, so it is not a private default.
