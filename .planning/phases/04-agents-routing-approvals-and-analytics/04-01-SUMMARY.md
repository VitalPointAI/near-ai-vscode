---
phase: 04-agents-routing-approvals-and-analytics
plan: 01
subsystem: agents
tags: [profiles, teams, persistence, privacy, vscode, testing]
requires:
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: bounded versioned local ledgers, atomic replacement persistence, redacted operational metadata, and restart-safe activity patterns
provides:
  - Versioned non-sensitive agent profiles with memorable identities and lifecycle controls
  - Quiet/professional presentation that preserves exact operational facts
  - Deterministic role-based team recommendations with tradeoffs and customization
  - Accepted, versioned project team persistence gated before execution
affects: [04-02, 04-03, 04-04, 04-05]
actuals:
  tokens: 8006
  tasks: 2
  commits: 0
plan_head_before: unavailable
plan_head_after: unavailable
commits: 0
tech-stack:
  added: []
  patterns: [allowlisted profile/team serialization, atomic temp-file replacement, deterministic display identity, acceptance-gated project state]
key-files:
  created:
    - src/domain/agents.ts
    - src/services/agentProfiles.ts
    - src/services/agentTeams.ts
    - src/services/projectInitialization.ts
    - src/test/agentProfiles.test.ts
    - src/test/agentTeams.test.ts
    - src/test/projectInitialization.test.ts
  modified: []
key-decisions:
  - "Stable profile IDs remain authoritative; memorable names are display-only and collision-handled."
  - "Profile and team artifacts use field allowlists and reject secrets, prompts, credentials, raw context, commands, and absolute paths."
  - "Project initialization returns a recommendation first and refuses execution until an accepted or customized team is persisted."
  - "Git commits were not possible because the mounted .git path is an empty read-only directory; no repository was initialized and no hashes are fabricated."
patterns-established:
  - "Profile stores normalize supported legacy records and rewrite them to the current schema on load."
  - "Team acceptance stores operational role metadata only; discovery answers remain transient."
requirements-completed: [ONB-04, AGENT-04, AGENT-06, AGENT-07, UX-02]
coverage:
  - id: D1
    description: "Non-sensitive agent profiles persist, migrate, rehydrate, export, reset, and delete independently of credentials."
    requirement: AGENT-06
    verification:
      - kind: unit
        ref: src/test/agentProfiles.test.ts#agent profile survives a fresh store, export, reset, and credential-independent deletion
        status: pass
      - kind: unit
        ref: src/test/agentProfiles.test.ts#profile serialization allowlists fields and migrates older supported records
        status: pass
    human_judgment: false
  - id: D2
    description: "Memorable identities and quiet mode preserve role, task, model, route, status, cost, and error facts while changing only presentation copy."
    requirement: AGENT-04
    verification:
      - kind: unit
        ref: src/test/agentProfiles.test.ts#quiet identity removes humor while preserving authoritative operational facts
        status: pass
    human_judgment: false
  - id: D3
    description: "Initialization recommends a role-based team with responsibilities and tradeoffs, supports customization, and persists accepted versions only after acceptance."
    requirement: ONB-04
    verification:
      - kind: unit
        ref: src/test/agentTeams.test.ts#role-based team recommendation exposes responsibilities and tradeoffs
        status: pass
      - kind: unit
        ref: src/test/projectInitialization.test.ts#initialization requires acceptance and rehydrates accepted team without discovery answers
        status: pass
      - kind: unit
        ref: src/test/projectInitialization.test.ts#customized team is versioned and private answers never enter the artifact
        status: pass
    human_judgment: false

duration: approximately 25m
completed: 2026-10-25
status: complete
---

# Phase 4 Plan 1: Agent Profiles and Accepted Teams Summary

**Durable non-sensitive agent profiles, memorable/quiet identities, and acceptance-gated role-based project teams are now implemented with migration and privacy-negative coverage.**

## Performance

- **Duration:** approximately 25m
- **Started:** 2026-10-25T22:19:00Z
- **Completed:** 2026-10-25T22:44:16Z
- **Tasks:** 2 completed
- **Files modified:** 7 implementation/test files, plus this summary
- **Commits:** 0; Git is unavailable in this mounted workspace.

## Accomplishments

- Added versioned `AgentProfile` contracts and `AgentProfileStore` with bounded local persistence, atomic replacement, legacy migration, stable IDs, memorable names, reset/export/delete, and credential-independent lifecycle controls.
- Added quiet/professional identity formatting that suppresses optional humor without removing authoritative role, task, model, route, status, cost, or error facts.
- Added concise project discovery contracts, deterministic role-based recommendations, responsibility/coordination/model-cost/privacy tradeoffs, customization, acceptance gating, versioned history, and restart rehydration.
- Added negative tests proving profile/team artifacts exclude credentials, tokens, private prompts, raw context, commands, arbitrary paths, and private discovery answers.

## Task Commits

Git commits were unavailable. The mounted workspace contains an empty read-only `.git` directory and `git` reports that it is not a repository. No commit hashes are fabricated.

1. **Task 1: Persist and resurrect one non-sensitive agent profile end to end** — no commit (repository unavailable)
2. **Task 2: Recommend, customize, accept, and persist a role-based project team** — no commit (repository unavailable)

**Plan metadata:** no commit (repository unavailable).

## Files Created/Modified

- `src/domain/agents.ts` — versioned profile, identity, lifecycle, discovery, recommendation, and accepted-team contracts.
- `src/services/agentProfiles.ts` — allowlisted profile normalization, migration, atomic persistence, lifecycle controls, memorable names, and presentation formatting.
- `src/services/agentTeams.ts` — deterministic role recommendation and customization with visible tradeoffs.
- `src/services/projectInitialization.ts` — discovery questions, acceptance gate, project team persistence, history, and rehydration.
- `src/test/agentProfiles.test.ts` — profile lifecycle, migration/privacy, and quiet-mode coverage.
- `src/test/agentTeams.test.ts` — recommendation and customization coverage.
- `src/test/projectInitialization.test.ts` — acceptance, rehydration, versioning, and private-answer exclusion coverage.

## Decisions Made

- Kept stable profile IDs as the execution reference; names are user-facing presentation only.
- Reused Phase 3’s bounded atomic local-ledger pattern and kept discovery answers transient.
- Made acceptance a hard precondition for execution-facing team retrieval.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected test fixture type and expectation errors**
- **Found during:** Task 1 and focused verification.
- **Issue:** New test fixtures inferred readonly/string-array types incompatible with the domain contract, and the high-risk five-role recommendation correctly calculated as high cost rather than medium.
- **Fix:** Typed the fixture capabilities and aligned the expectation with the implemented cost rule.
- **Files modified:** `src/test/agentProfiles.test.ts`, `src/test/agentTeams.test.ts`
- **Verification:** Lint, focused tests, full tests, and packaging pass.
- **Committed in:** No commit; repository unavailable.

**2. [Rule 2 - Information disclosure] Rewrote migrated profiles and sanitized accepted team fields**
- **Found during:** Privacy-negative verification.
- **Issue:** Loading an older profile artifact did not rewrite the normalized allowlisted representation, and accepted-team normalization needed to reject secret/path-shaped values in allowed text fields.
- **Fix:** Persisted migrated profiles at current version and added sensitive/path rejection for accepted-team text fields.
- **Files modified:** `src/services/agentProfiles.ts`, `src/services/projectInitialization.ts`
- **Verification:** Migration and private-artifact tests pass; full test suite and package pass.
- **Committed in:** No commit; repository unavailable.

---

**Total deviations:** 2 auto-fixed (1 blocking correctness issue, 1 information-disclosure mitigation). No package installation, credential-file access, architectural expansion, 04-02–04-05 work, or Phase 5 work occurred.

## Threat Surface Review

- **T-04-01 tampering:** Current-version schema normalization, bounded records, deterministic validation, migration, and atomic replacement writes are implemented and tested.
- **T-04-02 information disclosure:** Profile/team field allowlists reject credentials, tokens, prompts, raw context, commands, and unrestricted paths; serialized artifacts are checked by negative tests.
- **T-04-03 spoofing:** Profile IDs are stable and authoritative; memorable names are collision-checked display labels only.
- No new network endpoint, credential path, or package dependency was introduced. `~/.near-credentials` was not accessed or modified.

## Verification

- `npm run lint` — passed.
- Focused plan test command — passed; 16 test files completed with no failures under the filtered repository command.
- `npm test` — passed: 16 test files, 16 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Stub scan of all plan-created source/test files — no TODO/FIXME/placeholder stubs found.
- Live VS Code extension-host interaction was not required by this plan and remains outside automated verification.

## Issues Encountered

- Git task commits, ledger measurement, ancestry checks, and metadata commit were unavailable because the mounted `.git` path is not a usable repository. This is recorded as `commits: 0`; Git metadata was not initialized or changed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

04-01 is complete on disk. 04-02 can consume the profile/team allowlists and add privacy preflight and sovereignty enforcement. Plans 04-02 through 04-05 and Phase 5 were not executed.

## Self-Check: PASSED

- Summary file exists at the required path.
- `status: complete` is present.
- All seven plan-listed implementation/test files exist.
- `npm run lint`, focused tests, `npm test`, and `npm run package` passed.
- Git commit verification is not applicable because the workspace is not a Git repository; no commit claims are present.

---
*Phase: 04-agents-routing-approvals-and-analytics*
*Plan: 01*
*Completed: 2026-10-25*
