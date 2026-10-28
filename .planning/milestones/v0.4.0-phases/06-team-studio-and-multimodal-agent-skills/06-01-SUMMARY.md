---
phase: 06-team-studio-and-multimodal-agent-skills
plan: 01
subsystem: team-studio
tags: [teams, agent-contracts, versioning, project-binding, webview, privacy, security]
requires:
  - phase: 04-agents-routing-approvals-and-analytics
    provides: bounded agent profiles, accepted project teams, policy-gated orchestration, and atomic local ledgers
  - phase: 05-verification-hardening-and-release
    provides: scoped profile/credential boundaries and release verification
provides:
  - global reusable named-team library with bounded member contracts and immutable versions
  - archive, restore, delete, duplicate, safe import/export, and legacy normalization
  - explicit project binding with immutable version/member snapshots and preview DTOs
  - fail-closed orchestrator enforcement for bound member role, capability, tool, route, and budget contracts
  - accessible team list, preview, and exact-version binding controls through the chat webview
affects: [06-02, agent-routing, project-initialization, chat-studio]

actuals:
  tokens: 13680
  tasks: 3
  commits: 0
  # Git metadata is unusable in this mounted workspace; no commit hashes are fabricated.

tech-stack:
  added: []
  patterns:
    - allowlisted bounded team/member normalization
    - immutable version history and redacted project binding snapshots
    - host-generated preview/status DTOs over a strict webview protocol

key-files:
  created:
    - src/domain/teamStudio.ts
    - src/services/teamStudio.ts
    - src/test/teamStudio.test.ts
    - src/test/teamInvocation.test.ts
  modified:
    - src/domain/agents.ts
    - src/services/projectInitialization.ts
    - src/services/agentOrchestrator.ts
    - src/services/chatBridge.ts
    - src/services/chat.ts

key-decisions:
  - "Reusable teams are global, non-sensitive compositions; project invocation stores an immutable member snapshot and never carries credentials, prompts, raw context, commands, or unrestricted paths."
  - "Stable team/version/member IDs are authoritative; display labels and webview-submitted project fields cannot select authority."
  - "A reusable team must be explicitly bound to an accepted project before orchestration can use it; later global edits do not rewrite the binding."
  - "Unknown, oversized, malformed, sensitive, or capability-expanding import fields fail closed rather than being silently coerced."

patterns-established:
  - "TeamStudioStore persists reusable teams under injected global storage with bounded atomic replacement."
  - "Team previews expose responsibilities, routes, privacy, approvals, autonomy, and budget facts without authoritative webview inputs."

requirements-completed: [TEAM-01, TEAM-02, TEAM-03, TEAM-04, TEST-01, SEC-01, SEC-02]

coverage:
  - id: D1
    description: "Developers can create, inspect, duplicate, version, archive, restore, delete, export, import, and reload reusable named teams."
    requirement: TEAM-01
    verification:
      - kind: unit
        ref: src/test/teamStudio.test.ts#team studio creates immutable versions, duplicates safely, and archives/restores/deletes explicitly
        status: pass
      - kind: unit
        ref: src/test/teamStudio.test.ts#team export/import rejects sensitive or unknown authority and preserves bounded history
        status: pass
    human_judgment: false
  - id: D2
    description: "Saved members use bounded role, responsibility, skill, tool, route, personality, autonomy, approval, and budget contracts."
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: src/test/teamStudio.test.ts#team studio saves a global named team, produces a host preview, and binds an exact version
        status: pass
      - kind: unit
        ref: src/test/teamStudio.test.ts#team export/import rejects sensitive or unknown authority and preserves bounded history
        status: pass
    human_judgment: false
  - id: D3
    description: "An accepted project can bind an exact reusable version and the existing orchestrator enforces the selected member policy before deployment."
    requirement: TEAM-03
    verification:
      - kind: unit
        ref: src/test/teamInvocation.test.ts#explicit project binding rehydrates the exact selected team version and survives global edits
        status: pass
      - kind: unit
        ref: src/test/teamInvocation.test.ts#orchestration is fail-closed before binding and preserves the selected member policy after binding
        status: pass
    human_judgment: false
  - id: D4
    description: "Chat exposes keyboard-accessible team list, preview, privacy/cost facts, and exact-version binding controls while the host recomputes authority."
    requirement: TEAM-04
    verification:
      - kind: unit
        ref: src/test/teamInvocation.test.ts#team chat controls accept stable IDs only and reject authoritative or sensitive webview fields
        status: pass
      - kind: other
        ref: npm run lint && npm test && npm run package
        status: pass
    human_judgment: true
    rationale: "Automated checks prove the strict protocol and generated markup compile; interactive VS Code keyboard and screen-reader review remains a human judgment."
  - id: D5
    description: "Team import/export and project binding preserve security boundaries and never store credential, wallet, prompt, raw-context, command, or unrestricted-path material."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: src/test/teamStudio.test.ts#team migration keeps safe supported records but does not grant new authority
        status: pass
      - kind: unit
        ref: src/test/teamStudio.test.ts#team export/import rejects sensitive or unknown authority and preserves bounded history
        status: pass
    human_judgment: false

duration: 28m
completed: 2026-10-26
status: complete
commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
---

# Phase 6 Plan 1: Team Studio and Project Invocation Summary

**Versioned global team studio with bounded member contracts, safe import/export, immutable project bindings, and policy-preserving chat controls.**

## Performance

- **Duration:** 28 minutes
- **Started:** 2026-10-26T02:43:00Z
- **Completed:** 2026-10-26T03:11:40Z
- **Tasks:** 3 completed
- **Files modified:** 9 implementation/test files, plus this summary
- **Commits:** 0; the mounted `.git` directory is empty and unusable, per the explicit no-commit instruction.

## Accomplishments

- Added `TeamStudioStore` and `teamStudio` domain contracts for bounded member skills/tools, provider/model/locality routes, personality/tone/style, autonomy, approvals, and layered budgets.
- Implemented immutable numbered versions, stable IDs, duplicate lineage, archive/restore/delete tombstones, bounded reload normalization, and safe versioned import/export.
- Added host-owned previews and explicit accepted-project binding snapshots that remain stable after global team edits.
- Extended orchestration to require a bound version when configured and enforce member role, skill, tool, route, and request-budget constraints before deployment.
- Added strict `team-list`, `team-preview`, `team-bind`, `team-status`, import, and export webview messages plus accessible preview/bind controls with host-generated facts.
- Added negative coverage for credentials, prompts, raw context/media, commands, paths, unknown fields, malformed history, unbound invocation, stale version selection, and policy bypass.

## Task Commits

Git commits were intentionally not created because the repository metadata is unusable and the user explicitly requested no commits. No commit hashes are fabricated.

1. **Task 1: Trace one reusable named team from studio save to explicit project binding** — no commit (repository unavailable)
2. **Task 2: Expand team CRUD, immutable version history, import/export, archive, and deletion controls** — no commit (repository unavailable)
3. **Task 3: Invoke the selected team through project initialization and preserve exact member policy** — no commit (repository unavailable)

## Files Created/Modified

- `src/domain/teamStudio.ts` — reusable team, member, version, preview, binding, and export contracts.
- `src/services/teamStudio.ts` — global-storage CRUD, versioning, validation, import/export, previews, and project binding.
- `src/services/projectInitialization.ts` — accepted-project reusable binding persistence and rehydration.
- `src/services/agentOrchestrator.ts` — bound-team enforcement and member policy checks before deployment.
- `src/services/chatBridge.ts` — strict team messages and redacted team DTOs.
- `src/services/chat.ts` — host team handlers and accessible team studio controls.
- `src/test/teamStudio.test.ts` — CRUD/version/import/export/migration/security coverage.
- `src/test/teamInvocation.test.ts` — binding, orchestration, parser, and policy coverage.

## Decisions Made

- Kept reusable teams independent of workspaces in global storage, while project initialization stores only an exact, redacted binding snapshot.
- Reused the existing accepted-team and policy/orchestrator seams; no new orchestration dependency or credential access path was introduced.
- Treated all imported or legacy authority not represented by the allowlists as invalid/unavailable rather than granting it by normalization.

## Deviations from Plan

None - plan executed as written. The only workflow exception is that per-task and metadata Git commits were omitted because the mounted repository is not usable and the user explicitly requested no commits.

## Threat Surface Review

- **T-06-01 tampering:** nested allowlists, bounded strings/arrays/numbers, strict import fields, sequential version validation, and fail-closed migration prevent imported authority expansion.
- **T-06-02 elevation of privilege:** binding requires an accepted project; orchestrator deployment can require a matching team/version and checks member role, skills, tools, route, budget, and existing policy gate.
- **T-06-03 information disclosure:** previews, bindings, exports, and webview messages contain bounded operational metadata only; credentials, prompts, raw context/media, commands, and paths are rejected or omitted.
- **T-06-04 spoofing:** stable IDs and immutable version IDs are host-resolved; the webview cannot submit project ownership, cost, eligibility, or member permissions as authoritative values.
- **T-06-05 denial of service:** teams, versions, members, strings, arrays, budgets, and import package size are bounded and persisted through atomic replacement.
- No new network endpoint, wallet/credential file access, runtime dependency, or unrestricted filesystem operation was introduced.

## Verification

- `npm run lint` — passed.
- Focused `teamStudio.test.js` and `teamInvocation.test.js` — passed: 7 tests, 0 failures.
- `npm test` — passed: 31 test files, 31 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Stub/security scan completed; no intentional UI or data-source stubs were introduced.
- Interactive VS Code keyboard/screen-reader review is the only human-judgment item retained in coverage D4.

## Issues Encountered

- Git task commits, ledger measurement, ancestry checks, and metadata commit were unavailable because `.git` is an empty directory rather than a usable repository. The requested no-commit policy was honored; no Git metadata was initialized or modified.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

06-02 can consume `MemberCapabilityContract`, immutable `TeamBinding`, and `TeamPreview` to add fresh provider/model capability snapshots and route compatibility without changing the team security boundary.

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` and `commits: 0` are explicit.
- All plan-listed source/test files exist.
- Focused tests, full tests, lint, and packaging passed.
- No fabricated commit hashes or credential/wallet file changes are present.
- The GSD summary verifier's commit-existence check is intentionally unmet because this mounted workspace has no usable Git repository and the user explicitly prohibited commits; the manual artifact/content self-check above passed.

---
*Phase: 06-team-studio-and-multimodal-agent-skills*
*Plan: 01*
*Completed: 2026-10-26*
