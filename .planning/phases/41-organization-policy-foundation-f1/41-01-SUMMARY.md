---
phase: 41-organization-policy-foundation-f1
plan: 01
subsystem: gate policy (bundle v2 contract)
status: complete
tags: [policy, bundle-v2, endpoints, authorizations, export-control, signed-shapes]
requires: [safety patch on the base (S1, S2, S4, S6, S7, S8)]
provides:
  - features.ts (FEATURE_IDS, POLICY_SECTIONS, featureForSection)
  - policyDocument.ts (PolicyDocument, parsePolicyDocument, documentFromBundle, bundleViewOf, verifyPolicyLayer)
  - endpoints.ts (PolicyEndpoint, parseEndpoints, endpointCeilingAllows, findEndpoint, needsEndpointAuthorization, migrateLocalHosts)
  - authorizations.ts (AuthorizationBody, parseAuthorizations, verifyAuthorization, authorizationCovers, SELF_SIGNED_TEXT)
  - sections.ts (labels, agents, reserved, residency, onboarding, limits, exportControl)
  - models.ts and peopleSection.ts strict stubs for 41-05 and 41-06
  - route ids named ahead, seven policy events, four signing purposes, record policy versions and wouldRefuse
affects: [41-02, 41-03, 41-04, 41-05, 41-06, 41-07, 41-08, 41-09, 41-10, 41-13, 41-14, 41-15]
tech-stack:
  added: []
  patterns: [strict checkKeys sections with own v, defaults filled so a document is its own wire form, one key source per verification, ids named ahead]
key-files:
  created:
    - src/domain/gate/features.ts
    - src/domain/gate/policyDocument.ts
    - src/domain/gate/sections.ts
    - src/domain/gate/endpoints.ts
    - src/domain/gate/authorizations.ts
    - src/domain/gate/models.ts
    - src/domain/org/peopleSection.ts
    - src/test/helpers/policyFixtures.ts
    - src/test/gateBundleV2.test.ts
    - src/test/gateEndpoints.test.ts
    - src/test/gateAuthorizations.test.ts
  modified:
    - src/domain/gate/bundle.ts
    - src/domain/gate/routing.ts
    - src/domain/gate/decide.ts
    - src/domain/gate/record.ts
    - src/domain/team/signedPayload.ts
    - src/test/gateBundle.test.ts
    - src/test/gateRecordIds.test.ts
    - src/test/teamSignedPayload.test.ts
decisions:
  - "FEATURE_ID_PATTERN was not widened: the base already accepts labels@1 and export-control@1 (D-50); it is now exported unchanged."
  - "verifyPolicyLayer accepts a personal layer only under policy-bundle and an organization layer only under org-policy-layer; a project layer has no signing purpose in Phase 41, so it is malformed under both."
  - "verifyAuthorization uses the listed signers whenever `signers` is given (even empty), otherwise this device alone; selfSigned is true when the signing key is this device's."
  - "An endpoint maxLabel may be empty (reaches nothing); [::1] is accepted as a loopback endpoint host; a discovery network needs a gateway or a DNS suffix (either or both)."
  - "residency.required and byLevel values are region lists (CA, EU, US), sorted and non-empty; unstated is refused."
  - "Contacts are sorted by topic then name; exportControl.registration entries need registered, reference and endsOn; scope.projects never takes `*` (an absent list is any)."
  - "Under an update reason (unsupported-version, vocabulary-unknown, needs-update) with a valid minClient, the failed state's sentence is needsUpdateSentence(minClient); without one it is the shipped sentence."
metrics:
  duration: ~55 min
  completed: 2026-11-20
actuals:
  tokens: 69869
  tasks: 5
  commits: 5
plan_head_before: 1c15e9cc26820b60d06ebda9203c2b95a33550dc
plan_head_after: d58f5ac2
---

# Phase 41 Plan 01: Contract (bundle v2, endpoints, authorizations, ids) Summary

Policy bundle v2 as one frozen `PolicyDocument` read from both wire forms, with strict sections, one endpoint list (and the `localHosts` migration at today's effect), one authorization record checked against exactly one key source, the export-control shapes, and every rule id, event, purpose and record field the phase writes, all named before anything writes them.

## What was built (contract names as shipped)

- **features.ts** (no imports): `FEATURE_IDS` = labels@1, endpoints@1, authorizations@1, residency@1, models@1, agents@1, people@1, onboarding@1, limits@1, layers@1, export-control@1; `FeatureId`; `POLICY_SECTIONS` (labels, endpoints, authorizations, models, agents, residency, people, onboarding, limits, reserved, exportControl); `featureForSection` (exportControl gives export-control@1, reserved gives undefined); `ALWAYS_REQUIRED_FEATURES`; `isFeatureId`, `isPolicySectionName`.
- **bundle.ts** (786 lines): `KNOWN_BUNDLE_FEATURES` is a frozen copy of `FEATURE_IDS`; `FEATURE_ID_PATTERN`, `checkRequires`, `parseIssuer`, `parseTimestamp`, `parseText`, `parseMaxMode`, `parseContexts`, `parseServerIds`, `parseMcpLabelCeilings`, `parseScales`, `parseList`, `parseSetList`, `clearanceKey`, `mappingKey`, `parseAnchorRoot`, `parseStatusList`, `parseMaxOfflineAge`, `checkNumbers`, `payloadReason`, `shapeReason`, `FINGERPRINT_PATTERN`, `CLOCK_SKEW_MS` and their limits exported unchanged; `shapeReason` gives unsupported-version at bundleVersion, vocabulary-unknown at vocabulary, needs-update elsewhere, and malformed for missing-field at `requires`; `needsUpdateSentence(minClient?)`; seven new `POLICY_EVENT_IDS`; `isDefaultBundle` also accepts the starting rules as shipped before (no compartments); `renewalPayload(bundle, now)` for 41-09. `parseBundle` and `verifyBundleEnvelope` are unchanged v1 readers.
- **policyDocument.ts**: `POLICY_LAYERS`, `PolicyLayerName`, `MAX_ORGANIZATION_LAYER_BYTES` (1 MiB), `MIN_CLIENT_PATTERN`, `PolicyParent`, `PolicyDocument`, `parsePolicyDocument(value, path = '')`, `documentFromBundle`, `bundleViewOf`, `minClientOf`, `verifyPolicyLayer(envelope, { purpose, status, now, lastValidAt? })` giving `PolicyLayerState` (valid with wireVersion, hash, signer, expiresAt, renewDue; or BundleState's failed-closed). Includes the D-61 legalBasis check by endpoint class.
- **sections.ts**: labels, agents (requireAccreditedDevice filled false), reserved, residency (`RESIDENCY_REGIONS`), onboarding (`CONTACT_TOPICS` with export-control, `LOCKABLE_ANSWERS`, `KINDS_OF_WORK`, `PolicyContact`, `parseContacts`, discovery), limits (`MAX_VAULT_HOURS_PER_DAY`), exportControl (`EXPORT_REGIMES`, `SUGGEST_RULES`, `parseRegimes` for 41-02's project layer, `parseExportControlSection`), plus `openSection` and `checkSectionVersion` for later sections.
- **endpoints.ts**: `ENDPOINT_CLASSES`, `ENDPOINT_REGIONS`, `ENDPOINT_SCHEMES`, `PolicyEndpoint`, `MAX_ENDPOINTS` (128), `THIRD_PARTY_REFUSED_LEVELS`, `PATTERN_HOST_CEILING`, `parseEndpoints`, `endpointCeilingAllows`, `endpointHostOf`, `findEndpoint` (`EndpointMatch`), `needsEndpointAuthorization`, `migrateLocalHosts` (`MigrationChange`). Uses routing.ts only inside functions and imports nothing from bundle.ts.
- **authorizations.ts**: `AUTHORIZATION_KINDS` (five plus export-person and export-endpoint), `SUBJECT_FOR_KIND`, `MAX_DAYS_BY_KIND`, `CGP_BASES`, `CGP_EXTENTS`, `US_EXPORT_BASES`, `LEGAL_BASIS_EXEMPT_CLASSES`, `AuthorizationBody`, `PolicySigner`, `parseAuthorizationBody`, `parseAuthorizations`, `parsePolicySigners`, `AUTHORIZATION_REFUSALS`, `verifyAuthorization`, `latestExpiryFor`, `authorizationCovers` (with regime), `SELF_SIGNED_TEXT`.
- **models.ts** and **org/peopleSection.ts**: strict stubs. `{ v: 1 }` parses; models' schema keys are not-available-yet; people holds clearances and signers, `organization?: never` (not-available-yet).
- **routing.ts**: `ROUTE_RULES_NAMED_AHEAD` (ten ids ending with route.export-control), `NamedAheadRouteRule`, `ROUTE_REFUSALS_NAMED_AHEAD`; `DEFAULT_ROUTING.compartments` = CGP, EAR, ITAR at local-only. `ROUTE_RULES`, `ROUTE_REFUSALS` and `ROUTE_EVENT_IDS` unchanged.
- **decide.ts / record.ts**: `RECORD_RULE_IDS` joins the named-ahead rules; `POLICY_RECORD_VERSIONS` (bundle-1, bundle-2), `DecisionRecordInput.policyVersion` and `.wouldRefuse` (written sorted to `unmapped.nearAi.wouldRefuse`), both checked by `validateDecisionRecord`; named-ahead rules are model-request records.
- **signedPayload.ts**: org-enrolment, org-policy-layer, policy-authorization, policy-proposal appended; org-release reserved by name in a comment only.
- **policyFixtures.ts**: `FIXED_NOW` (epoch ms), `DAY_MS`, `issuerKey`, `deviceKey`, `activeKeys`, `policyDocumentFor`, `fullDocumentFor(key, { layer? })` (every section and optional key, organization layer by default), `fixtureEndpoints`, `fixtureAuthorizations`, `NAMED_PERSON`, `signerEntry`, `authorizationFor`, `signAuthorization`, `exportControlExample`, `exportPersonExample`, `signPersonalLayer`, `signOrganizationLayer`, `enrolmentFileFor`.

## The seven contract choices, as built

1. `parseBundle` and `verifyBundleEnvelope` stay v1 readers; `verifyPolicyLayer` is the v2 reader; a view is never signed.
2. New route rules sit in `ROUTE_RULES_NAMED_AHEAD`; gateRouting's every-rule-reached test is untouched and passes.
3. route.accredited-device, route.clearance and route.model-not-allowed are named ahead; route.not-accredited stays the report event; no id is on two lists (tested).
4. `needsEndpointAuthorization`: Protected B always; any other local-only level except org/Restricted and THIS_COMPUTER_ONLY_LEVELS. On the shipped scales: Protected B and NATO Restricted.
5. A `*.` host may hold nato/NATO Unclassified (and org/Restricted, Protected A at most).
6. Feature ids stay lowercase; the pattern was not widened because the base accepts `@N`.
7. `renewalPayload(bundle, now)` ships pure here; bundleStore.ts is untouched (41-09 calls it in tryRenew).

## Tests

- gateBundleV2: 25 tests; gateEndpoints: 19; gateAuthorizations: 22; gateBundle, gateRecordIds and teamSignedPayload extended.
- Failing on the unchanged base: with the base sources (1c15e9cc) and these test files, `tsc --noEmit` fails in all six test files and the fixture helper (55 errors: the modules and names they test do not exist there). Beyond compiling, the changed assertions contradict base behaviour: base `KNOWN_BUNDLE_FEATURES` is empty (labels@1 is needs-update there), `DEFAULT_ROUTING.compartments` is empty, `POLICY_EVENT_IDS` has five ids, `PAYLOAD_PURPOSES` lacks the four purposes, and records carry no policyVersion or wouldRefuse.
- Final focused run (capped, locked): `gate*.test.js`, teamSignedPayload, teamBoundaries, replicaBoundaries, `staffObs*.test.js`: 1031 tests, 1031 pass, 0 fail. `npm run lint` exits 0.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 - Blocking] Signing purposes moved from Task 3 into Task 1**
- Found during: Task 1. `verifyPolicyLayer` takes the purpose `org-policy-layer` as a type, so the four purposes (and the teamSignedPayload samples and exact-list test) had to land with the tracer.
- Files: src/domain/team/signedPayload.ts, src/test/teamSignedPayload.test.ts. Commit: 7153c688.

**2. [Rule 1 - Test expectation] gateBundle S6 `@N` test**
- `labels@1` became a known feature (D-06), so the base test's needs-update loop now uses `labels@2`; the same loop also gained `org-layer`, and the wrong-type loop gained `labels@01`, `Labels@1` and `Has Capitals`. The two "compartments are empty" assertions became the three D-62 entries, as the plan states. No assertion was dropped.

### Choices taken on defaults (owner accepted all 41-CONTEXT defaults)
Listed in the frontmatter `decisions`. Also: an authorization envelope with another `v` number is unknown-version (reads as "update"); issuedAt different from the signing time is `signer-mismatch` (the bundle's repeat-check precedent); a verifier `key-mismatch` maps to `bad-signature`.

## Known Stubs

- src/domain/gate/models.ts: every models schema key is not-available-yet. Intentional; plan 41-05 fills it with the same names and signature.
- src/domain/org/peopleSection.ts: `organization` is not-available-yet (`organization?: never`). Intentional; plan 41-06 fills it.
- Neither stub blocks this plan's goal. They were not written to `.planning/WINDOWS.md`, because this executor writes only its SUMMARY among planning files (shared files are the orchestrator's in a parallel wave).

## Threat Flags

None beyond the plan's threat register. T-41-01 to T-41-06 each have tests (strict keys and requires coverage; one key source and the device-signed organization layer as unknown-key; class and pattern ceilings with losses listed; 2,000 random keys signing inside 40 organization layers, plus the 1 MiB and 256 KiB caps; v1 readers unchanged; citizenship and birth date fields refused and the export compartments local-only).

## Notes for later plans

- Domain files use imported values only inside functions; models.ts and endpoints.ts import nothing from bundle.ts, so 41-10's routing.ts may import them.
- A refusal path shows `/` as `?` (shape.ts `safePath`), for example `residency.byLevel.org?Internal`.
- bundle.ts has 786 lines, 13 under the 800 limit.

## Self-Check: PASSED

- Files: all 11 created files and 8 modified files are present in the worktree.
- Commits: 7153c688, 9831003c, a9260094, 002f46f1, d58f5ac2 are ancestors of HEAD on feat/phase-41-01-contract.
