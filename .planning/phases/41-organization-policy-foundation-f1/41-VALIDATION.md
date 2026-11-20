# Phase 41: One foundation - Validation strategy

**Framework:** `node:test` with `node:assert/strict`, compiled by `tsc` to `dist/test` (`npm run compile`), run only through `scripts/run-tests.mjs`.

**Quick run (one or two files, after each task):**

```
systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run compile && node scripts/run-tests.mjs dist/test/<file>.test.js'
```

Scripts tests: the same wrapper with `node scripts/run-tests.mjs scripts/test/<file>.test.mjs`.

**Wave merge (gate set, after each wave is merged into the phase branch):** the quick wrapper over `dist/test/gate*.test.js dist/test/teamSignedPayload.test.js dist/test/teamBoundaries.test.js dist/test/replicaBoundaries.test.js dist/test/staffObs*.test.js` plus, from wave 3, `dist/test/architecture.test.js dist/test/copyLint.test.js`, and `npm run lint`.

**Phase gate (once, in 41-15):**

```
flock "$HEAVY_LOCK" systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 npm test
```

The executor sets `HEAVY_LOCK` to the shared lock file for the session; one heavy run at a time. e2e (`env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE xvfb-run -a npm run test:e2e`, same 6G cap, under the lock) runs once in 41-15 because 41-14 changes commands, activation and a webview.

**Blocking at every step:** signing, policy parsing, layer composition, enrolment and routing tests (security and data integrity). A failing test is never skipped, weakened or deleted.

| Req | What must be proven | Test files (new unless "extend") | Plan |
|---|---|---|---|
| FND-01 | narrowing only; a widening personal edit refused with the key named; wider personal values clamped and listed; every key has a direction; a device-signed "organization" layer refused; twelve words over a domain distinct from the safety code; pin in secret storage; older layer refused; expiry fails closed; Reset touches the personal layer only; crash between layer file and pin leaves "not enrolled" | `gateLayers`, `gateEnrolment`, `scripts/test/orgIssuer`, `gateOrganizationStore`, `gateBundleStore` (extend), `gateEnrolCommand` | 41-02, 41-03, 41-09, 41-14 |
| FND-02 | default v1 bundle reads as v2 with the same effective view and hash; a feature id this client lacks gives `needs-update` with no Reset text; a section without its id is malformed; Edit and Apply write v2 | `gateBundleV2`, `gateBundle` (extend) | 41-01, 41-09 |
| FND-03 | endpoint schema and refusals; each `localHosts` form migrates at today's effect except Protected B; the notice shows once | `gateEndpoints`, `gateOrganizationStore`, `gateCommands` (extend) | 41-01, 41-09, 41-14 |
| FND-04 | every kind and its maximum length; verified only against the named signers; the self-signed flag; 2,000 random authorizations sign without a secret-scanner refusal | `gateAuthorizations`, `teamSignedPayload` (extend) | 41-01 |
| FND-05 | `route.residency` refuses and a residency exception allows; `unstated` never satisfies; accredited device records and allows, and refuses only under the organization switch | `gateResidency`, `gateDecideRoute` | 41-10 |
| FND-06 | the decision table per class, tier and new rule; Protected B needs pin or binding plus authorization; floors from `privacyMode`, `privacy: private` and `teeOnly` decide through `decideRoute`; staff observations, guard scan and the chat label agree with the gate on a custom scale; `TrustFacts` and the three-part trust line | `gateDecideRoute`, `gateTrustFacts`, `gateLabelModule`, `gatePrivacyFloor`, `gateRouting`, `gateRouteTiers`, `gateRouteGuard`, `gateOutbound`, `gateTrustBadge` (extend) | 41-04, 41-10, 41-13 |
| FND-07 | four modes, every concept key in every mode, behaviour table, declining never in assignment modes, depth default 0 and at most 2; the copy lint passes with its baseline and fails on a planted hit for each rule, including a bare "team" | `orgModes`, `copyLint` | 41-06, 41-11 |
| FND-08 | each WP-0 refusal; the stricter of two overlapping passports; `useTierFor` table; report mode records `wouldRefuse` and allows | `gatePassports`, `gateDecideRoute` | 41-05, 41-10 |
| FND-09 | `NearAiClient` is assignable to `ModelEndpoint`; a fake endpoint drives the agent loop; the architecture test has teeth and passes with its baseline; proposal directions and sentences; Apply only where this device signs | `providerEndpoint`, `architecture`, `gatePolicyProposal`, `policyEditor` | 41-07, 41-08, 41-12 |
| Docs | SECURITY.md and README sentences word for word | `gateDocs` (extend) | 41-15 |

**Regression proof:** each new behaviour test is run once on the unchanged base first and must fail there; the executor records that failing run in the plan summary.
</content>
