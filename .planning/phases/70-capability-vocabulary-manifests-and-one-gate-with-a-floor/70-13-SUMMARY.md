---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 13
subsystem: gate
tags: [gate, shadow-floor, cyber, benchmark, enumeration, offline, decision-log]

requires:
  - phase: 70-12
    provides: "gateToolCall, recordApprovalReply, defaultGateRuntime, GateHost.runtimeFor, AgentRunOptions.gate, gateEnumeration.test.ts"
  - phase: 70-09
    provides: "AgentTool.manifest on every tool, manifestInput"
provides:
  - "src/agent/gateAdapter.ts: gateStep (decide a step whose settings answer the caller already has), effectsOfStep, GateStepInput"
  - "CyberRunInput.gate, panelCyberRunStarter option gateHost: every cyber panel step is decided by the gate and recorded before its tool or host tool runs"
  - "AgentInFolderOptions.gate, runGateFor, ComparisonOptions.gateFor, RoleSuiteOptions.gateFor: benchmark, comparison and role suite runs pass a gate (presence none, context unattended by default)"
  - "gateEnumeration.test.ts source scans (tool run sites, new AgentRun, child_process importers) with planted checks, six per-effect scripted runs, cyber and benchmark cases; gateOffline.test.ts run-level offline case"
affects: [70-14, 70-17]

actuals:
  tokens: 14970
  tasks: 3
  commits: 3
plan_head_before: 96b53e553c307993b7896c395b3bcb672dad3406
plan_head_after: 341207a2b62f202a5a6049d931e435e3fce0d9d1

tech-stack:
  added: []
  patterns:
    - "A path that builds its own settings answer (the cyber step engine: decidePermission with the engagement grant) hands it to gateStep whole; decide() runs on top of it exactly as for a chat call, and a card answer goes back through recordApprovalReply"
    - "A refusal made before any tool is chosen (an out-of-scope step) is still a decision: it is recorded with a deny settings answer and the engagement's rule id"
    - "A run nobody watches is decided with presence none and context unattended unless its creator can ask a person (D-43, T-70-86); the comparison panel and role suite make a fresh runtime per task run from the host, rooted at the project so records reach its log"
    - "The execution-path test reads production sources from the repository root and compares them with allow-lists written in the test; each scan has a planted-violation check"

key-files:
  created: []
  modified:
    - src/agent/gateAdapter.ts
    - src/services/cyberRun.ts
    - src/services/cyberAssembly.ts
    - src/extension.ts
    - src/benchmark/runner.ts
    - src/benchmark/roleSuite.ts
    - src/services/modelComparisonPanel.ts
    - src/services/teamStudioPanel.ts
    - src/test/gateEnumeration.test.ts
    - src/test/gateOffline.test.ts

key-decisions:
  - "The cyber engine obeys the gate's outcome (deny refuses, ask shows the card and records the answer, allow runs); with a valid bundle and the shadow floor that outcome is always today's decidePermission result"
  - "The cyber settings answer is named with a stable rule id by asking the same questions again about the inputs: settings.read-plan, settings.engagement-grant (allowed under the grant, or refused as outside the granted scope), settings.deny-list, settings.mode.other (asked), settings.emergency-stop. No new rule id was added, so GATE_RULE_IDS and its count assertion are unchanged"
  - "An out-of-scope step is recorded through the gate as a refusal under settings.engagement-grant (the engagement's own layer); the scope refusal itself, its notice and its ledger entry are unchanged"
  - "A catalogued host tool is decided as shell (anywhere) plus network on the target host; a probe or exploit tool is decided from its manifest effects of the step's input, with the same shorthand on the target standing in while the floor only reports"
  - "runAgentInFolder decides with presence none and context unattended unless requestApproval is passed (then person and interactive); a gate passed in is used as it is"

patterns-established:
  - "Production AgentRun constructions all pass a gate (agentSession twice, benchmark runner once); a new construction without one fails gateEnumeration"

requirements-completed: [GATE-04, GATE-07, OFFL-01]

duration: one session
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 13: The remaining execution paths pass the gate, and a test finds every one Summary

**The cyber panel's step engine, benchmark runs, model comparison runs and the team studio's role suite are now decided by the same gate as chat runs (today's permission answer, engagement grant included, is the settings layer) and recorded before anything runs; `gateEnumeration` reads the production sources to prove `tool.run(`, `new AgentRun(` and `child_process` appear only at listed places, runs one scripted call per effect kind, and `gateOffline` runs a whole scripted run with every network function stubbed to throw. With a valid bundle no decision changed.**

## Performance

- **Tasks:** 3 of 3
- **Files:** 10 modified, none created (565 insertions, 17 deletions over the plan's three commits)
- **Tracer gate:** the Task 1 verify command was green end to end (auto mode, `⚡ Tracer verified end-to-end - expanding`) before Task 2 started

## Accomplishments

- Cyber panel (Task 1): each step that reaches its permission path now calls `gateStep` with `decidePermission(...)` (and the "no engagement grant means ask" adjustment) as its settings answer. The outcome is obeyed: an ask shows the same card, the answer goes through `recordApprovalReply` (recorded `approved` or `denied`, and an allow re-checks emergency stop, bundle state and floor refusals), a deny is refused with the same reason text as before. A step outside the engagement's scope is recorded as a refusal too. `startCyberRun` takes an optional `gate`; without one it uses the shipped default with a person present in an interactive context. The panel passes the host's runtime (`panelCyberRunStarter({ gateHost })`, wired in `extension.ts`) so a scan's decisions reach the project's log.
- Benchmark runs (Task 2): `AgentInFolderOptions.gate`, with `runGateFor` giving the default (presence none, context unattended, floor shadow, in-memory sink) unless `requestApproval` is passed. `runComparison` gets `gateFor` (per task run) and `runRoleSuite` gets `gateFor` (per role run). The model comparison panel and the team studio build a fresh `host.runtimeFor({ presence: 'none', context: 'unattended', floorMode: 'shadow' })` per run, rooted at the project, so the decisions land in the project's log; both skip it when there is no host or no project folder.
- Enumeration (Task 3): three source scans over `src` (not `src/test`), each exercised on a planted string; a scripted AgentRun per effect kind (Read, Write, Bash, WebFetch, an MCP tool, Agent), each asserting exactly `[decision, run]` in that order and the record's operation; and in `gateOffline` a whole scripted run (Read, Write, Bash with the gate in unattended presence none) that records three decisions, each before its tool's run, with fetch, net.connect, net.createConnection, dns.lookup, dns.promises.lookup, http.request and https.request stubbed to throw and counted: all counted 0.
- The benchmark runner question left open by 70-12 is decided: it gets an explicit gate, presence none by default.

## Task Commits

1. **Task 1 (tracer): cyber panel steps go through the gate** - `6c556e2` (feat)
2. **Task 2: comparison and benchmark runs go through the gate** - `31dc83b` (feat)
3. **Task 3: a test finds every execution path, and runs decide offline** - `341207a` (test)

**Plan metadata:** the commit that adds this SUMMARY.

## Verification

Every run inside the cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

- Task 1 plan command (`npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateEnumeration.test.js dist/test/cyberRun.test.js dist/test/cyberAssembly.test.js dist/test/cyberEmergencyStop.test.js`): tsc clean; 57 tests, 57 pass, 0 fail, 0 cancelled.
- Task 2 plan command (gateEnumeration, benchmarkRunner, teamStudioPage, modelComparisonPage): tsc clean; 85 tests, 85 pass, 0 fail, 0 cancelled.
- Task 3 / parity command (`dist/test/gate*.test.js` plus autoApproval, agentLoop, protectedPaths, untrusted, unattendedApproval, mcp, toolsPage, commandSafety, approvalRisk, agentBasics, teamSignedPayload, teamBoundaries): tsc clean; 490 tests, 490 pass, 0 fail, 0 cancelled, 0 skipped. `gateEnumeration` alone is now 32 tests; `gateOffline` 4.
- Full run (`systemd-run ... MemoryMax=6G ... timeout 1800 ... sh -c 'npx tsc -p tsconfig.json && node scripts/run-tests.mjs dist/test/*.test.js scripts/test/*.test.mjs'`) at `341207a`: 2,979 tests, 2,970 pass, 0 fail, 0 cancelled, 9 skipped (the existing skips). e2e was not run (the plan does not call for it).
- Acceptance: `git diff cbe4ef3 HEAD -- src/agent/permissions.ts` is empty. No pre-existing test file was edited by this plan: `git diff 96b53e5 HEAD --stat -- src/test` lists only `gateEnumeration.test.ts` and `gateOffline.test.ts`. The parity files differ from `cbe4ef3` only by earlier plans' own fixture lines (`git diff --stat cbe4ef3 HEAD -- src/test`: cyberRun, mcp, steering, toolsPage, teamBoundaries and gateDecide, all from plans 09 to 12).

## Deviations from Plan

**1. [Rule 3 - Blocking] Files outside the plan's list were edited to get the host's runtime to the paths.** `src/services/cyberAssembly.ts` (a `gate` pass-through in `startCyberRunInPanel` and a `gateHost` option on `panelCyberRunStarter`) and `src/extension.ts` (one argument to each of `panelCyberRunStarter`, `registerModelComparison` and `openTeamStudio`). Without them the plan's "runtime comes from its caller's host when there is one" could not be true in production. All new parameters are optional, so existing callers and tests are unchanged. Also in `runner.ts`: `ComparisonOptions.gateFor` and `RoleSuiteOptions.gateFor` (per-run runtime factories) because a runtime needs the run's own model and task for its record and the plan named only `AgentInFolderOptions.gate`.

**2. [Interpretation] A "gateToolCall variant that takes a precomputed settings answer" is `gateStep`.** It builds a `GateRequest` from names and effects (not an `AgentTool`), because a catalogued host tool is not an `AgentTool`. Effects for a host tool are `shell anywhere` plus `network` on the target host (built with `fromActionCapability`); for a tool step they are the manifest's effects of the step's input (`effectsOfStep`, which uses the same `manifestArguments` as chat), with `fromActionCapability` on the target host standing in while the floor is shadow.

**3. [Interpretation] The out-of-scope refusal is recorded through the gate.** The plan's test asks for a record for an out-of-scope step; today that refusal happens before any permission path. It now calls `gateStep` with a deny settings answer under the existing rule id `settings.engagement-grant` (no new rule id, so `GATE_RULE_IDS` and gateDecide's count assertion are untouched). A record failure there never changes the refusal. Steps refused for an unknown tool, the budget or the rate limit are not tool executions and are not decisions.

**4. [Note] TDD red/green were not separate commits** (Task 3 is `tdd="true"` but the scans and runs it adds pass against code that already existed, so there is no failing state to commit; each scan is shown to find what it should by its planted check, and the `AgentRun` scan would have failed before Task 2 for `runner.ts`).

**Total deviations:** 4 (1 blocking, 2 interpretation, 1 note). **Impact:** none on a decision with a valid bundle.

## Assertions changed on purpose

None. No pre-existing assertion in any test was changed or removed; this plan only added tests to `gateEnumeration.test.ts` (and removed my own earlier header sentence and an import line in that file when extending it) and `gateOffline.test.ts`.

## Decisions Made

See key-decisions. Left open or for later plans:

- **`GateHost.reset()` still has no command** (Reset Policy to Defaults), as before.
- **Presence and the floor for cyber steps.** The panel's runtime is presence person, context interactive, floor shadow, so a step the floor would one day ask about is only reported. Plan 17 flips the floor; a cyber step that is `shell anywhere` plus a network host will then hit the floor's own rules, and the exploit tools' manifests (`shell workspace` plus network on the target) should be checked against it then.
- **Cyber `sensitive` hook.** The exploit tools' `sensitive` hook is still not consulted by the step engine (it never was); the engagement grant and scope check remain the control there. Not changed.
- **Cyber steps have no model name in their record.** `CyberRunInput` carries no model; the records name the actor (`cyber panel`, session `cyber-<engagement>`) only.
- **MCP direct calls and Open-GSD runtime** (named in 70-12's next-phase note): the scan found no other call site of a tool's run, so there is nothing further to gate there today; the scan will fail if one is added.
- Folder-path coverage in gate path matching (70-08) is still open, as in 70-12.

## Issues Encountered

One test bug of my own while writing the cyber case: wrapping a runtime's sink by `Object.assign` onto the same object made the wrapper call itself. Fixed by spreading into a new runtime. No product issue.

## Known Stubs

None.

## Threat Flags

None new. T-70-38 (a new execution path that skips the gate): tool run, `new AgentRun` and child_process scans with planted checks. T-70-41 (decisions without records): a record before each run for the six effect kinds, the cyber panel and benchmark/comparison/role runs, tested. T-70-86 (a run with nobody present treated as having a person): `runGateFor` defaults to presence none and context unattended, tested. T-70-SC: no package added.

## Next Phase Readiness

Plan 14 can rely on every run path passing a gate with a recorded decision. Plan 17, when it flips the floor to enforce (`agentSession.ts` two sites), should also flip the cyber panel's and the comparison runs' `floorMode` (they are `'shadow'` in `cyberAssembly.ts`, `modelComparisonPanel.ts` and `teamStudioPanel.ts`), and handle the trusted-roots reads noted in 70-12.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*

## Self-Check: PASSED

- FOUND: src/agent/gateAdapter.ts, src/services/cyberRun.ts, src/benchmark/runner.ts, src/test/gateEnumeration.test.ts, src/test/gateOffline.test.ts
- FOUND commits (ancestors of HEAD): 6c556e2, 31dc83b, 341207a
