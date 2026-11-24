---
status: awaiting_human_verify
trigger: "Fix five failing security-boundary checks on feat/phase-32.1-engine (deferred-items.md rows 1-5)"
created: 2026-11-24T00:00:00Z
updated: 2026-11-24T00:00:00Z
---

## Current Focus

hypothesis: confirmed, five independent causes (see Resolution)
test: revert-and-reconfirm done; broad setup, gate, architecture and copy-lint run
expecting: owner approves the two list entries (PROCESS_IMPORTERS networkFacts.ts, REQUEST_SITES testRequest.ts)
next_action: owner reviews the two list entries in the integration PR; then archive this session and add the knowledge-base entry
bug_class: Bohrbug (all five are deterministic static or unit checks)

## Symptoms

expected: gateEnumeration, gateRouteGuard (2 CLAS-06 tests), gateRouteTiers D-37, gateActivation fail-closed all pass
actual: networkFacts.ts unlisted process importer; localServersOption.ts and testRequest.ts unlisted request sites; D-37 source assertion missing; activation state valid instead of failed-closed
errors: see deferred-items.md table
reproduction: npm run compile && node scripts/run-tests.mjs dist/test/gateEnumeration.test.js dist/test/gateRouteGuard.test.js dist/test/gateRouteTiers.test.js dist/test/gateActivation.test.js
started: Codex integration commits 3b79b639, plans 03/04, 88b93ca5, and an activation-order change

## Eliminated

## Evidence

- timestamp: 2026-11-24
  checked: gateEnumeration.test.ts PROCESS_IMPORTERS and src/services/setup/networkFacts.ts
  found: networkFacts.ts imports node:child_process only for readHostNetworkFacts (host binding); the fixed commands, shell false, 3 s, 64 KB and tmpdir cwd are in readNetworkFacts and covered by setupScan.test.ts. Plan 06 intended the host to pass execFile. No listed module is a general fixed-argument runner (cyberTools and security/runtimes are --version probes).
  implication: routing through an existing listed module would make that module's reviewed reason false; the honest fix is a listed entry with its reason (gate change for owner approval)

- timestamp: 2026-11-24
  checked: gateRouteGuard.test.ts REQUEST_SITES and siteViolations; testRequest.ts, localServersOption.ts, nearAiOption.ts, guideFacts.ts
  found: runTestRequest calls client.completeOnce with no session route, so the request is decided by the default route (host.sessionRouteWithoutContext: the focused folder's policy and log, actor no-session), not the Get Started run's project. localServersOption.ts makes its own completeOnce call through a delegating wrapper.
  implication: give runTestRequest a required route and wrap its one request in withSessionRoute; supply the route from the guide check (the project's runtime); localServersOption passes its client instead of wrapping completeOnce

- timestamp: 2026-11-24
  checked: extension.ts configureApiKey after 88b93ca5
  found: the D-37 prompt's validator became validEndpoint(value.trim()) where validEndpoint = scoped ? isLoopbackConnection : isSecureEndpoint. isLoopbackConnection is a strict subset of isSecureEndpoint, so no URL was loosened, but the D-37 prompt no longer states its validator directly.
  implication: give the scoped (Get Started) prompt its own input box with the loopback check and keep the D-37 prompt's validator as isSecureEndpoint(value.trim())

- timestamp: 2026-11-24
  checked: reproduced all five on 7eadb470 (120 tests, 5 fail); traced the first clock read of registerGate with a stack-printing clock
  found: read 1 is GateHost.now <- clock <- policySetupStep's `get detail` <- fromLegacyStep (domain/setup/steps.ts) <- registerSetupStep <- registerPolicySurfaces, before host.start(). host.now() swallows the throw, so ensurePolicyBundle (read 2) succeeds and the gate is valid.
  implication: fromLegacyStep copies `detail` eagerly. Since 269629cd forwards every legacy step to the guide registry at registration, the Policy step's live getter is read during activation. Also a UX bug: the guide's Policy step detail is frozen at the pre-start sentence. Not 8f47866f.

## Resolution

reasoning_checkpoint:
  hypothesis: "(5) fromLegacyStep reads detail at adapt time, so registering the Policy step reads the gate clock before start; (2,3) the setup test request runs outside every session route because runTestRequest takes no route; (4) 88b93ca5 merged two prompts behind validEndpoint; (1) a new fixed-argument process reader was never listed"
  confirming_evidence:
    - "stack trace of the first clock read goes through fromLegacyStep from registerPolicySurfaces"
    - "siteViolations names testRequest.ts and localServersOption.ts as unlisted request files; neither wraps withSessionRoute"
    - "isLoopbackConnection is a subset of isSecureEndpoint; only the D-37 literal changed"
  falsification_test: "with a lazy detail getter, gateActivation must fail closed; with a route-bound test request and testRequest.ts listed self, CLAS-06 must report nothing; planted counts (5 and 7) must hold"
  fix_rationale: "lazy getter restores activation's read-nothing-before-start order at its source; a required route makes an unrouted test request impossible to write; two prompts keep each check explicit"
  blind_spots: "extension.ts does not yet wire createProjectGetStartedDeps (plan 24), so the route binding is proven at guideFacts level, not end to end"
  candidate_causes:
    - "code: eager getter copy in the domain adapter (chosen)"
    - "environment: the test's fault injection position moved (rejected: the instruction and the invariant say do not move it)"
  and_gate: "no for each row; the five are independent and each has one cause"

root_cause: "1: networkFacts.ts (3b79b639) imports child_process for its host binding and was never put on PROCESS_IMPORTERS. 2/3: runTestRequest (1379c6a7) called completeOnce with no session route, so the default route (focused folder, no session) decided and recorded it; localServersOption.ts also wrapped completeOnce itself. 4: 88b93ca5 replaced the D-37 prompt's isSecureEndpoint check with an indirection shared with the stricter Get Started prompt. 5: fromLegacyStep copied detail eagerly; 269629cd made registerSetupStep forward the Policy step to the guide at activation, reading the gate clock before start."
fix: "1: list networkFacts.ts with its reason. 2/3: TestRequest port on OptionCheckInput; runTestRequest requires a route and wraps its one request in withSessionRoute; guideFacts binds the project's runtime route; sources call input.testRequest; testRequest.ts listed as a self site. 4: two input boxes, each with its own check. 5: fromLegacyStep keeps detail as a getter."
verification:
  target_test: { result: pass, detail: "the five gate tests pass; 12 focused files 291/291" }
  mutation_check: { result: pass, reason_if_skipped: "no Stryker; seeded mutants by hand (scratchpad mutate.py)", mutant_killed: "eager detail -> gateActivation + setupContract fail; unwrapped request -> both CLAS-06 tests (testRequest.ts:30 outside withSessionRoute) + setupViability + getStartedHost fail; validEndpoint indirection with Get Started weakened to isSecureEndpoint -> gateRouteTiers D-37 + setupSteps fail; entry removed -> gateEnumeration fails" }
  no_op_deletion: { result: pass, deletion_justified_by_rca: true, detail: "only deletion is localServersOption's own completeOnce wrapper, replaced by the routed port" }
  adjacent_tests: { result: pass, detail: "tsc --noEmit 0; compile 0; setup* + getStarted* 32 files 417/417; gate* 65 files 1248/1248; architecture + copyLint 42/42" }
  revert_and_reconfirm: { result: pass, detail: "with all fixes reverted 9 of 201 fail, exactly the five gates and the four regression assertions; restored, all pass" }
  guardrail_verdict: accepted
  owner_gate_changes: ["PROCESS_IMPORTERS + src/services/setup/networkFacts.ts", "REQUEST_SITES + src/services/setup/testRequest.ts (self)"]
files_changed: [src/domain/setup/steps.ts, src/domain/setup/servers.ts, src/domain/setup/viability.ts, src/services/setup/testRequest.ts, src/services/setup/nearAiOption.ts, src/services/setup/localServersOption.ts, src/services/setup/guideFacts.ts, src/extension.ts, src/test/gateEnumeration.test.ts, src/test/gateRouteGuard.test.ts, src/test/setupContract.test.ts, src/test/setupViability.test.ts, src/test/getStartedHost.test.ts, src/test/setupSteps.test.ts]
