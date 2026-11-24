---
phase: 71-identities-and-verified-credentials-core
plan: 06
subsystem: gate-policy
status: complete
tags: [credentials-section, agreements-section, issuer-authority, devices-never-issue, policy-layers, tighten-only]
requires:
  - "71-03: types.ts (PERSON_ATTRIBUTE_TYPES, ROLE_TYPES), profile.ts (VerifiedCredential)"
  - "71-04: didWebvh.ts (methodsAt, WebvhState), didKey.ts (resolveDidKey)"
provides:
  - "src/domain/gate/credentialsSection.ts: parseCredentialsSection, CredentialsSection, IssuanceRule, StatusListPolicy, requirementsOnlyTighten, DEFAULT_OFFLINE_AGE_EXAMPLES, DEFAULT_STATUS_TTL_SECONDS, CREDENTIALS_LOOSENED_TEXT"
  - "src/domain/gate/agreementsSection.ts: parseAgreementsSection, Agreement, AgreementsSection"
  - "src/domain/credentials/issuerAuthority.ts: issuerAuthority, isPersonIssuer, ISSUER_REFUSALS, RoleEvidence, IssuerPolicy, IssuerDidState"
  - "features credentials@1 and agreements@1 (appended to FEATURE_IDS, POLICY_SECTIONS and SECTION_FEATURES)"
affects: [71-07, 71-08, 71-09, 71-11, 71-12, 33.1-20, 48.1-05, 45.1-01, 70.1]
tech-stack:
  added: []
  patterns:
    - "issuerAuthority decides authority only: the caller verifies proofs (profile.ts) and role status (statusList.ts) first and passes the results"
    - "A .* superset narrowing entry: a personal or project layer may add to each data key's list and never drop from it; wideningOf names a drop before signing"
key-files:
  created:
    - src/domain/gate/credentialsSection.ts
    - src/domain/gate/agreementsSection.ts
    - src/domain/credentials/issuerAuthority.ts
    - src/test/policyCredentialsSection.test.ts
    - src/test/credentialsIssuerAuthority.test.ts
  modified:
    - src/domain/gate/features.ts
    - src/domain/gate/policyDocument.ts
    - src/domain/gate/proposal.ts
    - src/domain/gate/layers.ts
    - src/gate/organizationStore.ts
    - src/test/gateBundleV2.test.ts
    - src/test/gateOrganizationStore.test.ts
decisions:
  - "issuance names person-attribute types only; role credentials come from the root alone and a device binding from its person, so neither is in the table"
  - "The root issues role credentials and nothing else (root-issues-roles-only), including no DeviceBindingCredential"
  - "Status lists in credentials@1 are { uri, purpose, key }: the list's id, revocation or suspension, and the Multikey of the status-list key that must sign it"
  - "statusTtl and maxOfflineAge are whole seconds, like every other policy number; offline ages are never filled in from the O6 examples"
  - "requirementsOnlyTighten compares level by level: a requirement moved to a higher level only, or dropped, is a loosening"
metrics:
  duration: "about 1 h (2026-11-24)"
  completed: 2026-11-24
estimate:
  tokens: 100052
  tasks: 3
actuals:
  tokens: 31800
  tasks: 3
  commits: 3
plan_head_before: c197af2f236805050d855a813a85d6a2237fcfca
plan_head_after: f6df33b1
---

# Phase 71 Plan 06: Trusted issuers in the signed policy, issuer authority, and tighten-only requirements Summary

Your organization's signed policy now says who may issue what (credentials@1) and with whom it has agreements (agreements@1). `issuerAuthority` lets a credential through only when the issuer is the pinned root (for roles) or a person holding a current role credential from the root, within the ceiling. It refuses every device or agent key whatever the policy says: 2,000 random chains never let one through. What sensitive data asks of a person can be raised by an update and never quietly lowered.

## What was built

- **Task 1 (tracer):**
  - The two sections, read by the existing `parsePolicyDocument` after `people`.
  - `credentials@1` and `agreements@1` are appended at the end of `FEATURE_IDS` and `POLICY_SECTIONS` and in `SECTION_FEATURES`. 45.1's `label-interop@1` and 70.1's `classification@1` come after them.
  - A document with credentials@1 and non-empty reserved `statusLists` or `maxOfflineAge` is refused at `reserved.statusLists` or `reserved.maxOfflineAge` (`not-allowed-here`).
  - The tracer gate re-ran its check end to end and passed.
- **Task 2:** `issuerAuthority(credential, roles, policy, didState)`. `isPersonIssuer` is the one place that decides "a person, not a device or an agent". The `fallbackPersonKey` branch is reachable only when the policy's `didMethods` excludes `did:webvh`.
- **Task 3:**
  - `requirementsOnlyTighten`.
  - The narrowing rules in `layers.ts`: `credentials.requiredBySensitivity.*` may only be added to, and every other credentials and agreements key is your organization's.
  - `OrganizationStore.accept` refuses an update or handover layer that loosens the requirements in force. Its reason is `credentials-loosened`, with `CREDENTIALS_LOOSENED_TEXT`, which names your organization's security officer. The active layer and pin stay.

### Section shapes as built

```
credentials: { v: 1,
  root: { did: 'did:webvh:<scid>:…', scid } | { did: 'did:key:…' } (fallback only),
  issuance: { <PersonAttributeType>: { role: <RoleType>, ceiling?: { scale, upTo } } },
  suites: sorted subset of ['ecdsa-jcs-2019', 'eddsa-jcs-2022'],
  didMethods: sorted subset of ['did:key', 'did:webvh'],
  statusLists: [{ uri (https), purpose: 'revocation' | 'suspension', key: Multikey }],   (at most 16, uri unique)
  statusTtl: seconds (1 to 86,400),
  maxOfflineAge: { 'scale/level': seconds },
  requiredBySensitivity: { 'scale/level': sorted PersonAttributeType[] },
  fallbackPersonKeys?: sorted did:key[]   (only when did:webvh is not allowed) }
agreements: { v: 1, items: [{ id, partner, tokens (sorted label tokens), levelCeiling: 'scale/level', compartments (sorted), until }] }  (sorted by id)
```

### Refusal ids

- **Sections:** the gate's shape reasons (`not-allowed-here`, `missing-field`, `unknown-field`, `wrong-type`, `empty-list`, `not-sorted`, `duplicate`, `unknown-version`).
- **`ISSUER_REFUSALS`:**
  - device-or-agent-issuer;
  - role-subject-not-person;
  - unknown-issuer;
  - key-not-in-force;
  - method-not-allowed;
  - suite-not-allowed;
  - role-not-from-root;
  - root-issues-roles-only;
  - not-issuable;
  - no-role;
  - above-ceiling.
- **Store:** `credentials-loosened`.

## Verification

- Failing first: the new tests did not compile before the modules existed. The FEATURE_IDS pin in `gateBundleV2` failed until the two ids were appended.
- `policyCredentialsSection` 16 tests and `credentialsIssuerAuthority` 10 (the property test runs exactly 2,000 cases and asserts more than 50 allowed, so it is not vacuous).
- These also pass: `gateBundle`, `gateBundleStore`, `gateBundleTrust`, `gateBundleV2`, `gateEnrolCommand`, `gateEnrolment`, `gateLayers`, `gateOrganizationStore` (one new test), `gatePolicyProposal`, `gatePolicyVersion`, `policyEditor`, `architecture` and `copyLint` (capped runs, 2026-11-24).
- Acceptance greps:
  - `credentials@1` and `agreements@1` in `features.ts` outside comments: 2 and 2;
  - `device-or-agent-issuer` in `issuerAuthority.ts`: 4;
  - `requirementsOnlyTighten` in `organizationStore.ts`: 2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `proposal.ts` needed titles for the new sections**
- `SECTION_TITLES` is a record over every section name, so the build failed without them. Added "Who may issue credentials" and "Agreements with other organizations".
- **Commit:** 8484b810.

**2. [Rule 3 - Blocking] `parseStatusList` could not be reused as it is**
- It takes exactly `{ uri, purpose }`, and credentials@1 needs the key too. The section checks the three keys, then reuses `parseStatusList` for `uri` and `purpose`, and `parseMaxOfflineAge` unchanged.
- **Commit:** 8484b810.

**3. [Rule 1 - Bug] `wideningOf` did not see a superset entry with a `*` key**
- **Found during:** Task 3.
- **Issue:** the loop that names a removed superset item looked the pattern up literally. So dropping a sensitivity requirement in a personal edit was not named before signing (composition still kept your organization's requirement).
- **Fix:** `supersetPaths` expands a `.*` entry over the data keys any layer holds.
- **Commit:** f6df33b1.

**4. Test files beyond the plan's list:**
- `gateBundleV2.test.ts`: the FEATURE_IDS and POLICY_SECTIONS pins extended. Its every-section round trip now also carries the two sections, with the reserved slots emptied in that test only, so the shared `fullDocumentFor` fixture is unchanged.
- `gateOrganizationStore.test.ts`: one store test, the file VALIDATION.md names for DCAC-01.
- **Commits:** 8484b810 and f6df33b1.

**5. [Rule 1 - Copy] "issuer" is a glossary word.** The issuer refusal sentences say "whoever signed this credential" and "the signer's". The same change in 71-03's profile sentences is fix commit 9335e3d1.

## Notes for later plans

- The load path's roll-forward (a newer layer signed by the pinned key found on disk) is now held to the same rule (coordinator, 2026-11-24; fix commit 9c133bff). The pin keeps the requirements map of the layer in force, and a looser file fails the whole policy closed. The new store test failed on the code before the fix.
- `issuerAuthority` reads device bindings and delegations from the caller. A verifier that does not know a binding cannot refuse that person's device key as an issuer, so 71-07's `checkEvidence` must pass the bindings it holds. A `did:key` issuer is refused structurally either way.

## Open conditions

None.

## Known Stubs

None.

## Threat Flags

None. T-71-17 to T-71-20 are mitigated as planned:
- T-71-17: structural refusal, no policy override, property test.
- T-71-18: role and policy ceilings.
- T-71-19: reserved slots empty beside credentials@1.
- T-71-20: tighten-only in the store, the layers, and `wideningOf`.

## Self-Check: PASSED

All created files exist. Commits 8484b810, d0198f2e and f6df33b1 are on `feat/phase-71-wave-2`.
