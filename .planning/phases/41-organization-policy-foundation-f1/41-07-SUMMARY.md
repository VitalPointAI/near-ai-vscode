---
phase: 41-organization-policy-foundation-f1
plan: 07
subsystem: provider interface (agent to AI service seam)
status: complete
tags: [provider, model-endpoint, local-server, domain-boundary, refactor]
requires: [41-01]
provides:
  - src/domain/provider/messages.ts (ChatMessage, ToolCall, AgentMessage, ToolDefinition, CompletionEvent, ModelInfo, VerificationStatus, UsageMetadata, ResponseEvidence)
  - src/domain/provider/endpoint.ts (ModelEndpoint, EndpointFacts)
  - src/domain/provider/localServer.ts (LocalServerAdmin, LocalModelRef, LocalInstallRequest; interface only)
  - NearAiClient implements ModelEndpoint, with a frozen facts getter
affects: [41-12 (architecture baseline loses the threadView and threadCapture leaks), 41-13 (later adapters and decideRoute), 32.2 (local servers implement LocalServerAdmin)]
tech-stack:
  added: []
  patterns: [types moved verbatim and re-exported from the old module, agent depends on Pick<ModelEndpoint, ...>, kind as data]
key-files:
  created:
    - src/domain/provider/messages.ts
    - src/domain/provider/endpoint.ts
    - src/domain/provider/localServer.ts
    - src/test/providerEndpoint.test.ts
  modified:
    - src/services/nearAiClient.ts
    - src/services/attestation.ts
    - src/agent/loop.ts
    - src/agent/context.ts
    - src/agent/safetyModel.ts
    - src/domain/state/threadView.ts
    - src/domain/state/threadCapture.ts
decisions:
  - "EndpointFacts.route is optional, as the plan says (RESEARCH sketched it required): a client built with no route has no route key in its facts, matching the route check that refuses such a client at every stricter level."
  - "SafetyModelClient became a type alias (Pick<ModelEndpoint, 'completeOnce'>) under the same exported name; nothing implements or extends it, and autoApproval.test.ts compiles unchanged."
  - "loop.ts stays within its frozen size by removing two surplus blank lines and the CompletionEvent import it no longer uses."
  - "The domain/provider boundary test requires all three files to exist and copies the three teamBoundaries scanner patterns (not imported, so its tests do not register twice)."
metrics:
  duration: 21m
  completed: 2026-11-20
  tasks: 3
  files: 11
actuals:
  tokens: 21000
  tasks: 3
  commits: 2
plan_head_before: ce786119bcb5b7bd1016ed5ae49029d277c58bda
plan_head_after: f11205de
---

# Phase 41 Plan 07: Provider interfaces ModelEndpoint and LocalServerAdmin Summary

The chat message types now live in a pure `src/domain/provider` folder, `ModelEndpoint` and `EndpointFacts` describe what the agent needs from any AI service, `NearAiClient` is the first adapter with one frozen `facts` getter and no other change, `LocalServerAdmin` is declared for 32.2, and the agent loop, context, safety model and both domain state files no longer import the NEAR AI client file.

## Base check

- `PRIVATE_FLOOR_TEXT` in `src/domain/gate/routing.ts`: 2 (expected at least 1).
- `ENDPOINT_CLASSES` in `src/domain/gate/endpoints.ts`: 3 (expected at least 1).
- `^export interface ChatMessage` in `src/services/nearAiClient.ts`: 1 (expected 1).
- Starting sizes: `nearAiClient.ts` 1950 lines, `agent/loop.ts` 1124 lines.

## Sizes

| File | Start | End |
|------|-------|-----|
| src/services/nearAiClient.ts (frozen) | 1950 | 1861 |
| src/agent/loop.ts (over 800) | 1124 | 1123 |

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Tracer: domain types and ModelEndpoint, NearAiClient as the adapter, fake endpoint drives the loop | baaddbc7 | messages.ts, endpoint.ts, nearAiClient.ts, attestation.ts, loop.ts, providerEndpoint.test.ts |
| 2 | Four remaining import sites, LocalServerAdmin, domain/provider boundary | f11205de | localServer.ts, context.ts, safetyModel.ts, threadView.ts, threadCapture.ts, providerEndpoint.test.ts |
| 3 | Proof of no behaviour change | (no commit: verification only, no source change needed) | none |

## Tests written first (RED on the base)

- Task 1, on the unchanged base: `tsc` failed with `Cannot find module '../domain/provider/endpoint'`, `Cannot find module '../domain/provider/messages'` and `Property 'facts' does not exist on type 'NearAiClient'`, so all three Task 1 tests could not run.
- Task 2, on the Task 1 code: 6 tests, 4 pass, 2 fail: "the agent and domain state files import the provider types from src/domain/provider" (`agent/context.ts imports no type from the NEAR AI client file`) and "src/domain/provider imports only src/domain and no package" (`src/domain/provider/localServer.ts exists`). The LocalServerAdmin test was then added with the file it needs.
- Refused side and allowed side: facts hold exactly route, baseUrl and nearEndpoint (no key), are frozen and refuse assignment; a client with no route has no route key; the boundary scan reports a planted services import, an editor import, a package and a dynamic require, and ignores a comment and allowed domain and `node:crypto` imports; `verifyHash` fakes refuse a wrong hash and an unknown hash.

## Verification runs (all under the memory cap and the shared lock)

- Task 1: providerEndpoint, rateLimits, nearAiClient: 34 tests, 34 pass.
- Task 2: providerEndpoint, autoApproval, threadLog, threadReplay: 66 tests, 66 pass (providerEndpoint has 7 tests).
- Task 3: providerEndpoint, nearAiClient, rateLimits, autoApproval, subagentFallback, contextDiscipline, spendCapture, gateRouteGuard, gateTrustBadge, threadLog, threadReplay, chatBridge: 208 tests, 208 pass; `npm run lint` exit 0.
- Gate set (gate*, teamSignedPayload, teamBoundaries, replicaBoundaries, staffObs*): 1031 tests, 1031 pass.
- Agent loop suites (agentLoop, agentFleet, agentBasics, agentTools): 54 tests, 52 pass, 2 skipped (pre-existing ripgrep-not-installed skips in agentTools), 0 fail.

## Acceptance checks

- `implements ModelEndpoint` in nearAiClient.ts: 1. `^export interface ChatMessage` in nearAiClient.ts: 0. `^export interface ResponseEvidence` in attestation.ts: 0. `export type {` in nearAiClient.ts: 1.
- `services/nearAiClient` in the five consumer files: 0 files. `interface LocalServerAdmin` in localServer.ts: 1.
- `src/domain/provider` imports only `../capabilities`, `../gate/routing` and `./messages` (all type-only).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] loop.ts would have grown by one line**
- **Found during:** Task 1
- **Issue:** the second import line (`ModelEndpoint`) took loop.ts to 1125 lines, above its frozen 1124.
- **Fix:** removed two surplus consecutive blank lines after the imports and the now-unused `CompletionEvent` import name. No code line changed.
- **Files modified:** src/agent/loop.ts
- **Commit:** baaddbc7

**2. [Rule 1 - Bug] safetyModel.ts lost the AgentMessage import it still uses**
- **Found during:** Task 2 (first compile)
- **Fix:** kept `AgentMessage` in the type import from `../domain/provider/messages`.
- **Files modified:** src/agent/safetyModel.ts
- **Commit:** f11205de

Also: the unused `CapabilityMetadataStatus` and `CapabilityModality` names were dropped from nearAiClient.ts's capabilities import, since only the moved `ModelInfo` used them.

No file outside the plan's files_modified was touched. No Phase 32 file was touched.

## Threat Flags

None. `EndpointFacts` carries route, base URL and a boolean only (T-41-71, asserted by the exact key list in the test); no request path changed (T-41-72, Task 3 suites).

## Known Stubs

None. `EndpointFacts.endpointId` is declared and deliberately never set in this phase (the plan says a later caller that knows the policy endpoint id fills it). `LocalServerAdmin` is interface only by design; 32.2 implements it.

## Self-Check: PASSED

- FOUND: src/domain/provider/messages.ts, src/domain/provider/endpoint.ts, src/domain/provider/localServer.ts, src/test/providerEndpoint.test.ts
- FOUND: baaddbc7, f11205de (ancestors of HEAD)
