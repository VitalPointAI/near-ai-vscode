---
phase: 41-organization-policy-foundation-f1
plan: 02
subsystem: gate policy (layer composition and narrowing)
status: complete
tags: [policy, layers, narrowing, export-control, project-layer]
requires: [41-01 (PolicyDocument, section parsers, fixtures)]
provides:
  - layers.ts (NARROWING_DIRECTIONS, NarrowingDirection, NarrowingRule, NARROWING, LAYER_ENVELOPE_KEYS, directionOf, narrowingOf, composeLayers, LayerInput, ComposedPolicy, IgnoredSetting, wideningOf, widerThanOrganizationText, ignoredSettingsNotice, ProjectLayer, ProjectExercise, ComposedProject, parseProjectLayer)
affects: [41-09, 41-14, 41-08 (direction judge), 41-05 and 41-06 (wave 2 merge)]
tech-stack:
  added: []
  patterns: [one declared direction per key path, clamp and list at load, parse-checked effective document with an organization-only fallback, completeness walk plus source scan with planted keys]
key-files:
  created:
    - src/domain/gate/layers.ts
    - src/test/gateLayers.test.ts
  modified: []
decisions:
  - "The effective document is built as plain values and then read with parsePolicyDocument, so it is always a valid, frozen v2 document; if the combination does not parse, your organization's sections apply whole and one ignored entry `personal layer` is listed (never a lock-out, never wider)."
  - "A subset value wider than your organization's takes your organization's value (the plan's generic step), not the intersection."
  - "A personal value is not listed when it is empty, reserved, equal to what a section parser fills for `{ v: 1 }` (onboarding, limits, residency), or equal to the effective value after parsing (a parser default in its place). agents and exportControl have required keys, so their optional keys are listed when they differ."
  - "Absent keys: `weakest` keeps the personal value; `strictest` (the default) drops it and lists it, except boolean-safe keys, which take the safe value, and a tier key already at the strictest tier, which stays."
  - "exportControl.officials is organization-only for the regimes your organization lists; a regime only the personal layer adds keeps the personal layer's official, so every effective regime names its signer and the section parses."
  - "people.organization under an organization layer with no block of its own is dropped and listed (nothing to narrow against); with a block, mode is kept only within your organization's allowedModes and the rest composes by the table."
  - "narrowingOf takes an optional fourth argument `scales` (default SCALE_PRESETS) to read label levels for ceiling keys."
  - "IgnoredSetting keys for list items carry the id: `endpoints[<id>].<field>`, `authorizations[<id>]`; directionOf and narrowingOf read any `[id]` as `[]`."
metrics:
  duration: ~45 min
  completed: 2026-11-20
actuals:
  tokens: 23157
  tasks: 3
  commits: 3
plan_head_before: ce786119bcb5b7bd1016ed5ae49029d277c58bda
plan_head_after: e107a866ca08c0e23c29e6c0984c2a95328f136e
---

# Phase 41 Plan 02: Layers and narrowing Summary

One pure `composeLayers` that narrows your organization's layer by the personal layer key by declared key (clamp and list, never a lock-out), a `NARROWING` table with a direction for every key a v2 policy holds, the widening check for new edits, and the in-memory project layer.

## What was built

- **NARROWING** (64 entries, in policy editor order): labels (scales and defaultLabel organization-only; mappings subset; routing levels tier-stricter, absent strictest; handling and compartments tier-stricter, absent weakest, which covers the reserved CGP, ITAR and EAR entries of D-62), endpoints (membership subset, every field organization-only, maxLabel ceiling-dominated), authorizations (organization-only, admitting a personal record signed by a key in your organization's people.signers), models (D-42 keys), agents, residency (absent means every region), people (clearances by containment, signers organization-only, people.organization keys from 41-06's index note), onboarding, limits (absent means no ceiling), reserved (never listed), exportControl (regimes superset, suggestRules off to standard to automatic, officials and registration organization-only, agentNetwork and retention fixed with a declared direction, incidents.contacts organization-only).
- **composeLayers({ organization?, personal, project? })**: no organization layer gives `{ effective: personal, ignored: [] }` (the same object). With one: the personal envelope, the earlier expiry, the sorted union of `requires`; each key by its rule; wider personal values replaced and listed in table order; keys naming a scale or level your organization's scales lack dropped and listed; scan ranges whose network the effective list lacks dropped; the result parsed again.
- **D-28** endpoints: a personal entry your organization lacks counts only with `onboarding.discovery.personalApprovals` true, `maxLabel` exactly `["org/Public"]`, and a host no other entry has. **D-31** authorizations: compared by public key only; an export-endpoint record that would lack its legal basis for an effective place is dropped and listed.
- **narrowingOf(path, before, after, scales?)**, **wideningOf(organization, base, next)** (including a regime removal, D-60), **widerThanOrganizationText**, **ignoredSettingsNotice** (five, then "and N more").
- **ProjectLayer / parseProjectLayer** (strict: v, label, mode token, exercise with reason and setAt, locked from LOCKABLE_ANSWERS, regimes through parseRegimes) and project composition: mode kept within the effective allowedModes (or when none exist), your organization's locked answers win (the project's listed with layer `project`), label and exercise carried, `project.regimes` the union with the effective regimes. The project layer never changes `effective`.

## Tests

- `gateLayers.test.ts`: 24 tests (4 tracer, 14 for directions, endpoints, authorizations, clearances, scales, defaults, widening, notice, narrowingOf, tier orders, fallback, export control; 6 for the walk, the planted path, the source scan with a planted name, and the project layer).
- Failing first: Task 1 tests on the base (`Cannot find module '../domain/gate/layers'`); Task 2 tests on the Task 1 code (the four new exports missing); Task 3 tests on the Task 2 code (no `parseProjectLayer`, no `project` on LayerInput or ComposedPolicy). The completeness walk then failed for real on 18 list-item paths (see Deviations), and the strengthened scale test failed before the routing-level clean-up.
- Plan verify: gateLayers + gateBundleV2 49/49, `npm run lint` exit 0.
- Gate set (VALIDATION.md wave merge set, capped and locked): `gate*.test.js`, teamSignedPayload, teamBoundaries, replicaBoundaries, `staffObs*.test.js`: 1055 tests, 1055 pass, 0 fail, 0 skipped; lint exit 0.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 - Bug] List items under a subtree entry had no direction**
- Found during: Task 3 (the completeness walk). `directionOf('people.clearances[].scale')` and the same for officials, contacts, networks, scanRanges and signers returned undefined, because the subtree search compared `clearances[]` with `clearances`.
- Fix: the subtree search also reads the prefix with a trailing `[]` removed. Commit e107a866.

**2. [Rule 1 - Bug] A `deny` routing level on a scale your organization lacks forced the fallback**
- Found during: Task 3 review. The strictest tier is kept under `absent: strictest`, but it named a level the effective scales lack, so the effective policy did not parse and the whole personal layer was ignored.
- Fix: the scale clean-up also drops and lists such routing level keys; the scale test now plants one. Commit e107a866.

**3. [Rule 2 - Robustness] Non-list values under subset or superset, and two different kinds of value under one record key, compare as "same only"; your organization's value stands otherwise.** Commit e107a866.

### Test-side choices
- The walk uses 41-01's `fullDocumentFor(issuerKey())` plus one licence-based export-person record signed at test time, so `authorityExpiresAt` (named by a `checkKeys` call) is walked too. policyFixtures.ts is not edited.
- The source scan reads `checkKeys(` and `openSection(` calls and `const X_KEYS`, `_FIELDS`, `_REQUIRED` and `_OPTIONAL` lists (the plan named `_KEYS` and `_FIELDS`; the other two catch ENVELOPE_REQUIRED, ENVELOPE_OPTIONAL, BODY_REQUIRED and PEOPLE_OPTIONAL as well).
- Two tests beyond the plan: the tier orders equal ROUTING_TIERS and agree with `effectiveMode`, and the fallback when no combined envelope parses.

## Notes for the wave 2 merge and later plans

- **41-06 (people.organization):** the directions and the composition (`people.organization` dropped and listed under a layer without a block; mode within allowedModes; settings by the table) are in place, but a composition test needs 41-06's parser, because 41-01's stub refuses `organization`, so a composed document holding it falls back. The project mode test uses an in-memory document. Add a compose test for people.organization at the merge.
- **41-05 (models):** the D-42 keys have entries; passports, defaults, localCatalogue and order are organization-only subtrees. If 41-05 adds `checkKeys` names inside passports that neither the fixture walk nor a NARROWING path segment holds, the source scan reports them; the fix is to fill `models` in `fullDocumentFor` (so the walk reaches them) or add the entry, never a catch-all.
- layers.ts has 989 lines: above D-45's 800-line warning, under the 1,200 limit for a new file. 41-09 calls composeLayers and wideningOf; 41-14 shows ignoredSettingsNotice and builds 41-08's direction judge from narrowingOf.

## Known Stubs

None in this plan's files. The people.organization composition is complete in code; only its test waits for 41-06's parser (above).

## Threat Flags

None beyond the plan's register. T-41-20 (walk plus source scan with planted keys; unknown and incomparable values count as wider), T-41-21 (endpoint and authorization admission tests), T-41-22 (clamp and list, wideningOf ignores old clamps, fallback is your organization's rules), T-41-23 (round-trip parse and scale clean-up tests), T-41-24 (regime union, removal refused, reserved compartments tier-stricter) each have tests. No package was installed.

## Wave 2 merge fixes (branch feat/phase-41-02b-merge-fixes)

After 41-05 and 41-06 landed, the source scan failed on 41-05's passport keys. Fixed in 2ca3c200 and 04498abc:

- **models directions, each key declared (no subtree):** `mode` tier-stricter report to enforce (absent: report); `unknownMaxTier` tier-stricter over its one value T0; `tierByLevel.*` and `tierByProject.*` tier-stricter T0, T1, T2, T3 with absent weakest. This corrects the plan's order: useTierFor only raises a request's tier, and a higher tier needs a more trusted model, so the higher tier is the narrower one.
- **Passports are your organization's.** A personal layer cannot add one, because a model with no passport is T0 and a passport replaces a shipped one by id. It cannot drop, raise or lower one either: without it, or with it lower, another matching passport can become the stricter one that applies, with wider hosting. Every field is organization-only except `hosting`, which may narrow to fewer classes, because which passport applies never depends on it. `localCatalogue` is a subset (fewer downloads), with organization-only entries. `defaults.*` and `order` are organization-only.
- **people.organization:** the permissions (mayDecline, acting, temporary, dualHatting, guests) and enrolAtReport now carry `absent: 'default'`. Where your organization leaves one to the mode, a personal safe value stays and any other personal value goes unlisted (the mode decides), so a personal `true` can no longer make the effective block fail to parse.
- **Fixture:** `fullDocumentFor` holds a full models section (`fixturePassport`, `fixtureModelsSection`) and a people.organization block (`fixtureOrganizationBlock`), so the walk and the source scan cover every key.
- **Outside 41-02's files:** proposal.ts (41-08) words models changes plainly. With models in the full fixture, its generic sentence showed schema names (`tierByLevel`), which the editor's copy rule forbids.
- **Tests:** 6 new in gateLayers (30 in all) (the models direction walk, both ways for each models direction, passports neither added nor dropped nor raised nor lowered, narrowingOf for models, and two people.organization compose tests) and 1 in gatePolicyProposal. The models and permission tests failed on the merged code first.

## Self-Check: PASSED

- Files: src/domain/gate/layers.ts and src/test/gateLayers.test.ts exist in the worktree.
- Commits: 725acceb, 94b53b05, e107a866 are ancestors of HEAD on feat/phase-41-02-layers.
