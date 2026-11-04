---
phase: 25-cybersecurity-harness-with-offensive-and-defensive-scanning
plan: 04
subsystem: security
tags: [cybersecurity, permissions, sandbox, rate-limiting, budget, post-exploitation, emergency-stop]

requires:
  - phase: 25-01
    provides: "ResolvedScope and urlInScope, the Finding/Verdict/DepthProfile domain, SandboxTier"
requires-other:
  - "src/agent/permissions.ts RunGrants/decidePermission (the existing decision order, preserved)"
  - "src/agent/commandSafety.ts CommandContext; src/agent/shell.ts truncate and the process-group lesson"
  - "src/domain/policy.ts ActionCapability ('shell' is approval-gated); src/services/emergencyStop.ts"

provides:
  - "RunGrants.intrusiveEngagement plus grantIntrusive(): an engagement-wide intrusive grant that is scope-checked per step"
  - "decidePermission/decidePermissionAsync take an optional IntrusiveStep; the grant sits after the deny list and never changes a decision for non-cyber runs"
  - "cyberSandbox.ts: detectRuntime, chooseTier, startSandbox (container/temp/disabled), withSandbox, verifyCleanup"
  - "cyberLimits.ts: RateLimiter (sliding 60 s window), checkBudget with BudgetShortfall, POST_EXPLOIT_ALLOWLIST, postExploitAllowed"
  - "cyberExploitTools.ts: CyberExploitTool and CyberPostExploitTool with the stop → grant → rate → budget → sandbox order"

affects: [25-05, 25-06, 25-07, 25-08]

actuals:
  tokens: 24100
  tasks: 3
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Container commands are fixed argv through execFile (run/exec/rm -f/ps -a), never an assembled shell string"
    - "Cleanup runs inside a finally path and is then proven: ps -a must not list the container, or the temp dir must be gone"
    - "A limit refusal is an ordinary return value with a reason, so the loop shows it without an exception path"
    - "Rate limiting is a sliding window over timestamps; idle time is not credit"
---

# Plan 25-04 — the safety core for offensive work

## What landed

| Commit | Content |
|---|---|
| `f511d31` | `cyberLimits.ts` (rate, budget shortfall, post-exploitation rules), `cyberSandbox.ts` (three tiers, cleanup proof), `cyberSandbox.test.ts` |
| (this commit) | the engagement grant in `permissions.ts`, `cyberExploitTools.ts`, `cyberEmergencyStop.test.ts` |

## Requirement: CYBER-10

CYBER-10's clauses and where each is proven:

| Clause | Proof |
|---|---|
| Intrusive steps need the engagement-wide grant | `decidePermission` returns `ask` without a grant; `CyberExploitTool` refuses with "Intrusive steps need the engagement-wide grant" and never opens a sandbox |
| A granted step still cannot leave the resolved scope | out-of-scope under the grant is `deny` (not ask), and the tool restates the check through `stepGate` |
| The stop control halts within one tool call | a pre-engagement stop refuses before any exec; an abort mid-exec rejects and `stop()` still ran exactly once |
| Rate and wall-clock limits are enforced per step | `RateLimiter` and `checkBudget` are consulted in `stepGate` before the sandbox; both refuse with a reason |
| A budget stop reports what it did not reach | `checkBudget` returns `shortfall.unreachedHosts` / `unreachedChecks` by name, and the tool prints them in its refusal |

## Decisions and their rationale

**The grant is a field plus a method on `RunGrants`, not a new parameter object.** Existing construction sites (`new RunGrants()`) compile unchanged; the only signature change is an optional 7th parameter on `decidePermission`/`decidePermissionAsync`. `PermissionDecision`'s allow variant gained an optional `reason`, which is backward compatible for every consumer (the loop only reads `reason` on ask/deny).

**Order inside the shell branch:** deny list → engagement grant → per-command grants → allow list → policy. The grant sits after the deny list because a deny-listed command must stay refused even under a grant (D-04), and before the per-command grants because the engagement grant is broader. Emergency stop still short-circuits at the top, so it beats everything.

**`startSandbox('container')` executes `docker run` itself.** The first version built the argv and never ran it — the fake runner in the test caught it, since `docker run` had no recorded call. A runtime that answers `--version` and then fails to start now throws `SandboxError`; the plan prohibits falling back to the temp tier on a failed start.

**The temp tier records real exit codes.** `execFile` gives a numeric `code` on a non-zero exit; that number is now the reported exit status instead of a hard-coded 0, so a payload that fails is not reported as a success.

**`verifyCleanup` is asymmetric by design.** In the temp tier it checks the recorded paths are gone from the sandbox directory. In the container tier, a recorded path that exists *on the host* is the alarm (a container escape, T-25-14), because the container itself is already destroyed.

## Deviations from the plan

**1. [Rule 2 — missing critical functionality] `PermissionDecision`'s allow variant gained an optional `reason`.**
The plan requires the allow reason to name the engagement ("allowed under the intrusive grant for engagement <id>"), and the existing type had no reason on allow. All existing allow returns are unchanged (`{ decision: 'allow' }` still type-checks), and no consumer reads a reason on allow, so nothing else moved.

**2. [Rule 3 — blocking] `execFile`'s numeric exit code is read from the error, not from stdout parsing.**
The plan's container design implied parsing structured output for the status. `docker exec` returns the command's exit code as its own process code, which `execFile` surfaces as `error.code`; the fake runner now returns a `"<code>\n<output>"` shape that the container tier parses, and the temp tier uses the numeric code directly.

**3. [Rule 1 — bug] The rate limiter's "after idle time" assertion was wrong, not the limiter.**
The first test expected a sixth operation to be refused at t=60 000 after five at t=0. At exactly 60 000 the oldest stamp has aged out (the window is half-open), so allowing it is correct. The test now asserts five are allowed at 60 000 and the sixth refuses at 60 001, which is the real "no banked burst" property.

**4. [Rule 1 — bug] `detectRuntime` short-circuits on docker.**
The test expected both `--version` calls; the implementation returns as soon as docker answers, which is the documented preference order and avoids a needless exec. The assertion was corrected to match the intended behaviour.

## Verification

| Gate | Command | Result |
|---|---|---|
| Lint / typecheck | `npm run lint` | exit 0 |
| Plan tests | `node --test dist/test/cyberSandbox.test.js dist/test/cyberEmergencyStop.test.js` | 25 pass, 0 fail |
| Permission regressions | `node --test dist/test/agentTools.test.js dist/test/agentLoop.test.js dist/test/agentBasics.test.js dist/test/autoApproval.test.js dist/test/runGuards.test.js dist/test/toolsPage.test.js` | 55 pass, 0 fail (1 skipped) |
| Full suite | `node --test dist/test/*.test.js` | 684 tests, 676 pass, 0 fail, 8 skipped |

Acceptance greps:

| Criterion | Required | Actual |
|---|---|---|
| `intrusiveEngagement` in `permissions.ts` | ≥ 3 | 3 |
| deny-list line number < grant branch line | true | 114 < 118 |
| `network none` in `cyberSandbox.ts` | ≥ 1 | 1 |
| `rm -f` in `cyberSandbox.ts` | ≥ 1 | 1 |
| `finally` in `cyberSandbox.ts` | non-empty | 5 |
| `shortfall\|unreachedHosts` in `cyberLimits.ts` | ≥ 2 | 5 |
| `from 'vscode'` in sandbox/limits | none | none |
| `reason` in `cyberSandbox.ts` | ≥ 2 | 9 |
| `finally` in `cyberExploitTools.ts` | ≥ 1 | 1 |
| `postExploitAllowed` in `cyberExploitTools.ts` | ≥ 1 | 2 |
| stop check in `cyberExploitTools.ts` | ≥ 1 | 1 |

**Caveat:** `npm run compile` must precede a full run (`scripts/vendor-libs.mjs` populates `vendor/pdfjs`; eight document/graphics tests fail without it). With that done the suite is 676 pass / 0 fail.

## Issues encountered

- `AgentTool.sensitive` is consulted by the loop before the permission decision, so a granted engagement still produces a "sensitive" string; the type returns `undefined` when `granted()` is true, which keeps the grant's "no card" behaviour. If 25-06 wants the card to show the payload even under a grant, that is a one-line change in the two `sensitive` closures.

## Next phase readiness

- **For 25-06 (offensive run):** `cyberExploitTools({ engagementId, inScope, granted, stopped, rateLimiter, budget, sandboxTier, onEvidence, onCommand })` is the whole surface. Wire `granted` to `grants.intrusiveEngagement` (or simply `grantIntrusive(engagementId, inScope)` at grant time), `stopped` to the emergency-stop state plus the run's abort signal, and `budget` to a closure over `checkBudget` with the run's planned hosts and checks.
- **For 25-05 (run record):** `checkBudget`'s `BudgetShortfall` is the shape the run record should carry for D-09. `withSandbox` guarantees the stop path, so the run layer only needs to call `verifyCleanup(recorded, sandbox)` before writing the record.
- **For 25-07 (panel):** `chooseTier({ allowTempTier })` returns the tier and the honesty string for the "offensive mode disabled" state. Do not show a tier without its reason when a runtime is missing.

## Self-check: PASSED

Every plan test passes (25/25), `npm run lint` exits 0, the full suite is 676 pass / 0 fail with 8 pre-existing skips, and all eleven acceptance greps meet their thresholds. No new npm dependency was added, and neither `src/services/cyberSandbox.ts` nor `src/domain/cyberLimits.ts` imports `vscode`. The `RunGrants` and `decidePermission` changes are additive: a run without an engagement grant decides exactly as before, proven by the six pre-existing permission suites staying green.
