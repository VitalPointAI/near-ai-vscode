---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 19
pr: 4a
subsystem: gate (routing)
status: complete
tags: [gate, routing, CLAS-06, CLAS-05, OFFL-01, GATE-07, records]
requires: ["70-18 (PR #76, merged)"]
provides:
  - "src/gate/sessionMark.ts: SessionRoute, sessionRouteFrom, routingOf, withSessionRoute, currentSessionRoute, setDefaultSessionRoute, defaultSessionRoute, routeRecordFor, recordedModelName"
  - "src/services/connectionBinding.ts: ConnectionBindingSource (interface only)"
  - "routing.ts: CONNECTION_BINDING_STATES, ConnectionBindingFact, BINDING_MAX_AGE_MS, isBindingFresh, BINDING_REFUSALS, routingWhileFailedClosed, ROUTE_EVENT_IDS, route.default-session, route.connection-not-bound"
  - "nearAiClient.ts: CONTENT_PATHS, NearAiClientOptions.route/.binding/.localModelAvailable, RouteRefusedError, UsageMetadata.connection, the route check and its record in request()"
  - "LABEL_EVENT_IDS, policy.edit, SHIPPED_DEFAULT_LABEL, record fields mark/attestation/connection, GateHost.sessionRouteWithoutContext, NO_SESSION_ID"
affects: [70-28a, 70-20, 70-21, 70-22, 70-24, 70-25, 70-26]
tech-stack:
  added: []
  patterns: ["AsyncLocalStorage session route (the withSpendTag pattern)", "one route check at the client's choke point", "source scans as the single invariant check"]
key-files:
  created: [src/gate/sessionMark.ts, src/services/connectionBinding.ts, src/test/gateRouteGuard.test.ts]
  modified: [src/domain/gate/routing.ts, src/domain/gate/bundle.ts, src/domain/gate/labels.ts, src/domain/gate/decide.ts, src/domain/gate/record.ts, src/services/nearAiClient.ts, src/services/providerFactory.ts, src/gate/host.ts, src/services/gateCommands.ts, src/services/agentSession.ts, src/services/chat.ts, src/services/chatParticipant.ts, src/services/teamStudioPanel.ts, src/services/cyberAssembly.ts, src/services/cyberHandoff.ts, src/benchmark/runner.ts, src/extension.ts, src/test/gateRouting.test.ts, src/test/gateRecords.test.ts, src/test/gateRecordIds.test.ts]
decisions:
  - "An allowed request outside every session is route.default-session, decided inside decideRoute from a new RouteFacts.sessionless flag, so the pure function stays the one place a route rule comes from."
  - "With no default route set (no gate host), the fallback route reads as failed closed ('unavailable'): the default label routes as today, anything labelled stays on this computer, nothing is recorded."
  - "An infer record keeps the connection state only when the tier read it (attested-cloud); a short record has no reason, no tier beside the capability's, and no label at the default mark."
  - "A model id that is a path or an address is recorded as its last part, so a local runtime that names a model by its file never puts a folder or host on record."
metrics:
  duration: "about 2.5 hours"
  completed: 2026-11-17
pr4a_base: f668c23d39041fa5b8e7db40ba8f09c8fcc283cb
plan_head_before: f668c23d39041fa5b8e7db40ba8f09c8fcc283cb
plan_head_after: 8518e8420674030f5dd2d6239ef073f09f33f3fe
commits: 3
actuals:
  tokens: 37000
  tasks: 3
  commits: 3
---

# Phase 70 Plan 19: The route check at the client, a session route around every model request, and a record for every model request (PR 4a) Summary

Every content request (a POST to /chat/completions, /images/generations, /images/edits or /audio/transcriptions) is now decided once inside `NearAiClient.request`, from the session route it runs inside and local facts only, before the spend check, before a concurrency slot and before the first byte; a refusal throws `RouteRefusedError` with a plain sentence, and every request, allowed or refused, leaves one `infer` record. Attested-cloud levels need a fresh bound connection fact that no client can have yet, so they route local-only (D-50). On a fresh install every mark is org/Public (any-cloud), so nothing changes where a request goes.

## Base

- PR4A_BASE: `f668c23d39041fa5b8e7db40ba8f09c8fcc283cb` (origin/main, the 0.4.29 release), which contains PR #76's squash commit `2e287a8e7fedc0ee9bce5e7499e7a1be6567248a` (checked with `git merge-base --is-ancestor`).

## Commits

| Task | Commit | What |
|---|---|---|
| 1 (tracer) | `ca04772` | feat(gate): the route check at the client's one choke point, with attested-cloud held to a proven binding |
| 2 | `2aa0604` | feat(gate): every model request runs inside a session route |
| 3 (tdd) | `8518e84` | feat(gate): every model request leaves a record, and part 4's ids are named |

Every new test was seen failing first: each task's tests were run with the production change disabled in place (the check call, the binding rule, the wraps, the route kinds, the record write and the id lists replaced by no-ops), the failures recorded, then the code restored and the tests run green. Task 1: 4 failing of 20; the factory test: 1 of 2; Task 2: 5 of 7; Task 3: 11 of 35.

## What was built

- **The route check** (`nearAiClient.ts` `checkRoute`): reads `currentSessionRoute()` or the default route, builds `RouteFacts` from the client's route kind, its base URL, `isNearCloudEndpoint`, the model's entry in this client's own cached catalog, the route's attestation state, the binding fact held in memory (`{ state: 'unknown' }` with no source or a throwing one), the route's clock and `localModelAvailable`; calls `decideRoute` once, outside the retry loop and independent of `billable`. A mark function that throws is decided as an empty mark with no default label, which is `deny`.
- **The binding rule (D-50)** in `decideAttested`: after the TEE, endpoint and failed-attestation rules, a NEAR client is allowed only with `isBindingFresh` and a fact for the same host; otherwise `route.connection-not-bound` (a local model is available) or `route.no-local-model`, the reason being the cause's `BINDING_REFUSALS` sentence followed by the rule's sentence without a second "Nothing was sent.".
- **Failed-closed routing (D-53, routing half)**: `routingWhileFailedClosed()` raises every tier above any-cloud to at least local-only and names no local host; `routingOf(route)` uses it whenever the route's policy is not valid or cannot be read.
- **Session routes at every production site**: the main run and each sub-agent (the sub-agent's own runtime, the parent's `markOf` and the chat's `routeAttestation`), attachment reads (as the person), the `@nearAi` participant (as the person, `registerChatParticipant` now takes the gate host), the team builder's `completeOnce` (as the person), the cyber panel's run (one route around the whole scan) and the hand-off assembly's role call (when given a gate), and `runAgentInFolder` (comparison, benchmark, role suite). `GateHost.sessionRouteWithoutContext()` is the default route; `registerGate` sets it.
- **Records (D-20, D-52)**: `routeRecordFor` builds the infer record (capability `infer` with tier, provider `near-ai` or `local`, model; resource the model; outcome; rule; bundle hash); short for `route.any-cloud` and `route.default-session`; `mark` only above the default label; `connection` only at attested-cloud; never a host, URL, path or fingerprint. A person's record has no `ai_agent.ai_model` (the builder adds it only for agents); its capability still names the model and provider.
- **Ids and fields (D-49)**: `ROUTE_EVENT_IDS`, `LABEL_EVENT_IDS` and `policy.edit` join `RECORD_RULE_IDS`; the label events join the record operations; `DecisionRecordInput` gains optional `mark`, `attestation` and `connection`; record version stays 1.

## Log growth measurement (D-52, for 70-28a's PR body)

Bytes per record, as the decision log stores the line (JSON plus newline, realistic ids: a 36-character model id, a 64-hex device and bundle hash, conversation and agent ids of today's shape), measured from the built modules:

| Record | Bytes |
|---|---|
| short, main agent (routine allowed) | 1,350 |
| short, sub-agent | 1,354 |
| short, person (attachments, participant, team builder) | 1,161 |
| full, agent refused at org/Internal (reason, mark, connection) | 1,898 |

The test fixture's own pair (short ids) measured 1,179 and 1,721 bytes; the test asserts short is smaller than full.

Model requests per day, from the owner's own spend ledgers on this machine (read only, counted, nothing copied; NEAR AI Cloud requests only, so local-runtime requests are not in these numbers): 16,225 requests over 14 active days (2026-10-29 to 2026-11-15). Per active day: median 527, 75th percentile 974, 90th percentile 2,530, highest 4,301; the busiest single project on one day made 3,906.

Days until one project's 5 MB log (5,242,880 bytes) rolls over, from short infer records alone (1,350 bytes each), and how long the five files kept (the current one and four older) then cover:

| Day | Requests | Log growth per day | Rolls over after | Five files cover |
|---|---|---|---|---|
| median | 527 | about 0.71 MB | about 7.4 days | about 37 days |
| 75th percentile | 974 | about 1.31 MB | about 4.0 days | about 20 days |
| 90th percentile | 2,530 | about 3.42 MB | about 1.5 days | about 7.7 days |
| busiest project day | 3,906 | about 5.27 MB | about 1.0 day | about 5 days |

These leave out the tool-call records the same log already holds, so the real rollover is sooner. See owner question 1.

## Existing tests changed, and why

- `src/test/gateRouting.test.ts` (behaviour changes on purpose, D-50):
  - "tracer: a mark goes to a tier...": the attested-cloud allowed case (`org/Confidential` on `NEAR_TEE`) now gives a fresh bound fact (`NEAR_TEE_BOUND`); a twin without it asserts the refusal (`route.no-local-model`, tier attested-cloud).
  - "every rule id can be reached...": the `org/Internal` on `NEAR_TEE` case now uses `NEAR_TEE_BOUND` (so `route.attested-cloud` is still reached); added a twin without the fact, a case with `localModelAvailable` (reaches `route.connection-not-bound`) and a `sessionless` case (reaches `route.default-session`). The refusal-sentence assertion lists `route.default-session` among the allowed rules beside any-cloud, attested-cloud and local-only, because it is an allowed rule with no refusal sentence; every other assertion is unchanged.
  - No other case asserted an attested-cloud allow through NEAR AI Cloud; none was weakened or removed.
- `src/test/gateRecordIds.test.ts`: the four pinned lists grow by exactly the new ids, nothing removed: `POLICY_EVENT_IDS` gains `policy.edit` (line 33); `RECORD_RULE_IDS` is the join with `LABEL_EVENT_IDS` and `ROUTE_EVENT_IDS` (line 35); the operations checked valid (line 48) and the namespace-free scan's operation set (line 190) gain `LABEL_EVENT_IDS`. The scan names nothing new in `NOT_RECORD_IDS`.
- `nearAiClient.test.ts`, `providerFactory.test.ts`, `attachments`, `privateMembers`, `outboundGuard`, `benchmarkRunner`, `cyberRun` and `gateEnumeration` pass unchanged.

## New tests

- `gateRouteGuard.test.ts` (16): the tracer; the factory's route kinds; the three scans (request sites, the import graph from `extension.ts`, client construction), each with a planted violation that is reported; the main run and sub-agent routes; `runAgentInFolder`'s route; one infer record per request and a denied one with the sentence; the short record and its size; no host, URL or path (a LAN runtime, the NEAR endpoint, a model named by its file, plain http to a LAN host refused before routing); the default route and `route.default-session`; the host's default route writing to the project log; parallel sibling contexts and a retry decided once with a mark raised in its backoff; refusal before the spend check, the ledger, a cooling model and with no spend sink; a throwing sink and a throwing mark; OFFL-01 with fetch, net, dns, http and https stubbed to throw, right after a `verifyResponse` call.
- `gateRouting.test.ts` (+4): binding freshness bounds; every binding cause and both refusing rules; `route.default-session`; `routingWhileFailedClosed`.
- `gateRecords.test.ts` (+2): the optional mark, attestation and connection fields; the label events as operations and rules, route events under `infer`.

## Verification

- Task 1, 2 and 3 verify commands: 45/45, 83/83 and 638/638 passing.
- `npm run lint`: clean.
- Full `npm test` (6G cap): 3,489 tests, 3,480 pass, 0 fail, 0 cancelled, 9 skipped (the live NEAR AI tests that need a key).
- e2e (`xvfb-run -a npm run test:e2e`, 6G cap, run once because activation and the chat path changed): exit 0, 26 checks passing, 0 failing.
- `package.json` and `package-lock.json` unchanged; no new package.
- Diff against origin/main: 23 files, 1,389 insertions, 74 deletions, 148,183 bytes of unified diff (the plan estimated about 160 KB at open).

## Deviations from Plan

### Auto-fixed and code-reality deviations

1. **[Rule 3] `route.default-session` is decided in `decideRoute`, not substituted in the client.** The plan has the client record `route.default-session` instead of `route.any-cloud`. The existing "every rule id can be reached" test requires every rule in `ROUTE_RULES` to come out of `decideRoute`, so a rule only the client wrote would have needed that test weakened. A new optional fact, `RouteFacts.sessionless`, makes any allowed decision outside a session `route.default-session` (the plan's "recorded under route.default-session when allowed"), and a refusal keeps its refusing rule.
2. **[Rule 2] The fallback default route is failed closed, not "a route over the shipped default bundle".** A valid `BundleState` needs a signer and a hash that do not exist without a host, so pretending one would be false. With nothing set, the fallback reads `failedClosed('unavailable')`, which routes the default label exactly as the shipped bundle does (any-cloud) and keeps anything labelled on this computer (D-53). In production `registerGate` sets the host's route at activation.
3. **[Code reality] The LAN-host record test uses `https://192.168.1.5:11434/v1`.** `isSecureEndpoint` refuses plain http to a host that is not this computer before the route check, so `http://192.168.1.5:11434/v1` never reaches a decision and leaves no record. The test checks both: the https runtime's records name no host, and the http one is refused before routing with nothing recorded.
4. **[Rule 2] A model id that is a path or URL is recorded as its last part** (`recordedModelName`). A local runtime such as a llama.cpp server can name a model by its file, which would have put a folder of this computer on record, against D-52.
5. **[Rule 2] A fact for another host never counts.** The binding rule also requires the fact's host to equal the request's host, and a fact checked in the future is not fresh.
6. **[Code reality] The cyber panel's route wraps the whole scan** (`panelCyberRunStarter`), because the role call's closure in `cyberAssembly()` is built before the run's runtime exists; every driver call runs inside that scan's async context. `cyberHandoff.ts`'s own `cyberAssembly` (not called by the extension) takes an optional `gate` and wraps its role call when given one.
7. **[Code reality] `registerChatParticipant` takes the gate host** (one line in `src/extension.ts`, not in the plan's file list), since the participant had no runtime to build a route from.
8. **[Code reality] `UsageMetadata.connection` is set only when the client has a binding source**, so today's usage objects are unchanged (no client has one before plan 25) and no existing usage assertion moved.
9. **Owner instruction over the plan text:** the plan defers the log growth measurement to 70-28a; the owner asked for the numbers here, so they are above.
10. **Commit `ca04772` alone fails `gateRecordIds`' rule-shaped id scan** (it adds `ROUTE_EVENT_IDS` before Task 3 names them in `RECORD_RULE_IDS`); `2aa0604` inherits it and `8518e84` fixes it. The tip is green; the PR is squash-merged.

### Notes for 70-28a

- SECURITY.md "Your policy file and decision records" says each decision of a tool call is recorded and that routing tiers are stored "and not used yet". From this PR every model request is checked against the routing table and recorded as an `infer` record (short when routine), and attested-cloud levels route local-only, though no label can raise a mark until 4b and 4c. gateDocs did not pin either sentence, so it passed; 28a reads SECURITY.md against the code.
- The participant, attachment reads and the team builder now await `runtimeFor` (at most `RUNTIME_START_WAIT_MS`, 5 seconds, only while the policy check is still starting) before their first request.

## Owner questions

1. **Log growth (D-52).** At the median day a project's 5 MB log rolls over about once a week from model records alone, and on the busiest project day about once a day, so the five files kept cover about 37 days at the median and about 5 days at the peak, before tool-call records are counted. Options: keep as is (shipped here, the fail-closed choice: every request recorded); make the short record shorter (it repeats the model id four times and the bundle hash twice); write infer records to a log of their own; or raise the per-project size. Recommendation: decide before 4c, when labels make the full records common.
2. **`connection` on records.** It is written only at attested-cloud (the one tier that reads the fact). If you want it on every NEAR AI Cloud record once plan 25 adds the source, that is a one-line change in `routeRecordFor`.

## Known Stubs

- `src/services/connectionBinding.ts` holds only the `ConnectionBindingSource` interface; no client has a source, by design (D-50), so attested-cloud levels route local-only until plan 25 (PR 4d) adds the NEAR AI Cloud source. `SessionRoute.markOf` returns the empty mark at every site until plan 22 (PR 4c) gives a chat's runs the chat's mark. Both are the plan's intended staging, not missing work.

## Threat Flags

None beyond the plan's threat register: no new network endpoint, no new file location (records go to the existing decision logs in global storage), no new auth path.

## TDD Gate Compliance

Task 3 (`tdd="true"`): the behaviour tests were written with the implementation, then run red with the record write and the new id lists disabled in place (11 of 35 failing, including every behaviour item), then green; the implementation and tests were committed together in `8518e84`, so there is no separate RED commit.

## Self-Check: PASSED

Created files exist (src/gate/sessionMark.ts, src/services/connectionBinding.ts, src/test/gateRouteGuard.test.ts); commits ca04772, 2aa0604 and 8518e84 are on HEAD; `commits: 3` measured with `git rev-list --count` from the base.
