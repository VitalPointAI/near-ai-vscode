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
  - "LABEL_EVENT_IDS, policy.edit, SHIPPED_DEFAULT_LABEL, record fields mark/attestation/connection/short, isModelRequestRecord, GateHost.sessionRouteWithoutContext, NO_SESSION_ID"
  - "decisionLog.ts: MODEL_REQUESTS_DIR, LogKind, DecisionLogOptions.kind (the model-request log); GateHost.openModelRequestLogKeys; installEvidence MODEL_REQUEST_LOGS_FOLDER"
affects: [70-28a, 70-20, 70-21, 70-22, 70-24, 70-25, 70-26]
tech-stack:
  added: []
  patterns: ["AsyncLocalStorage session route (the withSpendTag pattern)", "one route check at the client's choke point", "source scans as the single invariant check"]
key-files:
  created: [src/gate/sessionMark.ts, src/services/connectionBinding.ts, src/test/gateRouteGuard.test.ts]
  modified: [src/domain/gate/routing.ts, src/domain/gate/bundle.ts, src/domain/gate/labels.ts, src/domain/gate/decide.ts, src/domain/gate/record.ts, src/services/nearAiClient.ts, src/services/providerFactory.ts, src/gate/host.ts, src/services/gateCommands.ts, src/services/agentSession.ts, src/services/chat.ts, src/services/chatParticipant.ts, src/services/teamStudioPanel.ts, src/services/cyberAssembly.ts, src/services/cyberHandoff.ts, src/benchmark/runner.ts, src/extension.ts, src/gate/decisionLog.ts, src/gate/installEvidence.ts, src/test/gateRouting.test.ts, src/test/gateRecords.test.ts, src/test/gateRecordIds.test.ts, src/test/gateBundleTrust.test.ts]
decisions:
  - "An allowed request outside every session is route.default-session, decided inside decideRoute from a new RouteFacts.sessionless flag, so the pure function stays the one place a route rule comes from."
  - "With no default route set (no gate host), the fallback route reads as failed closed ('unavailable'): the default label routes as today, anything labelled stays on this computer, nothing is recorded."
  - "An infer record keeps the connection state only when the tier read it (attested-cloud); a short record has no reason, no tier beside the capability's, and no label at the default mark."
  - "A model id that is a path or an address is recorded as its last part, so a local runtime that names a model by its file never puts a folder or host on record."
  - "Owner, after the measurement: model-request records (route rules and route events) go to a log of their own, gate/model-requests/<key>.jsonl, through the same DecisionLog class and GateHost rules; each log refuses the other kind; the host routes by isModelRequestRecord (the record's rule)."
  - "Owner, after the measurement: the short record writes nothing twice: the model once (capability), the policy hash once (unmapped.nearAi.bundleHash); no ai_model, no resource entry, no policy uid, request uid 'infer'."
metrics:
  duration: "about 3.5 hours (the plan, then the owner's answer on the logs)"
  completed: 2026-11-17
pr4a_base: f668c23d39041fa5b8e7db40ba8f09c8fcc283cb
plan_head_before: f668c23d39041fa5b8e7db40ba8f09c8fcc283cb
plan_head_after: e5813cf9c94e3c91a8b0ae50a00eea05cb49eee8
commits: 5
actuals:
  tokens: 45000
  tasks: 4
  commits: 5
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
| (summary) | `023b5bd` | docs(70-19): the SUMMARY |
| owner follow-up | `e5813cf` | feat(gate): model requests get a log of their own, and the short record writes nothing twice |

Every new test was seen failing first: each task's tests were run with the production change disabled in place (the check call, the binding rule, the wraps, the route kinds, the record write and the id lists replaced by no-ops), the failures recorded, then the code restored and the tests run green. Task 1: 4 failing of 20; the factory test: 1 of 2; Task 2: 5 of 7; Task 3: 11 of 35; the owner follow-up: 6 of 43 (the host's routing by kind, the log's own refusal, the short form and the install-evidence folder each switched off).

## What was built

- **The route check** (`nearAiClient.ts` `checkRoute`): reads `currentSessionRoute()` or the default route, builds `RouteFacts` from the client's route kind, its base URL, `isNearCloudEndpoint`, the model's entry in this client's own cached catalog, the route's attestation state, the binding fact held in memory (`{ state: 'unknown' }` with no source or a throwing one), the route's clock and `localModelAvailable`; calls `decideRoute` once, outside the retry loop and independent of `billable`. A mark function that throws is decided as an empty mark with no default label, which is `deny`.
- **The binding rule (D-50)** in `decideAttested`: after the TEE, endpoint and failed-attestation rules, a NEAR client is allowed only with `isBindingFresh` and a fact for the same host; otherwise `route.connection-not-bound` (a local model is available) or `route.no-local-model`, the reason being the cause's `BINDING_REFUSALS` sentence followed by the rule's sentence without a second "Nothing was sent.".
- **Failed-closed routing (D-53, routing half)**: `routingWhileFailedClosed()` raises every tier above any-cloud to at least local-only and names no local host; `routingOf(route)` uses it whenever the route's policy is not valid or cannot be read.
- **Session routes at every production site**: the main run and each sub-agent (the sub-agent's own runtime, the parent's `markOf` and the chat's `routeAttestation`), attachment reads (as the person), the `@nearAi` participant (as the person, `registerChatParticipant` now takes the gate host), the team builder's `completeOnce` (as the person), the cyber panel's run (one route around the whole scan) and the hand-off assembly's role call (when given a gate), and `runAgentInFolder` (comparison, benchmark, role suite). `GateHost.sessionRouteWithoutContext()` is the default route; `registerGate` sets it.
- **Records (D-20, D-52)**: `routeRecordFor` builds the infer record (capability `infer` with tier, provider `near-ai` or `local`, model; resource the model; outcome; rule; bundle hash); short for `route.any-cloud` and `route.default-session`; `mark` only above the default label; `connection` only at attested-cloud; never a host, URL, path or fingerprint. A person's record has no `ai_agent.ai_model` (the builder adds it only for agents); its capability still names the model and provider.
- **Ids and fields (D-49)**: `ROUTE_EVENT_IDS`, `LABEL_EVENT_IDS` and `policy.edit` join `RECORD_RULE_IDS`; the label events join the record operations; `DecisionRecordInput` gains optional `mark`, `attestation` and `connection`; record version stays 1.

## Model-request log and short record (the owner's answer to the log-growth question)

- **A log of its own.** `infer` records and route events (`isModelRequestRecord`: the record's rule is a route rule or a route event) go to `<globalStorage>/gate/model-requests/<project key>.jsonl` (the install key when no folder is open), beside `gate/decisions/`. It is the same `DecisionLog` class with a `kind`: the same rotation (5 MB, four older files), file lock, sequence, redaction, validation and path scrubbing. `GateHost` keeps both kinds in one map of slots, so its rules apply unchanged: one writer per key and kind; a log let go is taken back by its next record; `flush()` waits for both kinds, including logs let go; `retainProjectLogs` lets a closed folder's model-request log go with its decision log; and `MAX_PROJECT_LOGS` (8) holds per kind, so model requests never push a decision log out. Every runtime's one sink, and the default route's sink, routes each record by its kind. A log offered a record of the other kind refuses it and reports once; nothing is written to the wrong file. Tool and policy records stay in `gate/decisions/`. A tool decision whose effect is `infer` (an image tool) carries a tool rule, so it stays in the decision log (tested).
- **Readers.** The only production reader of the logs is the install-evidence check (`installEvidence.ts`), which now reads both folders, so a model-request log that names a policy hash still counts as evidence of an earlier policy (tested). Show Policy, the status bar and the policy view read no records; records are not exported or synced. No test from main reads infer records (the other gate tests use fake clients, which make none).
- **Shorter short record.** It now names the model once (in `unmapped.nearAi.capability`) and the policy hash once (`unmapped.nearAi.bundleHash`): no `ai_agent.ai_model`, an empty `resources` list, no `authorizations[0].policy.uid`, and request uid `infer` instead of a second copy of the record id. Every field the record check requires is still there and the record stays version 1 (`DecisionRecordInput.short`; the policy `uid` is now optional in the type). Full records (refusals, and allowed rules other than route.any-cloud and route.default-session) are unchanged.

## Log growth measurement (D-52, for 70-28a's PR body)

Bytes per record, as the log stores the line (JSON plus newline), with real-sized ids (a 36-character model id, a 64-hex device fingerprint and policy hash, today's conversation and agent id shapes, a UUID record id):

| Record | Before | After |
|---|---|---|
| short, main agent | 1,350 | 1,095 |
| short, sub-agent | 1,354 | 1,099 |
| short, person (attachments, participant, team builder) | 1,161 | 989 |
| full, agent refused at org/Internal | 1,898 | 1,898 (unchanged) |
| a tool decision (an agent's Read of a project file), in the decision log | 1,281 | 1,281 |

The test pins the short record's exact field set; checks that the model id, the policy hash and the record id each appear once; and holds every actor kind to a budget of 1,100 bytes with these ids. The test fixture's own pair (short ids) measures 974 and 1,721 bytes.

Requests per day come from the owner's own spend ledgers on this machine (read only, counted in aggregate, nothing copied; NEAR AI Cloud requests only, so local-runtime requests are not in them): 16,225 model requests over 14 active days (2026-10-29 to 2026-11-15). Model requests per active day: median 527, 75th percentile 974, 90th percentile 2,530; the busiest single project on one day made 3,906, and since a log is per project, that is the peak used below. Tool decisions are in no ledger. They are estimated as one per agent model turn (main, sub-agent and comparison turns), which is a lower bound, because a turn can make several calls and an ask writes two records: median 407, 75th percentile 764, 90th percentile 1,993, busiest project day 2,843.

Rollover of one project's 5 MB log (5,242,880 bytes), and the days the five kept files (the current one and four older) cover:

| Day | Model-request log (short, 1,095 B) | Tool-decision log (1,281 B, estimate) | Before: one shared log (short 1,350 B plus tool records) |
|---|---|---|---|
| median | 0.58 MB a day: rolls after 9.1 days; five files cover 45 days | 0.52 MB a day: 10.1 days; 50 days | 1.23 MB a day: 4.3 days; 21 days |
| 75th percentile | 1.07 MB: 4.9 days; 25 days | 0.98 MB: 5.4 days; 27 days | 2.29 MB: 2.3 days; 11 days |
| 90th percentile | 2.77 MB: 1.9 days; 9.5 days | 2.55 MB: 2.1 days; 10 days | 5.97 MB: 0.9 days; 4.4 days |
| busiest project day | 4.28 MB: 1.2 days; 6.1 days | 3.64 MB: 1.4 days; 7.2 days | 8.91 MB: 0.6 days; 2.9 days |

At the old size, model requests alone rolled the log over after 7.4, 4.0, 1.5 and 1.0 days. The split roughly doubles how far back each log reaches, and tool decisions no longer compete with model requests for the same 5 MB.

## Existing tests changed, and why

- `src/test/gateRouting.test.ts` (behaviour changes on purpose, D-50):
  - "tracer: a mark goes to a tier...": the attested-cloud allowed case (`org/Confidential` on `NEAR_TEE`) now gives a fresh bound fact (`NEAR_TEE_BOUND`); a twin without it asserts the refusal (`route.no-local-model`, tier attested-cloud).
  - "every rule id can be reached...": the `org/Internal` on `NEAR_TEE` case now uses `NEAR_TEE_BOUND` (so `route.attested-cloud` is still reached); added a twin without the fact, a case with `localModelAvailable` (reaches `route.connection-not-bound`) and a `sessionless` case (reaches `route.default-session`). The refusal-sentence assertion lists `route.default-session` among the allowed rules beside any-cloud, attested-cloud and local-only, because it is an allowed rule with no refusal sentence; every other assertion is unchanged.
  - No other case asserted an attested-cloud allow through NEAR AI Cloud; none was weakened or removed.
- `src/test/gateRecordIds.test.ts`: the four pinned lists grow by exactly the new ids, nothing removed: `POLICY_EVENT_IDS` gains `policy.edit` (line 33); `RECORD_RULE_IDS` is the join with `LABEL_EVENT_IDS` and `ROUTE_EVENT_IDS` (line 35); the operations checked valid (line 48) and the namespace-free scan's operation set (line 190) gain `LABEL_EVENT_IDS`. The scan names nothing new in `NOT_RECORD_IDS`.
- **This PR's own tests, changed by the owner follow-up** (not tests from main): in `gateRouteGuard.test.ts`, the record test now expects the routine record's `resources` empty and no `ai_agent.ai_model` (the refused record keeps both); the size test writes to a model-request log; the host default-route test reads the infer record from `gate/model-requests/`, checks the decision log holds only policy events, and reads the policy hash from `unmapped.nearAi.bundleHash` (the short record has no policy uid).
- **`gateBundleTrust.test.ts`** (from main): the folder-name test also checks `MODEL_REQUEST_LOGS_FOLDER` equals `MODEL_REQUESTS_DIR` (an added assertion, nothing removed), and one test was added.
- `nearAiClient.test.ts`, `providerFactory.test.ts`, `attachments`, `privateMembers`, `outboundGuard`, `benchmarkRunner`, `cyberRun` and `gateEnumeration` pass unchanged.

## New tests

- `gateRouteGuard.test.ts` (16): the tracer; the factory's route kinds; the three scans (request sites, the import graph from `extension.ts`, client construction), each with a planted violation that is reported; the main run and sub-agent routes; `runAgentInFolder`'s route; one infer record per request and a denied one with the sentence; the short record and its size; no host, URL or path (a LAN runtime, the NEAR endpoint, a model named by its file, plain http to a LAN host refused before routing); the default route and `route.default-session`; the host's default route writing to the project log; parallel sibling contexts and a retry decided once with a mark raised in its backoff; refusal before the spend check, the ledger, a cooling model and with no spend sink; a throwing sink and a throwing mark; OFFL-01 with fetch, net, dns, http and https stubbed to throw, right after a `verifyResponse` call.
- `gateRouting.test.ts` (+4): binding freshness bounds; every binding cause and both refusing rules; `route.default-session`; `routingWhileFailedClosed`.
- `gateRecords.test.ts` (+2): the optional mark, attestation and connection fields; the label events as operations and rules, route events under `infer`.
- Owner follow-up (+4): an infer record never lands in the decision log and a tool or policy record never in the model-request log (through the host's runtime sink, and at the log itself both ways); model-request logs follow the host's retention, per-kind cap, one-writer and flush rules; the short record's pinned fields, single copies and byte budget; a model-request log alone counts as install evidence (`gateBundleTrust`).

## Verification

- Task 1, 2 and 3 verify commands: 45/45, 83/83 and 638/638 passing.
- `npm run lint`: clean.
- Full `npm test` (6G cap): 3,489 tests, 3,480 pass, 0 fail, 0 cancelled, 9 skipped (the live NEAR AI tests that need a key). After the owner follow-up: 3,493 tests, 3,484 pass, 0 fail, 0 cancelled, 9 skipped; `npm run lint` clean.
- Range secret scan (`node scripts/secret-scan.mjs --range origin/main..HEAD`): clean, 1,251 tracked files and 5 commits.
- e2e (`xvfb-run -a npm run test:e2e`, 6G cap, run once because activation and the chat path changed): exit 0, 23 e2e tests passing, 0 failing. Run again once after the owner follow-up: exit 0, the same 23 passing, 0 failing.
- `package.json` and `package-lock.json` unchanged; no new package.
- Diff against origin/main, code only (without this SUMMARY): 26 files, 1,646 insertions, 111 deletions, 181,618 bytes of unified diff; it was 148,183 bytes before the owner follow-up (the plan estimated about 160 KB at open).

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

- SECURITY.md "Your policy file and decision records" names where records are kept: model requests now have their own log, `gate/model-requests/`, beside `gate/decisions/`, with the same rotation (5 MB, four older files) and the same rules (not synced, never in the project). It also says each decision of a tool call is recorded and that routing tiers are stored "and not used yet". From this PR every model request is checked against the routing table and recorded as an `infer` record (short when routine), and attested-cloud levels route local-only, though no label can raise a mark until 4b and 4c. gateDocs did not pin either sentence, so it passed; 28a reads SECURITY.md against the code.
- The participant, attachment reads and the team builder now await `runtimeFor` (at most `RUNTIME_START_WAIT_MS`, 5 seconds, only while the policy check is still starting) before their first request.

## Owner questions

1. **Log growth (D-52): answered.** The owner chose a log of its own for model requests and a short record without repeats; both are done (`e5813cf`), with the numbers above. Still open, only if wanted: raising the 5 MB size, which on the busiest project day now holds about six days of model requests. (The first report said the old short record repeated the model id four times; it was three: the capability, the resource and the agent's model.)
2. **`connection` on records.** It is written only at attested-cloud (the one tier that reads the fact). If you want it on every NEAR AI Cloud record once plan 25 adds the source, that is a one-line change in `routeRecordFor`.

## Known Stubs

- `src/services/connectionBinding.ts` holds only the `ConnectionBindingSource` interface; no client has a source, by design (D-50), so attested-cloud levels route local-only until plan 25 (PR 4d) adds the NEAR AI Cloud source. `SessionRoute.markOf` returns the empty mark at every site until plan 22 (PR 4c) gives a chat's runs the chat's mark. Both are the plan's intended staging, not missing work.

## Threat Flags

None beyond the plan's threat register: no new network endpoint, no new file location (records go to the existing decision logs in global storage), no new auth path.

## TDD Gate Compliance

Task 3 (`tdd="true"`): the behaviour tests were written with the implementation, then run red with the record write and the new id lists disabled in place (11 of 35 failing, including every behaviour item), then green; the implementation and tests were committed together in `8518e84`, so there is no separate RED commit.

## Self-Check: PASSED

Created files exist (src/gate/sessionMark.ts, src/services/connectionBinding.ts, src/test/gateRouteGuard.test.ts); commits ca04772, 2aa0604, 8518e84, 023b5bd and e5813cf are on HEAD; `commits: 5` measured with `git rev-list --count` from the base before this SUMMARY's own update commit.
