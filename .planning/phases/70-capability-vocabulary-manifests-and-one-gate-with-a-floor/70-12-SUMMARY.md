---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 12
subsystem: gate
tags: [gate, shadow-floor, activation, decision-log, approval-cards, sub-agents, fail-closed, effects-unknown]

requires:
  - phase: 70-11
    provides: "ensurePolicyBundle, resetPolicyToDefaults, DecisionLog, projectLogKey"
  - phase: 70-09
    provides: "AgentTool.manifest on every tool, manifestInput"
  - phase: 70-10
    provides: "MCP manifests (decided from effects and contexts)"
provides:
  - "src/gate/host.ts: GateHost (start, state, bundleState, runtimeFor, reset, onDidChange, flush)"
  - "src/agent/gateAdapter.ts: gateToolCall, recordApprovalReply, recordLateApproval, settingsLayerFor, settingsRuleFor, effectsOfCall, manifestArguments, defaultGateRuntime"
  - "src/services/gateCommands.ts: registerGate (activation adapter, never throws), called before registerTeamMode"
  - "AgentRunOptions.gate, AgentConversation.gateHost, GateRuntime.productVersion / clock / newRecordId"
  - "decide(): the manifest.effects-unknown rule (PR 1 review fold-in)"
  - "src/test/gateEnumeration.test.ts (16 tests), src/test/gateActivation.test.ts (4 tests)"
affects: [70-13, 70-14, 70-15, 70-17]

actuals:
  tokens: 20100
  tasks: 2
  commits: 4
plan_head_before: 85acd4337360505c953b3d9460ba0302eaae4c90
plan_head_after: 8562192661dd60507dbf4693b2311bfc13f0dfa9

tech-stack:
  added: []
  patterns:
    - "The loop asks the gate and obeys it: decision, card reason (the settings layer's own), run-wide grant and allow-rule offer all come from the GateDecision (allowGrant, offerAlwaysAllow), so a floor decision can never carry either"
    - "Effects come from the model's RAW arguments through manifestInput, with an absolute path inside the call's folder written project-relative; a call the manifest cannot fill gets the widest form of the tool's own shorthand while the floor only reports (shadow), and an empty list once it is enforced"
    - "Settings answers are named by asking the same questions again about the inputs (never by reading reason text); a rule id that cannot be told exactly is the nearest id in GATE_RULE_IDS"
    - "A record is queued (ordered, never rejecting) before the call runs; a late answer to a queued card is recorded against the call it was asked for"

key-files:
  created:
    - src/gate/host.ts
    - src/agent/gateAdapter.ts
    - src/services/gateCommands.ts
    - src/test/gateEnumeration.test.ts
    - src/test/gateActivation.test.ts
  modified:
    - src/agent/loop.ts
    - src/services/agentSession.ts
    - src/services/chat.ts
    - src/services/panelView.ts
    - src/extension.ts
    - src/domain/gate/decide.ts
    - src/domain/gate/record.ts
    - src/test/gateDecide.test.ts

key-decisions:
  - "Shadow floor for every run: floorMode 'shadow' on the main run and on every sub-agent; the enforced floor verdict is only recorded beside the decision (unmapped.nearAi.shadowFloor)"
  - "The host hands runtimes a bundle state that is re-checked against its expiry at every decision, so a window left open past the bundle's end fails closed without a file read"
  - "The bundle's own events (policy.created, policy.renewed, policy.resigned-default, policy.reset, and a failed or plain policy.load) are recorded in the open project's log with api.operation set to the event name; with no folder open nothing is recorded"
  - "A tool that is forbidden (the key folder) is still sent through the gate so the refusal is recorded; the person-facing message stays today's `Not allowed: <forbidden reason>`"
  - "The settings rule for sharedWrite is settings.mode.other, not floor.shared-write: in shadow the floor did not decide, and the floor's own verdict is in shadowFloor"

patterns-established:
  - "Production AgentRun constructions pass `...(gate ? { gate } : {})` from the conversation's host; tests may omit it and get defaultGateRuntime"

requirements-completed: [GATE-04, GATE-07, OFFL-02]

duration: one session
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 12: One gate in front of chat runs and sub-agents, started at activation, cards as transport Summary

**Every tool call of the main chat run and of each sub-agent is now decided by `decide()` (today's `decidePermissionAsync` is its settings layer, the floor runs in shadow) and recorded to the project's decision log before the call runs; the gate starts at activation, fails closed on any bad or unreadable policy, and an approval card is only a transport whose answer goes back into the gate. With a valid bundle no decision changed.**

## Performance

- **Tasks:** 2 of 2, plus the owner's PR #66 review fold-in (own commit)
- **Files:** 5 created, 8 modified (1,332 insertions, 34 deletions over the plan's four commits)
- **Tracer gate:** the Task 1 verify command was green end to end before Task 2 started (auto-continue)

## Accomplishments

- `GateHost` starts once at activation and never throws or rejects: any error leaves the gate failed-closed (`identity-unavailable` with the error kept as `detail`), the person gets the bundle's plain sentence once, and a `policy.load` record is written when a project is open. A bundle that expires while the window is open reads as expired at the next decision.
- `gateToolCall` builds the request (manifest effects of the model's raw arguments, `forbidden`, `sensitive`, `risky`, the manifest's contexts, the live policy), runs `decide()` with the settings layer and records one line per decision. The loop's old line-631 logic now lives in `decide()`; the card's reason, `grant` and `allowRule` come from the decision.
- A decided call's record is queued (in order, never rejecting) before `tool.run`; the tracer reads the `asked` line from the file while the card is open and the target file does not exist yet.
- Cards are transport: the answer goes through `recordApprovalReply` (`approved` or `denied` against the same call id) and an allow re-asks emergency stop, bundle state, floor refusals and ceiling before anything runs; a pending answer is remembered and `recordLateApproval` records it when it arrives (called from the sub-agent's `onLate`).
- Sub-agents: `kind sub-agent`, presence person, context interactive, floor shadow (D-43); their PERF-01 `unattended` flag still reaches only the settings layer. The lead's Agent call is a `spawn` decision and the helper's own calls are decided and logged in one ordered log.
- Activation: `registerGate(context)` (line 129 of `src/extension.ts`) comes before `registerTeamMode(context)` (line 136) and its host is handed to the sidebar, then to each conversation.

## Task Commits

0. **Fold-in (PR #66 review): effects unknown fails closed; enum comment fixed** - `67ab549` (fix)
1. **Task 1 (tracer): every chat tool call goes through the gate, in shadow, and is recorded** - `1d62946` (feat)
2. **Task 2: sub-agents pass the gate, cards only carry questions and answers** - `737c207` (feat)
3. **Catalog scan: the gate adapter listed among the files that carry tools** - `8562192` (test; found by the full run, see below)

**Plan metadata:** the commit that adds this SUMMARY.

## Verification

Each run inside the cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

- Fold-in: `tsc` + `gateDecide` + `gateRecords`: 27 tests, 27 pass, 0 fail.
- Task 1 plan command set plus `gateActivation` and `teamBoundaries`: tsc clean; 80 tests, 80 pass, 0 fail, 0 cancelled (at the Task 1 commit).
- Task 2 plan command set (gateEnumeration, unattendedApproval, approvalStalls, agentLoop, autoApproval): tsc clean; 81 tests, 81 pass, 0 fail, 0 cancelled; `gateEnumeration` alone is now 16 tests, 16 pass.
- Ten parity files in one run (agentLoop, autoApproval, protectedPaths, untrusted, unattendedApproval, approvalStalls, mcp, agentBasics, commandSafety, approvalRisk): 137 tests, 137 pass, 0 fail, with the gate in the loop and no assertion changed.
- Full `npm test` equivalent (`systemd-run ... MemoryMax=6G ... timeout 1800 ... node scripts/run-tests.mjs dist/test/*.test.js scripts/test/*.test.mjs`, after the compile) at the Task 2 commit: 2,962 tests, 2,952 pass, 1 fail, 0 cancelled, 9 skipped. The one failure was `gateManifests`' source scan ("every source file that mentions AgentTool< is in CATALOG_TOOL_FILES"): the new adapter mentions the type, so it was added to `TOOL_CARRYING_FILES` in `toolCatalog.ts` (commit 8562192, no assertion changed). `gateManifests`, `gateMcpManifests`, `toolsPage` and `gateEnumeration` then pass: 75 tests, 75 pass, 0 fail. The 9 skips are existing skips. e2e was not run (the plan does not call for it).
- Acceptance: `git diff cbe4ef3 HEAD -- src/agent/permissions.ts src/test/agentLoop.test.ts src/test/autoApproval.test.ts src/test/protectedPaths.test.ts src/test/untrusted.test.ts src/test/unattendedApproval.test.ts src/test/approvalStalls.test.ts` is empty (autoApproval needed no fixture edit); `grep -c "registerGate(" src/extension.ts` prints 1, at line 129, before `registerTeamMode(` at line 136.

## Deviations from Plan

**1. [Owner fold-in from PR #66's review] An empty effect list fails closed (commit 67ab549)**
- `decide()` gets the rule id `manifest.effects-unknown` (added to `GATE_RULE_IDS`). It is checked after the emergency stop and after the failed-closed bundle check, before the floor, ceiling, labels and the settings layer. With presence person in an interactive context it asks with no "always allow" and no run-wide grant; otherwise it is denied with a plain reason. The settings function is never called (asserted by a call counter).
- **Exception to "regardless of bundle state":** under a failed-closed bundle an empty list is still refused by `bundle.failed-closed` with the bundle's own sentence, not asked. The existing assertion in `gateDecide.test.ts` ("a failed-closed bundle ... denies everything else", which includes an empty list) says so, and asking past a failed bundle would let a person approve something the bundle forbids. The outcome never reaches the settings layer in either state.
- No tool legitimately produces an empty list: every one of the 40 built-in tools declares at least one effect template of its own (so `effectsFor` is empty only for a manifest of only `{ from: 'command' }`, which the format cannot express), and `gateToolCall` never hands `decide()` an empty list while the floor is shadow (see deviation 3). A test walks `builtInTools()`.
- Enum comment in `record.ts` fixed: it now cites OCSF_VERSION (1.9.0) and names `unmapped.nearAi.outcome` (the exact path in the built record; the test in `gateRecords.test.ts` already reads it). I also read the enums from the live 1.9.0 schema (`https://schema.ocsf.io/api/1.9.0/classes/api_activity`): action_id has 0 Unknown, 1 Allowed, 2 Denied, 3 Observed, 4 Modified, 99 Other; disposition_id includes 1, 2, 3 Quarantined, 8 Approved, 25 Rejected, 26 Unauthorized, 99; status_id 0, 1, 2, 99. The old comment's claim "there is no 3" for action_id was a 1.3.0 fact and is not true of 1.9.0 (3 is Observed). The record still writes an ask as 99 Other (not 3 Observed, which the research table first proposed); I changed only the comment and kept the values, so no stored shape changes. **Owner decision:** whether an ask should be written as action 3 Observed instead of 99 Other.
- Tests: `gateDecide.test.ts` gets 3 new tests; **one assertion changed on purpose:** `GATE_RULE_IDS.length === FLOOR_RULE_ORDER.length + 5 + ...` became `+ 6` and the list of expected ids gains `manifest.effects-unknown` (the new rule id).

**2. [Rule 2 - Missing critical] Absolute paths inside the project are read as project paths (gateAdapter `manifestArguments`)**
- Models often send a full path. The vocabulary refuses a leading `/`, so `effectsFor` would have refused every such Write or Read and the floor would have seen nothing. The adapter now writes an absolute path inside the call's own folder (a worktree sub-agent's, not the project's) relative to it before `effectsFor`. A path outside the folder stays as it is and is refused.

**3. [Rule 2 - Missing critical] A call whose effects cannot be filled**
- `effectsOfCall`: with the floor in shadow the widest form of the tool's own shorthand (`fromActionCapability`, "never nothing") stands in, so today's decision is kept (tested: a Read of a path outside the project is still allowed); with the floor enforced (`floorMode 'enforce'`) the list is empty and `manifest.effects-unknown` asks or refuses. **Note for plan 17:** when the floor is enforced, a legitimate read of a trusted root outside the project (the Open-GSD home, the person's teams folder) reaches `effects-unknown` unless the manifest or the adapter learns about trusted roots.

**4. [Rule 3 - Blocking] `GateRuntime` gained three optional fields** (`productVersion`, `clock`, `newRecordId`) in `src/domain/gate/decide.ts`, because the pure domain cannot know the product version or make an id and the adapter (no vscode, not in `src/gate`) builds the record.

**5. [Rule 3 - Blocking] The host reaches the chat through constructor arguments, not a module global:** `NearAiPanelViewProvider(context, auth, gateHost?)` to `attachChatToView(..., gateHost?)` to `conversationFor(..., gateHost?)` (files outside the plan's list: `panelView.ts`). All new parameters are optional, so the existing tests that build these without a host are unchanged.

**6. [Order] TDD red/green were not separate commits.** The loop, adapter and host were written together and the tests written against them; each task's verify command was run green before its commit.

**7. [Note] Task 1 / Task 2 split of the code.** The commits were produced by writing the whole change and then splitting it: Task 1 holds the host, adapter (decide, settings layer, recording, default runtime), loop gate call, activation and the main-run runtime; Task 2 adds `recordApprovalReply`, `recordLateApproval`, the sub-agent runtime and the card answer path. Task 1's own tracer test therefore expects only the `asked` record, and Task 2 changes that test file's tracer assertion to `asked` then `approved` (the only existing assertion of mine edited; it is the plan's own test).

**Total deviations:** 7 (1 owner fold-in, 2 missing-critical, 2 blocking, 2 notes). **Impact:** none on a decision with a valid bundle.

## Assertions changed on purpose

1. `src/test/gateDecide.test.ts`: the rule-id count `+ 5` became `+ 6` and the id list gained `manifest.effects-unknown` (new rule id, see deviation 1).
2. `src/test/gateEnumeration.test.ts` tracer: at Task 2 the expected records changed from `[asked]` to `[asked, approved]` (the answer is now recorded). This is a test created by this plan.

No assertion in any pre-existing test other than gateDecide's count changed.

## Decisions Made

See key-decisions. Left open or for later plans:

- **Folder-path coverage in gate path matching (70-08) is still open.** This plan only changes absolute-to-relative conversion; it does not decide whether a folder name such as `src` covers `src/**`. A Glob or Grep given a folder passes it as written, and the floor's text and glob checks see the folder name only.
- The MCP carry-forward is honoured: an MCP tool's effects come from its manifest, its contexts go in as `manifestContexts` (so an interactive-only MCP tool is refused in a non-interactive context) and the unattended-MCP ceiling applies to its `mcp` effect; the settings layer still gets the tool's `capability`, never `McpToolEffects.shorthand`. The default bundle allows every verb in `interactive` and `unattended`, so no MCP decision changes today.
- `ensurePolicyBundle` / `DecisionLog` are now called at activation (start) and per run (log); `resetPolicyToDefaults` is behind `GateHost.reset()` but no command calls it yet (the Reset Policy to Defaults command is for a later plan).
- Production `AgentRun` constructions: `agentSession.ts` (main, sub-agent) pass `gate` through the conversation's host; `src/benchmark/runner.ts` builds an `AgentRun` and passes none, so it uses `defaultGateRuntime` today. Plan 13's source scan should decide whether the benchmark runner gets an explicit gate.
- Rule ids for settings answers are exact for every capability except a few shell cases inside Auto (an allow after the classifier said "unknown" is named `settings.unattended-verification` when the run is unattended and `settings.safety-model` otherwise, and the three taint holds all read `taint.held`), because telling them apart exactly would need reading `decidePermissionAsync`'s reason text, which the plan forbids. The decision itself is always exactly today's.

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None new. T-70-39 (a card answered after an emergency stop or bundle failure): `recordApprovalReply` re-asks before the call runs, tested for both. T-70-40 (sub-agent presence): the host receives `presence: 'person'`, `context: 'interactive'` for the lead and every sub-agent, tested through a recording host. T-70-42 (silent behaviour change): the shadow floor and the ten parity files pass unchanged; the fail-closed change is tested and named. T-70-SC: no package added.

## Next Phase Readiness

Plan 13 can scan that every production `new AgentRun(` passes `gate` (the two in `agentSession.ts` do; the benchmark runner does not), gate the remaining execution paths (cyber, MCP direct calls, Open-GSD runtime) and extend `gateEnumeration.test.ts`. Plan 17 flips `floorMode` to `enforce` in `agentSession.ts` (two call sites) and must handle the trusted-roots reads noted in deviation 3.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*

## Self-Check: PASSED

- FOUND: src/gate/host.ts, src/agent/gateAdapter.ts, src/services/gateCommands.ts, src/test/gateEnumeration.test.ts, src/test/gateActivation.test.ts
- FOUND commits (ancestors of HEAD): 67ab549, 1d62946, 737c207, 8562192
