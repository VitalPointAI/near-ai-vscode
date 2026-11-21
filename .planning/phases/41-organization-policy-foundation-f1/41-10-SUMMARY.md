---
phase: 41-organization-policy-foundation-f1
plan: 10
subsystem: gate routing (decision core, residency, TrustFacts)
status: complete
tags: [routing, decideRoute, endpoints, authorizations, residency, passports, clearance, trust-line, report-mode]
requires: [safety patch (D-01), 41-01 (named-ahead ids, endpoints.ts, authorizations.ts, sections.ts), 41-04 (meetClearance, labelKeyShownWithMarkings), 41-05 (resolvePassport, passportCovers, USE_TIER_WORDS)]
provides:
  - routing.ts RoutePolicy, VerifiedAuthorization, RouteEndpoint, AllowingRecord, ReportedRouteRule, endpointOf, effectiveClearances, decideRoute(..., floor?, policy?)
  - RouteFacts.use and allowedModels; RouteDecision.endpoint, allowedBy, wouldRefuse, notAccredited, pinTo
  - eight ids moved from ROUTE_RULES_NAMED_AHEAD into ROUTE_RULES and ROUTE_REFUSALS (sentences unchanged); route.passport and route.export-control stay ahead
  - residency.ts allowedRegions, residencyAllows, ResidencyQuestion, ResidencyAnswer
  - trust.ts TRUST_VERIFICATION_LEVELS, TrustVerificationLevel, TrustPlace, TrustFacts, TrustContext, TrustExtra, trustFactsFor, TRUST_LINE_TEXT, dateShown, trustLine, TrustLine
affects: [41-13 (client passes RoutePolicy, carries pinTo to the send, records wouldRefuse, badge reads TrustFacts), 41-15 (SECURITY.md quotes TRUST_LINE_TEXT), 41-11 (copy lint reads TRUST_LINE_TEXT), 74.1 (passport enforcement), Phase 45 (route.export-control)]
tech-stack:
  added: []
  patterns: [one decision function with a fixed step order after the patch's checks, report-only findings as wouldRefuse, functions of cyclic modules called only inside functions, seeded exhaustive equivalence table, recording wrapper to prove an id is never returned]
key-files:
  created:
    - src/domain/gate/residency.ts
    - src/domain/gate/trust.ts
    - src/test/gateDecideRoute.test.ts
    - src/test/gateResidency.test.ts
    - src/test/gateTrustFacts.test.ts
  modified:
    - src/domain/gate/routing.ts
    - src/test/gateRouting.test.ts
    - src/test/gateRecordIds.test.ts
decisions:
  - "With a policy, allowedBy is always present on an allowed decision (routing record first); wouldRefuse, notAccredited and pinTo are present only when they say something. Without a policy and allowedModels the decision is the patch's object unchanged (no new keys)."
  - "A refusal from a policy step is the plain refuse(tier, rule) object: it never carries the private floor's sentence (that stays the patch's own words) and drops any report gathered before it."
  - "The authorization AllowingRecord carries an optional label (the scale/level key it was checked for) so the trust line can say 'Allowed for {label} by {name}'s authorization ...'; a residency exception, checked for the whole request, has none."
  - "allowedBy adds each record once (deduplicated by its fields); every covering protected-b or accredited-device record is listed, not only the first."
  - "Step 1 refuses route.endpoint-unknown for no place above any-cloud, and also at any-cloud when a label needs an endpoint authorization (Task 2's addition), as the plan orders."
  - "The passport step asks t1-risk coverage for every label of the mark (one question with no label for an empty mark); the model-approval record is added only when a passport resolved, and the covering t1-risk records join it when the use was above the passport's tier."
  - "residencyAllows takes an optional lowercase use and passes it to authorizationCovers, like the other steps; an exception scoped to uses covers nothing without one (D-54 fail closed)."
  - "trustFactsFor takes an optional verification in its extra argument (the badge's level once its check ran); 'not-checked' otherwise."
  - "Trust place for a decision with no place: endpointOf(facts, []) (loopback this computer, NEAR AI Cloud's private hardware or forwarded); a local route on a host the routing's localHosts names reads as your organization's server; anything else 'a place your rules do not name'. A remote host is never called this computer."
  - "Trust line: a routing record whose label an authorization record also names is left out of the Allowed words, because the authorization already says it. Vendor places add their region ('Cohere vault in Canada'); a non-Cohere vendor reads 'outside provider ({provider}) in {region}'; forwarded and closed-api read 'outside provider ({name})', or 'an outside provider' with no name."
  - "dateShown returns a text that is not a date unchanged."
  - "endpoints.ts was not touched (not in files_modified), so its private splitLabelKey stays; decideRoute matches places only through findEndpoint and endpointCeilingAllows."
metrics:
  duration: ~75 min
  completed: 2026-11-20
actuals:
  tokens: 28974
  tasks: 4
  commits: 5
plan_head_before: 97a9bd229f899f1e0b8065c20260c3a57e76f5f4
plan_head_after: 75f04a02c82645a75fd23878c82bf7b5fb1c93b7
---

# Phase 41 Plan 10: Decision core, residency and TrustFacts Summary

decideRoute is still the one decision function. On a request the safety patch's checks allowed, it now runs the v2 policy steps in the D-36 order: allowed models, the place, its ceiling, a pin or binding, an authorization, the accredited device, residency, the passport and clearance. The accredited device and passport steps only report until your organization or a later phase turns refusal on. Every outcome becomes one TrustFacts record and one three-part trust line in the glossary's words.

## What was built

- **Task 1 (tracer, 82390f70):** `RouteFacts.use` and `allowedModels`. New types `RoutePolicy`, `VerifiedAuthorization`, `RouteEndpoint` and `AllowingRecord`, and new optional decision fields. `endpointOf` returns a listed entry, this computer for loopback, or NEAR AI Cloud's endpoint with no entry (`nearai-tee` for a TEE model, `forwarded` otherwise). `decideRoute(mark, routing, facts, defaultLabel?, floor?, policy?)` computes the patch's decision unchanged (now the private `decideByTable`) and returns any refusal as it is. On an allowed request it then runs step 0, allowed models (`route.model-not-allowed`, with or without a policy), and with a policy the private `decidePolicySteps`: step 1 place (`route.endpoint-unknown`) and step 2 ceiling (`route.endpoint-ceiling`). An implicit place adds no ceiling.
- **Task 2 (d3857a4f):** `residency.ts`. Step 3: on your organization's plain server, a level that `needsEndpointAuthorization` names needs a TLS pin, carried as `pinTo`. On `nearai-tee`, `org-tee` and `vendor-tee` it needs a fresh bound fact for the same host; otherwise `route.endpoint-pin`. Step 4: a `protected-b` authorization naming the place's id, for each such label, the project and the use. A place without an id cannot be named, so `route.authorization-missing`. Step 5: a level that stays on this computer needs an `accredited-device` authorization for `policy.deviceId`. Without one it goes into `wouldRefuse` with `notAccredited`, and is refused only when `organization` and `requireAccreditedDevice` are both set. Step 6: `residencyAllows` checks every place except this computer; a host no entry names counts as unstated.
- **Task 3 (f0e2b7ae, ff30a595):** Step 7 is the passport (`resolvePassport`, `passportCovers`, a t1-risk acceptance). It only reports `route.passport`, whatever `mode` says, and records a model approval when the passport covers the request. Step 8: `effectiveClearances` (the meet of the personal and roster clearances) runs only when `rosterClearances` is given, and refuses `route.clearance`. Also added: the FND-02 equivalence test (3,240 cases) and the D-62/D-63 export tests.
- **Task 4 (75f04a02):** `trust.ts`, with `trustFactsFor`, `trustLine`, `TRUST_LINE_TEXT` and `dateShown`.

Id moves (sentences byte-identical to the base, checked by script after each task): `route.model-not-allowed`, `route.endpoint-unknown`, `route.endpoint-ceiling` (Task 1); `route.endpoint-pin`, `route.authorization-missing`, `route.accredited-device`, `route.residency` (Task 2); `route.clearance` (Task 3). `ROUTE_RULES_NAMED_AHEAD` is now `['route.passport', 'route.export-control']`.

## Red runs (TDD evidence)

- Task 1: on the unchanged base the new tests did not compile (TS2554, 6 arguments where 3 to 5 are expected; no `allowedBy`, `wouldRefuse` or `pinTo` on RouteDecision; `allowedModels` unknown on RouteFacts; `route.model-not-allowed` not a ROUTE_REFUSALS key).
- Task 2: on the Task 1 code, TS2307 (no `residency.ts`) and TS7053 or TS2551 for `route.endpoint-pin`, `route.authorization-missing`, `route.accredited-device` and `route.residency` (not refusing rules yet).
- Task 3: on the Task 2 `routing.ts` (copied aside and restored), TS2305 (no `effectiveClearances`) and TS7053 for `route.clearance`. With the Task 3 code in place but the lists not yet updated, the gateRecordIds exact-list test and the gateRouting every-rule test failed on `route.clearance` as intended, before the move.
- Task 4: TS2307 (no `trust.ts`).

## Verification

- Task 1 set (gateDecideRoute, gateRouting, gateRouteTiers, gateRecordIds, gateDecide): 96/96.
- Task 2 set (gateDecideRoute, gateResidency, gateRouting, gateRecordIds): 63/63.
- Task 3 set (gateDecideRoute, gateRouting, gateRouteTiers, gateRecordIds, gateRecords, gatePassports): 155/155. After compiling, `ROUTE_RULES_NAMED_AHEAD.length` is 2, ROUTE_RULES includes `route.clearance` and does not include `route.export-control`.
- Task 4 set (gateTrustFacts, gateDecideRoute, gateResidency, gateRouting, gateTrustBadge, teamBoundaries): 140/140. `npm run lint` exits 0.
- Gate set (every `gate*.test.js`, teamBoundaries, replicaBoundaries, teamSecrets, teamSignedPayload): 1168 tests, 1167 pass, 1 fail. The one failure is the known gateLayers "D-19: every key a section parser names is accounted for" (models-section keys in layers.ts, being fixed elsewhere; neither layers.ts nor policyFixtures.ts was touched).
- Test counts: gateDecideRoute 28, gateResidency 9, gateTrustFacts 18. The equivalence runs 3,240 cases.
- Acceptance greps: `export interface RoutePolicy` 1, `export function endpointOf` 1, `export function residencyAllows` 1, `needsEndpointAuthorization` in routing.ts 4, `requireAccreditedDevice` in gateDecideRoute.test.ts 7, `export function effectiveClearances` 1, `FND-02: the default policy read as v2` in gateRouting.test.ts 1, `export function trustFactsFor` 1, `export function trustLine` 1.
- `node scripts/secret-scan.mjs --range 97a9bd22..HEAD`: clean. TLS pins in tests are SHA-256 digests made at test time.
- routing.ts, residency.ts and trust.ts import only from src/domain. Every function of a module in an import cycle (endpoints, authorizations, models, dominance, residency) is called only inside a function.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Residency exception check with no labels**
- **Found during:** Task 2.
- **Issue:** `labels.every(...)` over an empty label list is true without calling `authorizationCovers`. Any authorization, of any kind and for any place, would then have counted as a residency exception.
- **Fix:** with no label, the record is still asked once (label absent), so its kind, place, dates and scope are always checked.
- **Files modified:** src/domain/gate/residency.ts
- **Commit:** d3857a4f

**2. [Rule 2 - Correctness of a security claim] The trust place never calls a remote host "this computer"**
- **Found during:** Task 4.
- **Issue:** The plan reads "local route: local" for a decision with no place. A local runtime pointed at a host your routing names is not this computer.
- **Fix:** loopback reads as this computer; a host the routing's `localHosts` names reads as your organization's server; anything else reads as "a place your rules do not name". Tested both ways.
- **Files modified:** src/domain/gate/trust.ts
- **Commit:** 75f04a02

**3. [Rule 3 - Interface gap] Label on the authorization record, use in the residency question, verification in trustFactsFor's extra**
- The plan's `AllowingRecord` authorization shape has no label, but its trust-line example names one. Each is an optional field (see decisions). Commits d3857a4f and 75f04a02.

**4. [Acceptance grep] One phrase, one place**
- A section comment repeated the test title's phrase, so the `FND-02: the default policy read as v2` grep counted 2. I reworded the comment in a separate commit (ff30a595).

### Choices taken on defaults

Listed in the frontmatter `decisions`. All 41-CONTEXT defaults stand: D-34 (report unless the organization's switch is on), D-42 (passport report only, whatever mode says), D-53 (clearance only with a roster), D-54 (project-scoped authorizations cover nothing without a project), D-63 (route.export-control never returned).

### Test-file notes

- gateRecordIds.test.ts: only the exact-list assertion changed. It now names the ids moved (in ROUTE_RULES order, each sentence held to the same plain-words checks) and the ids still named ahead.
- gateRouting.test.ts: the every-rule cases gained an optional fourth member, passed as decideRoute's sixth argument; no existing case changed. There is one new case per moved id. The header lists the D-36 order.
- gateDecideRoute.test.ts calls decideRoute through a recording wrapper. Its last test shows that no decision made anywhere in the file returned `route.export-control`.

## Known Stubs

None. The passport and accredited-device reports are report mode by design (D-34, D-42); 41-13 writes `wouldRefuse` to the record and passes `RoutePolicy` from the client.

## Threat Flags

None beyond the plan's register:
- T-41-100: pin or fresh binding, plus an authorization naming the id.
- T-41-101: residency before sending, `unstated` never satisfies it, and exceptions only by a covering record.
- T-41-102: subject, project, label and use are checked at every step, with a test per mismatch.
- T-41-103: the new steps run only after an allowed decision, and the equivalence covers 3,240 cases.
- T-41-104: `wouldRefuse` is on the decision.

`pinTo` is a new output that the send must honour. It is carried to the send in 41-13; this plan only produces it.

## Self-Check: PASSED

- Files present: src/domain/gate/routing.ts, residency.ts, trust.ts; src/test/gateDecideRoute.test.ts, gateResidency.test.ts, gateTrustFacts.test.ts, gateRouting.test.ts, gateRecordIds.test.ts.
- Commits 82390f70, d3857a4f, f0e2b7ae, ff30a595 and 75f04a02 are ancestors of HEAD on feat/phase-41-10-decision-core.
