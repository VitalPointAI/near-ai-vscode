---
phase: 71-identities-and-verified-credentials-core
plan: 05
subsystem: credentials
status: complete
tags: [bitstring-status-list, revocation, suspension, gzip, herd-privacy, stapling]
requires:
  - "71-02: status lists verdict FULL (sizes and lifetimes)"
  - "71-03: profile.ts (issueCredential, readCredential, verifyCredential, credentialHash), BitstringStatusListCredential in types.ts"
  - "71-04: didKey.ts (resolveDidKey) for the status-list key's did:key"
provides:
  - "src/domain/credentials/statusList.ts: buildStatusList, signStatusList, verifyStatusList, statusAt, checkCredentialStatus, nextIndex, setBit, clearSuspension, listHash, newerThan, keepsRevocations, acceptStapled, encodeBits, decodeBits"
affects: [71-07, 71-08, 71-09, 71-11, 71-12]
tech-stack:
  added: []
  patterns:
    - "A status list's issuer is the did:key of the site's status-list key, and verifyStatusList takes the key the policy names; the person-issuer rule never applies to lists (D-14)"
    - "The random source is passed in (a CSPRNG in production, seeded in tests), so the domain stays free of I/O"
key-files:
  created:
    - src/domain/credentials/statusList.ts
    - src/test/credentialsStatusList.test.ts
  modified: []
decisions:
  - "The list's version is a signed claim of the list credential's subject (beside the W3C fields), raised by setBit and clearSuspension; the hub's compare-and-swap (71-09) and newerThan read it"
  - "acceptStapled also refuses a newer copy that clears any revocation bit the held copy has (revocation-cleared)"
  - "A list larger than twice the minimum (262,144 entries, 32 KB decompressed) is refused, and gunzip is capped at that size, so a small GZIP cannot expand without end"
metrics:
  duration: "about 25 min (2026-11-24)"
  completed: 2026-11-24
estimate:
  tokens: 70036
  tasks: 2
actuals:
  tokens: 12300
  tasks: 2
  commits: 1
plan_head_before: c197af2f236805050d855a813a85d6a2237fcfca
plan_head_after: df803e27
---

# Phase 71 Plan 05: Bitstring Status List Summary

Revocation and suspension as pure code. Lists have 131,072 random, never-reused indexes. They are gzip level 9 and multibase, signed through the credential format by the site's status-list key, and checked only against the key the policy names. Revocation never clears. A missing, unverifiable or out-of-date list answers status-unavailable, never "not revoked". Lists cross-check both ways with Digital Bazaar's implementation.

## What was built

- **Task 1:**
  - `buildStatusList` makes the unsigned list (no `credentialStatus`, D-05) and `signStatusList` signs it.
  - `verifyStatusList(value, issuerKey, at?)` works in this order:
    - the format;
    - the proof's did:key must be the policy key (`status-list-signer`);
    - the signature;
    - the date window (`status-list-expired`);
    - the bits (`status-list-too-short`, `status-list-invalid`).
  - `statusAt(list, index, purpose)` reads one bit, index 0 left-most.
  - `checkCredentialStatus(entry, list, { issuerKey, at })` fails closed as `status-unavailable` for no list, another key, outside validity, another list id, another purpose, or an index outside the list.
- **Task 2:**
  - `nextIndex(allocated, random, size)`: random draws, a scan from a random start when the source repeats itself, and nothing once half the list is allocated.
  - `setBit` raises the version. `clearSuspension` works only on a suspension list. There is no function that clears a revocation (the grep gate is 0).
  - `listHash` is the credential hash of the signed list.
  - `newerThan`: same issuer, id and purpose, a higher version and a later validFrom.
  - `acceptStapled`: verified, newer, and no revocation cleared.

### Constants from 71-RESEARCH.md

| Constant | Value | Source |
|---|---|---|
| STATUS_LIST_ENTRIES | 131,072 | specification minimum (herd privacy) |
| MAX_STATUS_LIST_ENTRIES | 262,144 | our cap: twice the minimum |
| STATUS_LIST_ALLOCATION_LIMIT | 65,536 | start a new list pair at half |
| STATUS_LIST_TTL_MS | 900,000 | O6 connected time to live |
| STATUS_LIST_VALIDITY_MS | 7 days | longest default offline age (Protected A) |
| STATUS_LIST_GZIP_LEVEL | 9 | smaller at HQ's expected fill |

## Verification

- Failing first: the test did not compile before `statusList.ts` existed.
- `credentialsStatusList` 14 tests, including:
  - the two cross-checks: our list read by `decodeList` and by `checkStatus`, and their `createList` and `createCredential` list read by ours;
  - 10,000 seeded allocations;
  - a gzip that expands too far.
- These pass, with `architecture` and `copyLint` (capped runs, 2026-11-24).
- Acceptance greps: `131_072` in `statusList.ts`; `export function (clearRevocation|unrevoke)` 0.

## Deviations from Plan

**1. Tasks 1 and 2 were committed as one commit (df803e27).** Both tasks change only `statusList.ts` and its test, and they were written and verified in one run.

**2. The reference library's own signature check is not used in the cross-check.** Its `checkStatus` reads our list with `verifyBitstringStatusListCredential: false` and `verifyMatchingIssuers: false`. Why: the eddsa-jcs-2022 proof itself is cross-checked both ways in `credentialsConformance` (71-01), and our list issuer (the status-list key) is deliberately not the credential's issuer (D-14).

## Open conditions

- G350: status lists are signed with Ed25519 by default; a strict-FIPS site uses an `ecdsa-p256` Transit status-list key. That path is the same code with the P-256 suite of 71-03, but it has no test of its own yet; 71-12 wires the Transit key.

## Known Stubs

None.

## Threat Flags

None. T-71-13 to T-71-16 are as planned:
- T-71-13: signed list, version, newerThan, stapling only if newer and verified.
- T-71-14: no clear for revocation, and a copy that clears one is refused.
- T-71-15: random indexes in 131,072-entry lists.
- T-71-16: fail closed, accepted by design.

## Self-Check: PASSED

All created files exist. Commit df803e27 is on `feat/phase-71-wave-2`.
