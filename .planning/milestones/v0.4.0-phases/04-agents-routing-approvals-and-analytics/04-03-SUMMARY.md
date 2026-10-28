---
phase: 04-agents-routing-approvals-and-analytics
plan: 03
subsystem: routing-and-orchestration
tags: [routing, reputation, agents, lifecycle, privacy, persistence, testing]
requires:
  - phase: 04-agents-routing-approvals-and-analytics
    plan: 01
    provides: non-sensitive profiles, memorable identities, accepted role teams, and profile resurrection primitives
  - phase: 04-agents-routing-approvals-and-analytics
    plan: 02
    provides: PolicyGate, privacy preflight, sovereignty enforcement, and redacted decision boundaries
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: bounded lifecycle metadata and durable operational event patterns
provides:
  - Explainable, role-specific, decaying reputation evidence and route selection
  - Exploration allowance, reset, opt-out, evidence deduplication, and bounded persistence
  - Policy-gated sub-agent deploy, inspect, pause, resume, cancel, limits, and outcome lifecycle
  - Safe restart rehydration of running/waiting agents as paused resumable state
affects: [04-04, 04-05]
actuals:
  tokens: 9419
  tasks: 2
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
tech-stack:
  added: []
  patterns: [role-specific decaying evidence, explainable constrained selection, deterministic exploration, policy-gated lifecycle, bounded restart ledger]
key-files:
  created:
    - src/domain/routing.ts
    - src/services/reputation.ts
    - src/services/agentOrchestrator.ts
    - src/test/reputation.test.ts
    - src/test/agentOrchestrator.test.ts
  modified: []
key-decisions:
  - "Reputation is calculated from bounded, role-specific evidence with explicit component weights and time decay; it is never a permanent exclusion mechanism."
  - "Exploration periodically selects the lowest-scoring eligible candidate so successful routing cannot self-reinforce into a closed loop."
  - "Evidence IDs are deterministic per agent outcome and duplicate evidence is ignored; reset and opt-out remain explicit reversible controls."
  - "Restarted running or waiting agents become paused resumable state and require a fresh policy-gated resume before execution can continue."
  - "Git commits were unavailable because the mounted .git path is not a usable repository; no hashes are fabricated."
requirements-completed: [ROUTE-01, ROUTE-02, AGENT-01, AGENT-02, AGENT-04, AGENT-05, AGENT-06, OBS-01]
status: complete
---

# Phase 4 Plan 3: Explainable Routing and Agent Orchestration Summary

Explainable role routing and a bounded, policy-aware sub-agent lifecycle now connect accepted teams and resurrected profiles to decaying reputation evidence, safe dispatch metadata, and restart-resumable orchestration.

## Accomplishments

- Added routing contracts for role requests, candidates, reputation evidence/scores, decay configuration, route explanations, lifecycle events, and fleet limits.
- Implemented `ReputationStore` with role-specific verified outcomes, rework/reliability/latency/cost/user-feedback components, half-life decay, bounded persistence, reset, opt-out, and duplicate evidence protection.
- Implemented constrained route selection using accepted-team membership, profile role/capabilities, provider/locality/privacy constraints, score thresholds, and explicit human-readable explanations.
- Added deterministic exploration allowance to keep lower-scoring eligible profiles in rotation and prevent self-reinforcing routing loops.
- Implemented `AgentOrchestrator` deploy/inspect/pause/resume/cancel/transition controls, concurrency/spend/duration limits, fleet snapshots, normalized redacted lifecycle events, and policy-gated dispatch/resume.
- Added restart rehydration that converts persisted running/waiting state to paused resumable state; it cannot execute until a fresh policy-gated resume.
- Kept profile IDs authoritative and used profile/team state without persisting prompts, credentials, unrestricted paths, or executable command data.

## Task Commits

Git commits were unavailable. The mounted workspace has an empty/read-only `.git` directory and Git reports that it is not a repository. No commit hashes are fabricated.

1. **Task 1: Route one role to one resurrected profile with explainable decaying reputation** — no commit (repository unavailable)
2. **Task 2: Expand orchestrator lifecycle controls and evidence-backed fleet events** — no commit (repository unavailable)
3. **Plan metadata** — no commit (repository unavailable)

## Verification

- `npm run lint` — passed.
- Focused reputation/orchestrator command — passed: 20 test files, 20 passed, 0 failed, 0 skipped/todo.
- `npm test` — passed: 20 test files, 20 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Stub scan across all five plan-created files — no TODO/FIXME/placeholder/empty-rendering stubs found.
- Negative coverage includes invalid transitions, concurrency limits, route bypasses, duplicate evidence, profile role isolation, secret-shaped metadata, raw prompt markers, and restart rehydration.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Correctness] Made outcome evidence deduplicate across repeated terminal notifications**
- **Found during:** Task 2 focused verification.
- **Issue:** Evidence IDs initially included mutable update timestamps, allowing the same agent outcome to be recorded more than once when a stale lifecycle object was submitted again.
- **Fix:** Derive outcome, latency, and feedback evidence IDs from the stable agent run ID and evidence kind; `ReputationStore` ignores repeated IDs.
- **Files modified:** `src/services/agentOrchestrator.ts`
- **Verification:** Duplicate-evidence lifecycle test and full suite pass.
- **Committed in:** No commit; repository unavailable.

**2. [Rule 2 - Correctness/security] Added safe restart persistence and policy-gated resurrection**
- **Found during:** Plan-level must-have review.
- **Issue:** The first lifecycle slice was in-memory only and could not rehydrate running/paused state after restart.
- **Fix:** Added bounded local orchestration ledger persistence, conversion of running/waiting records to paused state on rehydrate, and a fresh policy-gated resume path.
- **Files modified:** `src/services/agentOrchestrator.ts`, `src/test/agentOrchestrator.test.ts`
- **Verification:** Restart rehydration regression, lint, full tests, and packaging pass.
- **Committed in:** No commit; repository unavailable.

No package installation, authentication gate, architectural expansion, 04-04/04-05 work, or Phase 5 work occurred.

## Threat Surface Review

- **T-04-07 elevation of privilege:** Accepted-team membership, profile role/capability checks, provider/locality/privacy constraints, explicit lifecycle transitions, and PolicyGate dispatch/resume checks are enforced.
- **T-04-08 tampering:** Evidence shape is validated, bounded, role-specific, deduplicated, decayed, resettable, and opt-out capable; explanations retain the score inputs and decay timestamp.
- **T-04-09 denial of service:** Concurrency, spend, duration, cancellation, and terminal transition limits are enforced before or during lifecycle changes.
- No new external endpoint or credential access path was introduced. `~/.near-credentials` was not accessed or modified.

## Known Stubs

None found in files created or modified by this plan.

## Issues Encountered

- Git task commits, ledger measurement, ancestry checks, and metadata commit were unavailable because the mounted `.git` path is not a usable repository. This is recorded as `commits: 0`; Git metadata was not initialized or changed.

## User Setup Required

None.

## Next Phase Readiness

04-03 is complete on disk. 04-04 can consume the orchestrator lifecycle and policy seam for approval previews, budgets, emergency stop, and audit. 04-05 can consume fleet snapshots and normalized events for live analytics. Neither plan was executed here.

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- All five plan-listed implementation/test files exist.
- `npm run lint`, focused reputation/orchestrator tests, `npm test`, and `npm run package` passed.
- Stub scan is clean.
- Git commit verification is not applicable because the workspace is not a Git repository; no commit claims are present.

---
*Phase: 04-agents-routing-approvals-and-analytics*
*Plan: 03*
*Completed: 2026-10-25*
