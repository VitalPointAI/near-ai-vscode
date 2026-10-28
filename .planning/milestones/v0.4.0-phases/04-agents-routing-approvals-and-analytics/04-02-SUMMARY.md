---
phase: 04-agents-routing-approvals-and-analytics
plan: 02
subsystem: privacy-and-policy
tags: [privacy, sovereignty, redaction, approvals, security, testing]
requires:
  - phase: 04-agents-routing-approvals-and-analytics
    plan: 01
    provides: non-sensitive agent/team state and Phase 4 privacy decisions
  - phase: 03-chat-workspace-motion-activity-and-command-bridge
    provides: existing action capability policy and redacted operational patterns
provides:
  - Typed privacy classification, provider-boundary, sovereignty, preview, decision, and audit contracts
  - Workspace-aware privacy preflight with redacted previews and one-time exact-scope overrides
  - PolicyGate combining privacy decisions with existing action approval and emergency-stop behavior
  - Negative coverage for credentials, private paths, traversal/symlink escapes, malformed classifications, and silent fallback
affects: [04-03, 04-04, 04-05]
tech-stack:
  added: []
  patterns: [typed privacy boundary, redacted non-sensitive audit records, exact-scope one-time overrides, deny-by-default unknowns]
key-files:
  created:
    - src/domain/privacy.ts
    - src/services/privacyPreflight.ts
    - src/services/policyGate.ts
    - src/test/privacyPreflight.test.ts
    - src/test/policyGate.test.ts
  modified: []
key-decisions:
  - "Unknown classifications block by default; safe requests with no sensitive signal can pass only when a concrete context/path scope is present."
  - "Local-only mode blocks cloud inference and network boundaries, while an explicit exact-scope one-time override is auditable and still cannot bypass action approval or emergency stop."
  - "Audit records retain classifications, redacted previews, provider boundary, and outcome, never raw context or credential literals."
  - "Workspace-relative path validation resolves real paths and rejects traversal, absolute paths, missing files, and symlink escapes."
  - "Git commits remain unavailable because the mounted .git directory is empty/read-only and the workspace is not a usable repository; no hashes are fabricated."
metrics:
  duration: approximately 30m
  completed: 2026-10-25
  tasks: 2
  files: 5
  commits: 0
  plan_head_before: unavailable
  plan_head_after: unavailable
actuals:
  tokens: 5348
  tasks: 2
  commits: 0
status: complete
---

# Phase 4 Plan 2: Privacy Preflight and Sovereignty Policy Summary

Privacy preflight now classifies outbound context, produces a concise redacted preview, enforces local-only sovereignty and action approvals, and records auditable decisions without retaining sensitive content.

## Accomplishments

- Added `DataClass`, `ProviderBoundary`, `SovereigntyMode`, `PrivacyRule`, `PrivacyDecision`, `RedactedPreview`, `PrivacyAuditRecord`, and provider request/override contracts.
- Implemented `PrivacyPreflight` classification for secret-like values, private/credential paths, personal data, sensitive scope expansion, and unknown requests.
- Added redaction and bounded previews for context and private paths, including explicit provider and TEE-status labeling.
- Added exact request/provider/path/classification fingerprints for one-time override issuance and replay/forgery rejection.
- Added `PolicyGate` as the enforcement seam that combines privacy preflight with `decideAction`, preserving automatic reads/plans and approval-controlled writes, shell, network, and git mutations.
- Made emergency stop a hard deny for every capability and outbound request, including local requests and override attempts.
- Added read-only realpath containment checks that reject traversal, absolute paths, missing paths, and symlink escapes without accessing or modifying `~/.near-credentials`.

## Task Commits

Git commits were unavailable. The mounted workspace contains an empty read-only `.git` directory and Git reports that it is not a repository. No commit hashes are fabricated.

1. **Task 1: Trace one outbound context request through classification, preview, policy, and block/allow** — no commit (repository unavailable)
2. **Task 2: Expand data-class/path rules, overrides, and action capability enforcement** — no commit (repository unavailable)
3. **Plan metadata** — no commit (repository unavailable)

## Verification

- `npm run lint` — passed.
- Focused privacy/policy verification — passed across all 18 compiled test files.
- `npm test` — passed: 18 test files, 18 passed, 0 failed, 0 skipped/todo.
- `npm run package` — passed; `near-ai-vscode-0.1.0.vsix` produced.
- Negative tests cover bearer/API/refresh credentials, `.near-credentials`, private files, traversal, symlink escape, malformed classifications, forged and repeated overrides, local-only cloud/network requests, cloud fallback attempts, and emergency stop.
- Serialized audit assertions confirm raw sensitive values and credential literals are absent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected safe-request classification precedence**
- **Found during:** Task 1 focused verification.
- **Issue:** Initial classification marked ordinary workspace paths as `public`, which caused safe local requests to require confirmation and made the secret test contain an unnecessary public classification.
- **Fix:** Treat ordinary paths as scope evidence without adding a policy-sensitive classification; reserve `unknown` for requests with no context, path, or scope signal.
- **Files modified:** `src/services/privacyPreflight.ts`
- **Verification:** Focused privacy/policy tests, full test suite, and package verification pass.
- **Committed in:** No commit; repository unavailable.

No architectural deviation, package installation, authentication gate, or out-of-scope fix occurred.

## Threat Surface Review

The implementation addresses all plan threat-register items: classification/redaction before dispatch, raw-content exclusion from audit records, exact-scope one-time overrides, combined action/privacy enforcement, emergency-stop hard deny, and read-only path containment. No new external endpoint or credential access path was introduced.

## Known Stubs

None found in files created or modified by this plan.

## Self-Check: PASSED

- All five plan-listed implementation/test files exist.
- `status: complete` is present.
- Lint, focused tests, full tests, and VSIX packaging passed.
- Git commit/ancestry checks are not applicable because the workspace is not a usable Git repository; `commits: 0` is recorded honestly.

---
*Phase: 04-agents-routing-approvals-and-analytics*
*Plan: 02*
*Completed: 2026-10-25*
