---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 04
subsystem: gate
tags: [routing, route-decision, label-map, raise-only, signed-payload, pure-domain]

requires:
  - phase: 70-03
    provides: "RoutingTable, DEFAULT_ROUTING, TIER_ORDER, ROUTING_HANDLING_FLAGS and parseRouting"
  - phase: 70-02
    provides: "labels, scale presets, raiseMark and the Mark type"
  - phase: 69
    provides: "signPayload and verifyPayload, PAYLOAD_PURPOSES"
provides:
  - "src/domain/gate/routing.ts: tierForLabel, tierForMark, isLocalRouteHost, RouteFacts, RouteDecision, ROUTE_RULES, ROUTE_REFUSALS, decideRoute (CLAS-05, CLAS-06)"
  - "src/domain/gate/labelMap.ts: label map v1, labelMapKey, parseLabelMap, resolveLabel, setLabelEntry, setProjectLabel, moveLabelEntry, missingLabelPaths, MAX_LABEL_MAP_BYTES (CLAS-01)"
  - "the label-map payload purpose on Phase 69's one signer"
  - "LOOPBACK_HOSTS exported from src/domain/config.ts"
  - "src/test/gateRouting.test.ts: 14 tests; src/test/gateLabelMap.test.ts: 12 tests"
affects: [70-05, 70-06, 70-07, 70-19]

actuals:
  tokens: 21000
  tasks: 2
  commits: 2
plan_head_before: dad3762e25ff54591d6dc532a1750886c8fa8d92
plan_head_after: ef30af99b9af232b51f51137364a82aae6258a7e
commits: 2

tech-stack:
  added: []
  patterns:
    - "Route decision from local facts only: the TEE flag and NEAR's own endpoint are judged before sending, with no network call and no clock"
    - "Closed refusal table: every refusing rule is one key of ROUTE_REFUSALS with one sentence that starts 'Nothing was sent.' and names the fix"
    - "Entries objects are built with Object.fromEntries, so a path named __proto__ is an ordinary own entry and no prototype changes"

key-files:
  created:
    - src/domain/gate/labelMap.ts
    - src/test/gateRouting.test.ts
    - src/test/gateLabelMap.test.ts
  modified:
    - src/domain/gate/routing.ts
    - src/domain/config.ts
    - src/domain/team/signedPayload.ts
    - src/test/teamSignedPayload.test.ts

key-decisions:
  - "A label whose scale/level has no entry in the routing table is denied, not guessed: an unknown label can only narrow where content goes"
  - "tierForMark and decideRoute take an optional default label; an empty mark with none supplied is deny, because nothing is known about what the chat has read"
  - "A local client on a local host serving a non-local model is refused as route.not-tee at attested-cloud and route.no-local-model at local-only; a local client on a non-local host is route.local-host-not-local at both"
  - "A request that did not say its route (clientRoute undefined) is refused with route.no-session above any-cloud and allowed at any-cloud"
  - "An unverified map is read down its own chain (file, nearest folder, project) and joined onto the verified result with raiseMark; origin always names where the verified sources took the label from"
  - "A label map key is valid only in its canonical form (normalised, folders with a trailing slash), so one entry has one spelling"

patterns-established:
  - "labelMapKey(path, isFolder) returns Parsed<string>; setLabelEntry and moveLabelEntry take only keys that came from it and throw a RangeError on any other"

requirements-completed: [CLAS-01, CLAS-05, CLAS-06]

duration: about 40 min
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 04: Route decision, label map v1 and the label-map purpose Summary

**The pure route decision (strictest tier of a mark, then client, endpoint and model judged against it from local facts, each refusal one plain sentence saying nothing was sent), the label map v1 with the file, folder, project, default resolution order where an unverified map can only raise a label, and the `label-map` purpose on Phase 69's signer.**

## Performance

- **Duration:** about 40 min (start time was not captured, so this is an estimate)
- **Completed:** 2026-11-16
- **Tasks:** 2 (a tracer, then the label map)
- **Files:** 3 created, 4 modified

## Accomplishments

- `tierForLabel` takes the level's tier from the bundle table and makes it stricter by any compartment entry and by the table's entry for any handling flag the label carries (only `local-only` is a routing key; `no-agent-tools` never changes a tier, D-47). `tierForMark` takes the strictest over every label in the order any-cloud, attested-cloud, local-only, deny; a test runs all 24 orderings of four labels and gets one answer.
- `decideRoute(mark, routing, facts)` implements the must-haves: `deny` refuses; `local-only` needs a local client on a loopback host or a host the table names, serving a model the catalog marks `local`; `attested-cloud` needs a TEE model on NEAR AI Cloud's own endpoint with no failed attestation this session, or a local model as above; `any-cloud` allows everything. A stricter destination satisfies a looser tier. An unknown model, a model with no `privacyBoundary` and a catalog not loaded all count as not private above any-cloud (D-36).
- `isLocalRouteHost` reads a URL or a bare host (with or without a port), lowercases it, accepts `LOOPBACK_HOSTS` (now exported from `config.ts`) or an exact or `*.example.com` entry of `routing.localHosts` (a wildcard matches subdomains, never the bare domain, never `evillan.example.com`). Lookalikes such as `localhost.example.org` and `127.0.0.1.example.org` are not local (T-70-13, CLAS-06).
- Nine rule ids and six refusal sentences. A test reaches every rule id and checks every refusal starts with `Nothing was sent.`, has no em-dash and never says "NEAR organization". `route.no-session` is reachable here too (see Deviations).
- Label map v1 (`labelMap.ts`): `parseLabelMap` has closed keys, version checks (`unknown-version` for a version other than 1) and runs every label through `parseLabel`; keys must be canonical (normalised, folders end in `/`) and a `..` segment, a leading `/`, a backslash, a drive prefix, a control character and more than 512 characters are refused. `resolveLabel` goes file, nearest ancestor folder, project, bundle default, with path boundaries tested (`src2/x.ts` does not inherit from `src/`, and a file `src` is not the folder `src/`).
- Raise-only unverified maps (D-25, T-70-12): the unverified map is read down its own chain and joined onto the verified result through `raiseMark` only. A mutation check (replacing the join with a straight replace) failed two tests, so the tests bite. `raisedByUnverified` is true only when the mark actually changed.
- `setLabelEntry`, `setProjectLabel`, `moveLabelEntry` (a folder key moves its whole subtree; a moved entry replaces what the destination held) and `missingLabelPaths` all return new objects and leave the input alone. `MAX_LABEL_MAP_BYTES` is 200 KiB, below `MAX_PAYLOAD_BYTES`.
- `label-map` is the fifth entry of `PAYLOAD_PURPOSES`. A label map signs and verifies through the one signer, a signature made for `label-map` fails as `wrong-purpose` when checked as `policy-bundle` and the reverse (T-70-15), and a path key shaped like a secret makes `signPayload` throw a `PayloadError` that does not repeat the path (Pitfall 9; the later writer must catch it and name the path).

## Task Commits

1. **Task 1: Tracer, a mark goes to a tier and a client, endpoint and model are judged against it** - `fc0d2ba` (feat); `LOOPBACK_HOSTS` exported, routing decision and `gateRouting.test.ts`.
2. **Task 2: Label map v1, the resolution order, raise-only unverified maps and the label-map purpose** - `ef30af9` (feat)

## Verification

Each run inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536`.

- Task 1: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateRouting.test.js dist/test/gateBundle.test.js dist/test/teamBoundaries.test.js'`: 61 tests, 61 pass, 0 fail, 0 cancelled.
- Task 2 and plan level: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateLabelMap.test.js dist/test/gateRouting.test.js dist/test/teamSignedPayload.test.js dist/test/teamKeyHistory.test.js dist/test/teamBoundaries.test.js'`: 75 tests, 75 pass, 0 fail, 0 cancelled, 0 skipped. The same set plus `gateBundle.test.js` gave 118 tests, 118 pass. No full suite or e2e was run, as the plan asks.
- Acceptance: `grep -c "export const LOOPBACK_HOSTS" src/domain/config.ts` prints 1; the `config.ts` diff is one line; `grep -c "'label-map'" src/domain/team/signedPayload.ts` prints 1; the `teamSignedPayload.test.ts` diff adds one sample and changes one literal and removes no assertion; `package.json` and `package-lock.json` are unchanged; no em-dash in any file written here; no local path.

## Changes to existing files (PR 1 must change no extension behaviour)

- `src/domain/config.ts`: one word added, `export` before `const LOOPBACK_HOSTS`. No value change; `isSecureEndpoint` is untouched.
- `src/domain/team/signedPayload.ts`: `'label-map'` appended to `PAYLOAD_PURPOSES`. No other line.
- `src/test/teamSignedPayload.test.ts` (the only change to an existing test, deliberate, as the plan requires): (1) a `'label-map'` entry added to `SAMPLES`, which `Record<PayloadPurpose, unknown>` makes the compiler demand once the purpose exists; (2) the literal in the "every purpose round-trips" test changed from four purposes to `['policy-bundle', 'grant', 'approval-answer', 'key-record', 'label-map']`. No assertion was removed or weakened and every other teamSignedPayload test passes unchanged.
- `src/domain/gate/routing.ts` (from plan 03): header comment updated and new exports appended; the table, default and parser are unchanged. Nothing imports the new code yet, so the running extension is unchanged.

## Decisions Made

See key-decisions above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] An unlisted level and an empty mark must fail closed**
- **Issue:** the plan says an empty mark "returns the default label's tier" but `tierForMark(mark, routing)` has no default label, and `parseRouting` guarantees a complete table only for declared scales.
- **Fix:** `tierForMark` and `decideRoute` take an optional last argument `defaultLabel`; an empty mark without it is `deny`, and a label with no table entry is `deny`.
- **Committed in:** `fc0d2ba`

**2. [Rule 2 - Missing critical] A request with no route named**
- **Issue:** `RouteFacts.clientRoute` may be undefined; the plan lists `route.no-session` as "used in plan 19".
- **Fix:** `decideRoute` returns `route.no-session` above any-cloud when `clientRoute` is undefined (fail closed), and allows it at any-cloud. The rule id is also reachable and tested here, so plan 19 may use it for a missing session as well.
- **Committed in:** `fc0d2ba`

**3. [Rule 3 - Blocking] `resolveLabel` needs the scales**
- **Issue:** `raiseMark` joins labels on a `ScaleTable`, and the plan's option list (`verified`, `unverified`, `bundleDefault`) has none.
- **Fix:** the options object also takes `scales`. Callers have it from the verified bundle.
- **Committed in:** `ef30af9`

**4. [Rule 1 - Bug in my own output] A literal em-dash reached `gateRouting.test.ts` in the Task 1 commit**
- **Fix:** the no-dash check now builds the character with `String.fromCharCode(0x2014)`, in the Task 2 commit `ef30af9`. The Task 1 commit `fc0d2ba` still holds the literal in that one test line; history is not rewritten.
- **Committed in:** `ef30af9`

**Plan wording, not deviations:** `setProjectLabel` is one export beyond the plan's list, because `setLabelEntry` takes only file and folder keys and a writer needs a way to set the project entry. No existing assertion was changed other than the two recorded above.

---

**Total deviations:** 4 auto-fixed. **Impact on plan:** none on scope.

## Issues Encountered

One test of mine failed on the first run: it listed the key `src` among refused keys, but a file named `src` is a valid key. The test was wrong, not the code; it was corrected, not weakened.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. The threat model is covered: T-70-12 (unverified map lowering a label) by `raiseMark`-only joining and the two mutation-checked tests; T-70-13 (remote URL as a local runtime) by the loopback-or-localHosts rule and the lookalike-host tests; T-70-14 (forwarded model at attested-cloud) by the TEE flag, NEAR endpoint and unknown-model-is-not-private tests; T-70-15 (replay across purposes) by the wrong-purpose tests in both directions; T-70-SC: no package added.

## User Setup Required

None.

## Next Phase Readiness

- Plan 19 (session and route wiring) can call `decideRoute(mark, bundle.routing, facts, bundle.defaultLabel)` with facts built from `PrivateRoute`, `isNearCloudEndpoint`, the cached catalog entry and a per-session attestation flag. `route.no-session` already covers a missing route.
- The label map writer must catch `PayloadError` from `signPayload` and name the path (Pitfall 9), refuse to write above `MAX_LABEL_MAP_BYTES`, and use `labelMapKey` for every key before `setLabelEntry` or `moveLabelEntry`.
- Reversibility reminder for the owner (task 2 was rated costly): the label map's `labelMapVersion`/`vocabulary`/`project`/`entries` shape, the trailing-slash folder keys and the purpose name `label-map` end up in projects people share, so a change after release is `labelMapVersion` 2 and a re-sign of every map.

## Self-Check: PASSED

- Files present: `src/domain/gate/labelMap.ts`, `src/test/gateRouting.test.ts`, `src/test/gateLabelMap.test.ts`, and the four modified files.
- Commits `fc0d2ba` and `ef30af9` are on `feat/gate-vocabulary`; `git rev-list --count` from the recorded base `dad3762` to `ef30af9` is 2.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*
