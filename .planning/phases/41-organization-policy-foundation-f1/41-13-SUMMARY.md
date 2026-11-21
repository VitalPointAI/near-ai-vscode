---
phase: 41-organization-policy-foundation-f1
plan: 13
subsystem: gate routing at the client (privacy inputs, pinned connections, trust line, policy version)
status: complete
tags: [routing, decideRoute, privacy-floor, tee-only, team-mode, tls-pins, protected-b, residency, passport, accredited-device, trust-line, policy-version]
requires: [41-07 (domain/provider/messages.ts), 41-09 (host.policyLayers, PolicyLayersView), 41-10 (RoutePolicy, decideRoute sixth argument, wouldRefuse, notAccredited, pinTo, trustFactsFor, trustLine), 41-12 (architecture baseline)]
provides:
  - src/services/privateRoute.ts (routeFactsFor, RouteFactsInput, PrivateRoute, routeAllows, privateRefusal, PrivateFloor, FloorInputs, floorFor, floorAllowsModel, requestTrust, pinnedFetchAny)
  - src/services/answerFacts.ts (AnswerFacts, answerFactsOf, now carrying usage.trust)
  - gate/sessionMark.ts (SessionRoute.routePolicy, RoutePolicyNow, routePolicyFor, noteNotAccredited, endpointPinRefusal, RouteRecordContext.policyVersion; route records carry policyVersion and wouldRefuse)
  - gate/host.ts (policyVersionOf; runtimeFor and sessionRouteWithoutContext give routePolicy; every sink and event stamps the policy version)
  - domain/gate/decide.ts (GateRuntime.routePolicy)
  - domain/gate/trustBadge.ts (TrustBadgeFacts.trust, TrustBadge.line, TRUST_BADGE_TEXT.allowedNotRecorded, allowedNotKept, placeNotKept)
  - domain/provider/messages.ts (UsageMetadata.trust)
  - domain/team/policy.ts (teamRouteInputs)
  - domain/config.ts (PrivacyModeSetting)
  - NearAiClientOptions.pinnedFetchFor
  - media/chat/trustBadge.js (the line as trust-runs-on, trust-title, trust-allowed spans)
affects: [41-14 (none of its files touched), 41-15 (SECURITY.md can describe the trust line, the pinned send and the policy version), later Team Mode wiring (teamRouteInputs is read side only)]
tech-stack:
  added: []
  patterns: [move verbatim first then change in the new home, route policy carried on the runtime of the host that made it, one key source per authorization list memoized per effective document, host sink stamps records instead of touching a frozen adapter, cyclic module import placed after the exports the other module reads at load]
key-files:
  created:
    - src/services/privateRoute.ts
    - src/services/answerFacts.ts
    - src/test/gatePrivacyFloor.test.ts
    - src/test/gatePolicyVersion.test.ts
  modified:
    - src/services/nearAiClient.ts
    - src/services/agentSession.ts
    - src/gate/sessionMark.ts
    - src/gate/host.ts
    - src/domain/gate/decide.ts
    - src/services/outboundGuard.ts
    - src/services/privacyPreflight.ts
    - src/domain/privacy.ts
    - src/domain/config.ts
    - src/services/teamStudioAi.ts
    - src/services/providerCache.ts
    - src/domain/team/policy.ts
    - src/domain/gate/trustBadge.ts
    - src/domain/provider/messages.ts
    - media/chat/trustBadge.js
    - src/test/gateRouteGuard.test.ts
    - src/test/gateTrustBadge.test.ts
    - src/test/architecture-baseline.json
decisions:
  - "GateRuntime.routePolicy and SessionRoute.routePolicy return RoutePolicy & { policyVersion? } so the client names the version on the request's record from the same call; routePolicyFor returns RoutePolicyNow (version required)."
  - "routePolicyFor gives undefined when there is no effective policy, a failed layer, or a failed organization layer (fail closed to the safety patch's decision). Authorizations are verified against your organization's people.signers when its layer is valid (this device passed only as thisDevice, so it counts only when listed), otherwise this device's key alone (the personal layer's issuer). The verified list is memoized per effective document for 60 seconds and recomputed when the key source changes; coverage and expiry are still judged per request by decideRoute."
  - "policyVersionOf: bundle-1 for no effective policy, any failed layer or a failed organization layer; bundle-2 for a valid organization layer or a stored personal payload with bundleVersion 2; bundle-1 otherwise."
  - "The host's routePolicy never throws (a throw gives undefined); a route policy function given by any other caller that throws is a failed route check in the client, as the plan says."
  - "The OutboundGuard preview uses the model's own client: this computer (loopback, local client) for a catalogue entry marked local, NEAR AI Cloud's endpoint otherwise, both with a fresh bound fact. The plan says NEAR's endpoint for every model; that would refuse a local model under tee-only, which today allows it (see Deviations)."
  - "The floor preview runs after the preflight call and before its allow return, where the old tee-only branch effectively decided, so emergency stop, the spend limit and the data-class checks with their one-time override are unchanged."
  - "floorFor returns a frozen object with only the keys that say something ({} for no floor); an allowedModels list is copied, so a caller's later change to its own array changes no floor."
  - "The accredited-device notice: a decision with allowedBy (every allowed decision made with a policy) names its own label through notAccredited; without a policy the patch's thisComputerOnlyLabelOf rule stays."
  - "A connection that matches none of the pins is refused as route.endpoint-pin by endpointPinRefusal in sessionMark.ts (recorded with the request's context, policy version included); the client only turns it into RouteRefusedError. A pinned fetch hook that throws when built is refused the same way."
  - "Trust line words: the line's runsOn part keeps trustLine's own 'Runs on ...' wording (41-10). New fixed words in TRUST_BADGE_TEXT: 'What allowed it was not recorded' (no TrustFacts), 'What allowed it is not kept for an answer shown again' and 'Where it ran is not kept for an answer shown again' (replay of a Not verified record)."
  - "The page draws the line only when runsOn, verified, allowed and text are all strings (runsOn and verified non-empty); separators are aria-hidden spans; the accessible name is 'Trust: {title}. {line text}. Show details'."
  - "trustBadge.ts imports trust.ts after defining TRUST_BADGE_STATES, which trust.ts reads at load, so either module can be loaded first; a test loads them in both orders from a fresh module cache."
  - "The host stamps the version with a private withPolicyVersion(record, version) on a copy; the record handed to the sink is not changed in place."
metrics:
  duration: ~2h
  completed: 2026-11-20
actuals:
  tokens: 37540
  tasks: 5
  commits: 9
plan_head_before: 482aed5dfaaca7c800597c29b292ada1c4196611
plan_head_after: 5be67511
---

# Phase 41 Plan 13: Privacy inputs through decideRoute, the trust line Summary

Every real model request is now decided by decideRoute with your organization's effective policy, read from the gate host that made the request's route. Every way of asking for private-only work goes through one floor (floorFor). Protected B goes to your organization's server only over a connection held to that server's TLS pins. Reports (passport, accredited device) and the policy version are on every record. Each answer's badge shows the three-part trust line.

## Base check (Task 1)

All checks passed at 482aed5d: `export interface RoutePolicy` 1, `export function trustFactsFor` 1, `public policyLayers(` 1, `wouldRefuse` in record.ts 10, `export function withPrivateOnly` 1, `PRIVATE_MODEL_LABEL` in chatBridge.ts 2, messages.ts and architecture-baseline.json present. Starting sizes: nearAiClient.ts 1861, agentSession.ts 2754. Final sizes: 1860 and 2708 (re-recorded in the baseline).

## Tasks

| Task | Name | Commits | Main files |
|------|------|---------|------------|
| 1 | Tracer: the effective policy reaches decideRoute in the client | d3196e67 (moves), 83ff4997 | privateRoute.ts, nearAiClient.ts, sessionMark.ts, host.ts, decide.ts, gateRouteGuard.test.ts |
| 2 | One floor: privacyMode, private members and agent teams, Team Mode, OutboundGuard preview | 39ba7f50 (moves), a1ad4884 | privateRoute.ts, outboundGuard.ts, privacyPreflight.ts, config.ts, privacy.ts, teamStudioAi.ts, providerCache.ts, team/policy.ts, gatePrivacyFloor.test.ts |
| 3 | Protected B over the pinned connection, residency and reports, the accredited notice | 9ebdb144 | privateRoute.ts, nearAiClient.ts, sessionMark.ts, gateRouteGuard.test.ts |
| 4 | The trust line on every badge | 885b7387 (moves), 7d5ed082 | answerFacts.ts, agentSession.ts, nearAiClient.ts, messages.ts, trustBadge.ts, media/chat/trustBadge.js, gateTrustBadge.test.ts |
| 5 | Every record carries the policy version | d0c5a540 | host.ts, gatePolicyVersion.test.ts |
| - | Smaller frozen sizes recorded | 5be67511 | architecture-baseline.json |

Tracer gate (Task 1): the tracer's verify set was run end to end after commit 2 (101 of 101, architecture included) before Task 2 started.

Moves were verbatim and committed alone: the RouteFacts block of checkRoute into routeFactsFor, noteNotAccredited into sessionMark.ts, PrivateRoute/routeAllows/privateRefusal into privateRoute.ts (agentSession.ts re-exports routeAllows and PrivateRoute), AnswerFacts/boundaryFromPrivacy/answerFactsOf into answerFacts.ts (agentSession.ts re-exports answerFactsOf). The only edits in the moved code were `export` keywords.

## Tests written first (RED)

- Task 1, on the Task 1 move commit: tsc failed (no `policyVersionOf` in host, no `routePolicyFor` in sessionMark, no `routePolicy` on SessionRoute or GateRuntime).
- Task 2, on the Task 2 move commit: tsc failed (no `teamRouteInputs`, `floorFor`, `floorAllowsModel`). The two client floor tests ("through the client ...") keep S4's behaviour and are guards, not red behaviour.
- Task 3, on the Task 2 code: tsc failed (no `pinnedFetchAny`, no `pinnedFetchFor` option). The regression test (Protected B to an exact https host with no pin) passes behaviourally from Task 1 on, since decideRoute already refuses it once the client passes the policy; on the plan's base (482aed5d) the client sends it.
- Task 4, on the Task 4 move commit: tsc failed (no `trust` on TrustBadgeFacts, no `line` on TrustBadge, no `allowedNotRecorded`).
- Task 5, on the Task 4 code: 4 of 7 failed as intended (tool call, mark raise and refusal before the gate, label and policy events, and the deep-equal stamp test all said bundle-1 under your organization's layer). The model-request test already passed (Task 1 puts the version on route records); the starting-rules and failed-closed tests are guards.

## Verification

All runs used the memory wrapper and the shared lock.

- Task 1 set (gateRouteGuard, gateRouteTiers, gateHostStart, gateOrganizationStore, architecture): 101/101.
- Task 2 set (gatePrivacyFloor, outboundGuard, privacyPreflight, teamStudioAi, teamPrivacy, privateMembers, gateRouteTiers, architecture): 89/89. The existing outboundGuard, privacyPreflight, teamStudioAi, teamPrivacy and privateMembers tests are unchanged.
- Task 3 set (gateRouteGuard, gateRouteTiers, gateConnectionBinding, gatePrivacyFloor, architecture): 110/110.
- Task 4 set (gateTrustBadge, gateTrustFacts, gateConnectionBinding, gateRouteGuard, providerEndpoint, architecture, copyLint, gateChatLabel, attestation): 223/223; `npm run lint` exit 0.
- Task 5 set (gatePolicyVersion, gateRecords, gateRecordIds, gateHostLogs, gateOrganizationStore, gateRouteGuard, architecture): 109/109; lint exit 0.
- Gate set (every gate*.test.js, teamBoundaries, replicaBoundaries, teamSecrets, teamSignedPayload, architecture, copyLint): 1280/1280.
- Touched agent, session and chat tests (outboundGuard, privacyPreflight, teamStudioAi, teamPrivacy, privateMembers, chatBridge, nearAiClient, providerEndpoint, attestation, config, chatMultimodal, conversations, autoApproval, subagentFallback, roleModels, policyGate, agentLoop, chatSendPath, modelComparisonPage, capabilityRouter, runGuards): 228/228. Team Studio and provider tests (teamStudio, teamStudioPage, providerFactory, participantRecord): 189/189.
- Final `npm run lint`: exit 0. `node scripts/secret-scan.mjs --range 482aed5d..HEAD`: clean.
- New test counts: gateRouteGuard +14 (Task 1: 5, Task 3: 9), gatePrivacyFloor 8, gateTrustBadge +8, gatePolicyVersion 7.
- Acceptance greps: `routePolicy` in nearAiClient.ts 1; `export function routePolicyFor` 1; `routePolicyFor` in host.ts 2; `export function floorFor` 1; `export function routeAllows` in agentSession.ts 0; `SovereigntyMode` in config.ts 0; `mode: settings.privacyMode` in outboundGuard.ts 0; `export function pinnedFetchAny` 1; `pinTo` in nearAiClient.ts 4; `export function answerFactsOf` in answerFacts.ts 1; `trust-runs-on` in trustBadge.js 1; `trustLine` in trustBadge.ts 5; `policyVersionOf` in host.ts 6; `git diff --quiet feat/phase-41-foundation -- src/agent/gateAdapter.ts` succeeds.
- Not run (orchestrator runs them once): the full `npm test` and e2e.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The OutboundGuard preview would have blocked local models under tee-only**
- **Found during:** Task 2.
- **Issue:** The plan's preview uses NEAR AI Cloud's endpoint for every model. decideRoute then refuses a catalogue entry marked local (route.not-tee), but tee-only mode allows local models today and the private floor's own words say "verified private hardware or this computer".
- **Fix:** the preview asks decideRoute with the model's own client: a local client on loopback for a local entry, NEAR AI Cloud otherwise, both with a fresh bound fact. Results for TEE, local, forwarded and unknown models are exactly today's, and a test compares the guard with decideRoute for each.
- **Files modified:** src/services/outboundGuard.ts
- **Commit:** a1ad4884

**2. [Rule 1 - Bug] Load order of trustBadge.ts and trust.ts**
- **Found during:** Task 4.
- **Issue:** trust.ts reads TRUST_BADGE_STATES at load. Once trustBadge.ts imports trustLine, loading trustBadge.ts first would have run trust.ts before TRUST_BADGE_STATES existed.
- **Fix:** the value imports of trust.ts and labelAlgebra.ts in trustBadge.ts come after the states (type imports stay at the top). A test loads the two in both orders from a fresh module cache.
- **Files modified:** src/domain/gate/trustBadge.ts, src/test/gateTrustBadge.test.ts
- **Commit:** 7d5ed082

**3. [Rule 2 - Correctness] routePolicyFor fails closed on any failed layer**
- The plan says "undefined unless layers.effective is present". It also returns undefined when a layer failed or your organization's layer failed, so a self-signed authorization can never count while your organization's rules cannot be read.

### Plan wording adjusted to the shipped code

- The plan's trust-line example writes `runsOn 'NEAR AI private hardware'`. 41-10's trustLine returns `runsOn: 'Runs on NEAR AI private hardware'`, and the joined text starts with "Runs on". The tests assert the shipped words.
- org/Confidential shows as "Organization: Sensitive" (its display name), so the session test expects "Allowed for Organization: Sensitive".
- The record keeps a refusal sentence cut to the record's reason length, so the endpoint-pin record test checks that the kept text is a prefix of the sentence.

### Choices taken on defaults

Listed in the frontmatter `decisions`. No checkpoint was reached. All 41-CONTEXT defaults stand: D-34 (report unless your organization's switch is on), D-42 (passport report only), D-54 (no project on a route, so project-scoped authorizations cover nothing), D-37 (teamRouteInputs is read side only).

### Files outside files_modified

- `src/test/architecture-baseline.json`: re-recorded with NEAR_AI_WRITE_BASELINE=1 after the moves. Only the two frozen sizes changed (agentSession.ts 2754 to 2708, nearAiClient.ts 1861 to 1860); no violation line changed.

## Known Stubs

- `teamRouteInputs` (src/domain/team/policy.ts) is wired nowhere on purpose (D-37): no call site reads Team Mode policy for a model request yet. floorFor and decideRoute already accept its output, and tests cover it.

## Threat Flags

None beyond the plan's register:
- T-41-130: the pinned send, the every-pin-mismatch refusal and the regression test.
- T-41-131: routePolicy travels on the runtime and session route of the host that made them; host test.
- T-41-132: the signers-only and this-device-only tests, a stranger's signature left out.
- T-41-133: the floor decides in checkRoute; the OutboundGuard preview equals decideRoute's answer.
- T-41-134: wouldRefuse on route records, policy version on every record.
- T-41-135: the line's verified part is the badge's state, even when the TrustFacts claim more.
- T-41-SC: no package was installed.

## Self-Check: PASSED

- Files: src/services/privateRoute.ts, src/services/answerFacts.ts, src/test/gatePrivacyFloor.test.ts and src/test/gatePolicyVersion.test.ts exist; every modified file listed above is in the branch diff.
- Commits d3196e67, 83ff4997, 39ba7f50, a1ad4884, 9ebdb144, 885b7387, 7d5ed082, d0c5a540 and 5be67511 are ancestors of HEAD on feat/phase-41-13-privacy-inputs.
