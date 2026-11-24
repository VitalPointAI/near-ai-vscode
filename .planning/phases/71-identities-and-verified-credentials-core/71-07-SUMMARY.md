---
phase: 71-identities-and-verified-credentials-core
plan: 07
subsystem: credentials
status: complete
tags: [evidence-by-hash, mayRelease, dominance, freshness, offline-age, clearance, determinism]
requires:
  - "71-05: statusList.ts (verifyStatusList, statusAt, listHash)"
  - "71-06: issuerAuthority.ts, credentialsSection.ts"
provides:
  - "src/domain/credentials/evidence.ts: EvidenceCitation, EvidenceContext, checkEvidence, EVIDENCE_REFUSALS"
  - "src/domain/credentials/clock.ts: credentialClock, CredentialTime"
  - "src/domain/credentials/mayRelease.ts: CredentialFacts, CheckedCredential, factsFrom, isCheckedFacts, clearancesOf, releaseDominance, mayRelease, eligibleForPosition, PositionRequirements, RELEASE_REFUSALS"
  - "src/domain/credentials/freshness.ts: checkFreshness, NewestList, SiteKind, FRESHNESS_REFUSALS"
  - "src/domain/credentials/clearance.ts: clearanceFromCredentials, declaredClearanceCounts"
affects: [71-08, 71-09, 71-11, 71-13, 33.1-04, 33.1-19, 33.1-20, 33.1-23, 33.2-05, 45.1-03]
tech-stack:
  added: []
  patterns:
    - "The fold calls checkEvidence (cited data only, no clock); enforcement points call checkFreshness with their own time"
    - "Facts exist only when made by factsFrom (a WeakSet of what it made), so hand-built or deserialised facts give no clearance"
key-files:
  created:
    - src/domain/credentials/evidence.ts
    - src/domain/credentials/clock.ts
    - src/domain/credentials/mayRelease.ts
    - src/domain/credentials/freshness.ts
    - src/domain/credentials/clearance.ts
    - src/test/credentialsEvidence.test.ts
    - src/test/credentialsMayRelease.test.ts
    - src/test/credentialsFreshness.test.ts
    - src/test/helpers/credentialWorld.ts
  modified: []
decisions:
  - "A citation's evidence holds the member's credentials and the role credentials and device bindings their issuers rely on; any other subject is refused"
  - "Every status entry of every cited credential must be checked in a cited list (status-not-cited), and the cited list's purpose must match the policy entry"
  - "A cited device binding becomes a device key for issuerAuthority (devices never issue), and may stand for the member's signing key"
  - "credentialClock: with a witness, min(signed, witness); offline, never earlier than the last bundle"
  - "For CGP, ITAR and EAR, the ExportEligibilityCredential's regime is the compartment held; a CompartmentCredential of that name is not enough"
  - "At an edge, a level the policy gives no offline age has none; unmarked data keeps only the superseded rule"
metrics:
  duration: "about 1 h (2026-11-24)"
  completed: 2026-11-24
estimate:
  tokens: 110057
  tasks: 3
actuals:
  tokens: 33500
  tasks: 3
  commits: 3
plan_head_before: 4ceffaac
plan_head_after: 5ff95d95
---

# Phase 71 Plan 07: The credential checker Summary

One pure checker:

- **The fold:** `checkEvidence` decides from cited credentials and lists only, at the entry's time, under the cited policy. 1,000 replicas holding different newer and forged lists agree on every citation.
- **Every release:** `mayRelease` decides each one through `whyNotDominated`, for staff and observers alike. 2,000 random cases show no release without dominance.
- **The enforcement points:** `checkFreshness` covers the hub, the preparer and the session.
- **The gate:** `clearanceFromCredentials` gives its clearances.

## Signatures other planners call

Names that differ from PLAN-IDS.md's "Checker API":

- `checkEvidence(citation, context)`. PLAN-IDS has `(citation, evidence, context)`; the evidence (credential blobs and lists by hash) is inside `context`.
- `mayRelease(facts, label, context)` returns `{ ok } | { ok: false, reason, message }`, not a boolean.
- `checkFreshness(citation, newest, level, policy, now, siteKind, options?)` adds `siteKind` (`connected` or `edge`), as the plan's action says, and an optional grace. `newest` maps a list id to `{ validFrom, fetchedAt? }`.
- `eligibleForPosition(facts, position, scales)` takes the scales.
- `declaredClearanceCounts(label, { scales }, projectRequiresCredentials)` takes the label rather than a level.

```ts
checkEvidence(
  citation: { evidence: string[]; status: { list; hash; validFrom }[] },
  context: { credentials: Record<hash, blob>; lists: Record<hash, blob>; policy: { section, scales };
             didState: { states, deviceBindings?, delegatedKeys? }; member: string; memberKey?: string;
             signedAt: number; level?: 'scale/level' }
): { ok: true; facts: CredentialFacts; credentials: VerifiedCredential[] } | { ok: false; reason; message }

credentialClock(entrySignedAt, witnessAt?, bundleTime?, counter?): { at, source: 'entry' | 'witness' | 'bundle', counter? }

factsFrom(checked: { credential: VerifiedCredential; status: 'clear' }[]): CredentialFacts

mayRelease(facts, label: Label, { scales, mappings, policy?: CredentialsSection, now }): ReleaseResult

eligibleForPosition(facts, { requiredClearance?: 'scale/level'; eligibleServes: string[] }, scales): ReleaseResult

checkFreshness(citation, newest: Record<listId, { validFrom; fetchedAt? }>, level | undefined, policy: CredentialsSection,
               now, 'connected' | 'edge', { graceSeconds? }?): { ok: true } | { ok: false; reason; message; action: 'retry' | 'connect' }

clearanceFromCredentials(facts, scales): Clearance[]

declaredClearanceCounts(label | undefined, { scales }, projectRequiresCredentials): boolean
```

### Refusal ids

- **`EVIDENCE_REFUSALS`:**
  - no-evidence, subject-mismatch, member-key;
  - credential-missing, credential-hash, credential-invalid, credential-expired;
  - issuer-key, issuer-authority;
  - list-missing, list-hash, list-not-in-policy, status-list-signer, list-invalid, list-out-of-date, list-too-old;
  - status-not-cited, revoked, suspended.
- **`RELEASE_REFUSALS`:**
  - no-clearance, scale, level, compartment, releasability, releasable-to-none, expired;
  - export-eligibility, required-credential;
  - below-required-clearance, serves-not-eligible.
- **`FRESHNESS_REFUSALS`:** superseded (retry), past-ttl (retry), offline-too-long (connect), unreadable (retry).

## Verification

- Failing first: the new tests did not compile before the modules existed.
- `credentialsEvidence` 13, `credentialsMayRelease` 14 and `credentialsFreshness` 10 tests pass, with `gateDominance`, `architecture` and `copyLint` (capped runs, 2026-11-24). The property tests run exactly 1,000 and 2,000 cases, and both are non-vacuous.
- Acceptance greps:
  - `Date.now` or `new Date()` in `evidence.ts` outside comments: 0;
  - `whyNotDominated` in `mayRelease.ts`: 3;
  - `export function declaredClearanceCounts` in `clearance.ts`: 1.

## Deviations from Plan

**1. `mayRelease.ts` was committed with Task 1 (98b08b40).** `checkEvidence` returns facts built by `factsFrom`. The Task 2 commit (bdedb679) holds its tests.

**2. `newest` carries the fetch time.** "A list past its time to live at a connected site" needs to know when the enforcement point fetched its newest copy. A list that has not changed stays the newest (71-RESEARCH.md), so its own validFrom cannot be the measure. Without a fetch time, the list's validFrom counts.

**3. [Rule 1 - Copy] Two sentences used glossary words ("issuer", "regime")** and were reworded before the commit.

**4. A shared test helper,** `src/test/helpers/credentialWorld.ts` (a root, officer and member, status-list keys, signed credentials and lists), so the 71-08 and later tests reuse it rather than copying it.

**5. Coordinator item 1:** `checkEvidence` passes `issuerAuthority` the replica's known device bindings and delegations, plus every cited DeviceBindingCredential. The test "an issuer whose signing key is bound to a device by a cited binding is refused" covers it.

## Open conditions

None.

## Known Stubs

None.

## Threat Flags

None. T-71-21 to T-71-24 are mitigated as planned:
- T-71-21: cited inputs only, no clock, and the property test.
- T-71-22: built on whyNotDominated, a property test, observers like staff.
- T-71-23: checkFreshness.
- T-71-24: facts only from factsFrom, plus declaredClearanceCounts.

T-71-25 is accepted, as planned (stated in SECURITY.md by 71-14).

## Self-Check: PASSED

All created files exist. Commits 98b08b40, bdedb679 and 5ff95d95 are on `feat/phase-71-wave-2`.
