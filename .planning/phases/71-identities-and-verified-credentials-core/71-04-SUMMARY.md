---
phase: 71-identities-and-verified-credentials-core
plan: 04
subsystem: identity
status: complete
tags: [did-key, did-webvh, dif-vectors, pre-rotation, witnesses, portability, did-core]
requires:
  - "71-01: multibase.ts, dataIntegrity.ts (verifyProof, createProof)"
  - "71-02: did:webvh verdict FULL, test/fixtures/did/webvh/vectors.json"
provides:
  - "src/domain/did/didKey.ts: didKeyFromDevice, didKeyFromPublicKey, didKeyMethodId, resolveDidKey, isDidKey"
  - "src/domain/did/didDocument.ts: readDidDocument (minimal DID Core shape), verificationMethodsOf, DID_DOCUMENT_MEMBERS"
  - "src/domain/did/didWebvh.ts: verifyWebvhLog(log, { now, cached?, witnessFile?, did? }), WebvhState, methodsAt, versionAt, parseWebvhDid, buildGenesisEntry, buildUpdateEntry, buildWitnessProof, nextKeyHash"
affects: [71-06, 71-07, 71-09, 71-10, 71-11]
tech-stack:
  added: []
  patterns:
    - "Spec-conformant log verification, strict documents: verifyWebvhLog accepts any did:webvh v1.0 document; methodsAt reads only the minimal DID document, and an empty answer is the fail-closed answer"
    - "A cached WebvhState resumes only when the new copy starts with exactly the verified bytes (SHA-256 of the line-normalised prefix)"
key-files:
  created:
    - src/domain/did/didKey.ts
    - src/domain/did/didDocument.ts
    - src/domain/did/didWebvh.ts
    - src/test/didKey.test.ts
    - src/test/didWebvh.test.ts
  modified: []
decisions:
  - "A null log parameter is refused rather than read as its default (the specification's SHOULD for early logs); every DIF vector is null-free"
  - "Every proof on a log entry must verify by an authorized key, and an entry has at least one (a stricter reading than at least one valid proof)"
  - "A versionTime ahead of the caller's clock by more than five minutes is its own reason, version-time-future, whose sentence says the last verified version stays in use (71-02's recommendation for slow edge clocks)"
  - "Limits: a log of at most 1 MiB and 1,000 entries, a witness file of at most 256 KiB, checked before parsing"
metrics:
  duration: "about 1 h 10 min (2026-11-24, shared with 71-03; most of it waiting for the shared heavy-command lock)"
  completed: 2026-11-24
estimate:
  tokens: 90047
  tasks: 2
actuals:
  tokens: 27600
  tasks: 2
  commits: 2
plan_head_before: c197af2f236805050d855a813a85d6a2237fcfca
plan_head_after: 58d4f278
---

# Phase 71 Plan 04: did:key for devices and agents, and did:webvh logs verified from any copy Summary

A Phase 69 device key becomes `did:key:z6Mk...` unchanged. `verifyWebvhLog` implements the whole did:webvh v1.0 resolver checklist on our own code: all 82 DIF happy-path logs from six implementations verify and match their resolution results, and every negative vector is refused with a pinned reason. It resumes from a stored verified state and answers which key was in force at any time.

## What was built

- **Task 1:**
  - `didKey.ts`: Ed25519 and P-256 did:keys. A did:key URL's fragment must repeat its body (the DIF body/fragment attack is refused), and one key has one form.
  - `didDocument.ts`: `readDidDocument` accepts only `@context`, `id`, `controller`, `verificationMethod`, `authentication`, `assertionMethod` and `service`. Methods are Multikey with exactly four members. Relationships name methods of the same document.
- **Task 2 (`didWebvh.ts`, 608 lines):**
  - `parseWebvhDid` applies the identifier rules:
    - SCID;
    - domain with one percent-decoding, LDH labels, no IP literal (decimal or hex last label), optional `%3A` port;
    - path segments without `.`, `..`, `/`, `\`, NUL or edge whitespace;
    - plus the log URL.
  - `verifyWebvhLog` checks, in the specification's order:
    - parameters (method `did:webvh:1.0` only, `scid` only first, `portable: true` only first, witness lists with distinct Ed25519 did:key ids and 1 ≤ threshold ≤ count);
    - proofs (eddsa-jcs-2022 only, the key in the active updateKeys);
    - version numbers and the entry-hash chain;
    - versionTime strictly increasing and at most 5 minutes ahead;
    - the SCID;
    - state.id with the same SCID in every entry;
    - a move only when portable and the new document names the old DID in alsoKnownAs;
    - pre-rotation, with both lists explicit and every new key committed;
    - nothing after deactivation;
    - the DID asked for must appear.
  - Witness proofs come last. They are counted per distinct witness of the governing list, and only for versionIds in this log, at that entry or later (so the cross-DID replay vector fails).
  - `buildGenesisEntry`, `buildUpdateEntry` and `buildWitnessProof` make entries that verify, including a root genesis with `nextKeyHashes`.

### The WebvhState a host must store

| Field | Meaning |
|---|---|
| `format` | `webvh-state/1` |
| `scid` | the SCID (never changes) |
| `did` | the DID of the latest version (changes only under portability) |
| `logBytes`, `logHash` | UTF-8 length and SHA-256 (hex) of the verified log, one entry per line, each ending in a newline; a resumed copy must start with exactly these bytes |
| `versions[]` | per entry: `versionId`, `versionTime`, `did`, `deactivated`, and the document exactly as the log holds it (deep-frozen); history answers "which key at time t" |
| `parameters` | the parameters in force after the last entry: `method`, `scid`, `updateKeys`, `nextKeyHashes`, `witness` (`{ threshold, witnesses }` or null), `watchers`, `portable`, `deactivated`, `ttl` |

A host keeps it where the log copy cannot reach (it is trusted as produced by a full verification). The witness proofs are not kept: every entry in a stored state was already approved.

## Verification

- Failing first: the new tests did not compile before the modules existed.
- `didKey` 8 tests, `didWebvh` 12 tests (the DIF happy-path test covers 82 logs and 94 resolution results; the negative test covers 12 logs and 12 parser-level DIDs), `architecture`, `copyLint`: all pass (capped runs, 2026-11-24). Nothing is skipped: the tests assert the counts.
- Acceptance greps: `verificationMethod` in `didDocument.ts`; `nextKeyHashes` in `didWebvh.ts` (12).

### Negative vectors and their pinned reasons

| Vector | Reason |
|---|---|
| cross-did-witness-replay | witness-threshold |
| did-key-body-fragment-mismatch | unauthorized-key |
| duplicate-witness-ids, zero-witness-threshold | bad-parameters |
| portable-scid-swap | bad-state |
| pre-rotation-omit-updatekeys | pre-rotation |
| scid-mismatch-genesis | bad-scid |
| unknown-method-version | unknown-method |
| versiontime-future | version-time-future |
| versiontime-non-monotonic | bad-version-time |
| witness-update-threshold-not-met | witness-threshold |
| wrong-cryptosuite | bad-proof |
| the 12 parser-level DIDs (IP hosts, lowercase `%3a`, traversal, `%2F`, raw Unicode, a 64-octet label, a fragment) | invalid-did |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test reading] The DIF resolution results are each implementation's raw output**
- Resolvers add the implicit `#files` and `#whois` services and empty relationship lists, so both sides are compared without those (71-02 warned of this).
- The Python resolver answers a request for an earlier version with the latest one, so a result is compared with the version its own metadata names.
- **Commit:** 58d4f278.

**2. The plan's `didKey.test.ts` gained a proof round trip:** a proof signed by a Phase 69 device key verifies with the key its did:key resolves to. It is the link 71-06 and 71-10 rely on. Commit 58d4f278.

## Open conditions

- G350: did:webvh v1.0 allows only Ed25519, so a strict-FIPS site cannot use it. That site uses the fallback, with P-256 did:keys named in the policy (71-03, 71-06).

## Known Stubs

None.

## Threat Flags

None. T-71-10 to T-71-12 are mitigated as planned:
- T-71-10: SCID, chain, proofs by authorized keys, pre-rotation, witnesses, DIF vectors and tamper cases.
- T-71-11: `methodsAt` at the credential's time; empty after deactivation.
- T-71-12: size caps before parsing.

## Self-Check: PASSED

All created files exist. Commits 624c1932 and 58d4f278 are on `feat/phase-71-wave-2`.
