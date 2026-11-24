---
phase: 71-identities-and-verified-credentials-core
plan: 02
subsystem: credentials-research
status: complete
tags: [did-webvh, bitstring-status-list, fips, ed25519, ecdsa-jcs-2019, openbao-transit, research]
requires: []
provides:
  - "71-RESEARCH.md: sections (b) did:webvh, (c) Status lists and O8 FIPS posture, each ending in a verdict line read by the preconditions of 71-04, 71-05 and 71-09 to 71-12"
  - "test/fixtures/did/webvh/vectors.json: the DIF did:webvh test-suite vectors at 4351390, unchanged (295 files), with the Apache-2.0 licence"
  - "Gap G347: the strict-FIPS condition for Ed25519 credentials and did:webvh"
affects: [71-04, 71-05, 71-08, 71-09, 71-10, 71-11, 71-12, 48.1-09]
tech-stack:
  added: []
  patterns:
    - "Vectors copied as data only: every file's exact text keyed by its path, nothing from the suite extracted or run"
key-files:
  created:
    - .planning/phases/71-identities-and-verified-credentials-core/71-RESEARCH.md
    - test/fixtures/did/webvh/vectors.json
    - test/fixtures/did/webvh/LICENSE.md
  modified:
    - compliance/gaps.json
    - compliance/test/gaps.test.ts
    - .planning/phases/71-identities-and-verified-credentials-core/71-CONTEXT.md
    - .planning/REQUIREMENTS.md
decisions:
  - "Owner 2026-11-24, item 1 (\"defaults\"): solo installs keep their own declared clearances on their own computer, shown as declared, not verified; never credentials, never evidence, count nowhere else; devices never issue (D-08 confirmed; VCRD-07 rewritten)"
  - "Owner 2026-11-24, item 2 (\"defaults\"): under the fallback or at a strict-FIPS site, only officers' person keys named in the signed policy may issue; no device or agent ever issues (D-07 confirmed)"
  - "People's did:webvh logs without pre-rotation; the hosting hub refuses any entry that changes a person's updateKeys"
  - "Status lists: one revocation and one suspension list per site, random never-reused indexes, ttl 900000 ms, validUntil = validFrom + the longest maximum offline age"
metrics:
  duration: "46 min (2026-11-24, shared with 71-01, including the owner's checkpoint wait)"
  completed: 2026-11-24
estimate:
  tokens: 70036
  tasks: 3
actuals:
  tokens: 10917
  tasks: 3
  commits: 3
plan_head_before: b1ce8ada
plan_head_after: 36ac569d
---

# Phase 71 Plan 02: did:webvh hosting and caching, status list sizing, and the O8 FIPS posture Summary

Our 71-01 code verifies all 82 happy-path DIF did:webvh logs from six implementations. A 131,072-entry status list stays under 1 KB compressed at HQ's expected fill. Ed25519 is FIPS 186-5 approved, but no module in our stack runs it as a validated, approved algorithm; the P-256 fallback is specified and its W3C example verifies with node:crypto.

## Verdict lines (quoted from 71-RESEARCH.md)

did:webvh verdict: FULL. Every rule can be met with node:crypto, the existing canonical form and 71-01's multibase and proof code (82 of 82 DIF logs from six implementations verify with our code today), the hub can host logs on its trust routes behind the ingress, and people's DIDs need no pre-rotation. Conditions: 71-01's JCS verdict must be PASS; 71-04 implements the whole resolver checklist; a strict-FIPS site cannot use did:webvh (O8).

status lists verdict: FULL. The 131,072-entry list compresses to under 1 KB at HQ's expected fill (12.3 KB even at 20 percent), node:zlib and node:crypto cover building, signing and reading it, and the lifetimes fit O6 with the hub's grace and compare-and-swap; the only extra cost is a step-up re-sign when a list is exported to a classified edge.

O8 posture: accepted as decided; Ed25519 (eddsa-jcs-2022 and did:webvh) everywhere by default, with the ecdsa-jcs-2019 P-256 fallback specified above and its W3C example verified with node:crypto, and the 48.1-09 condition recorded; no module in our stack is FIPS 140-3 validated for Ed25519 today, which matters only to a site that requires validated modules.

The JCS condition is now met: 71-01 recorded `JCS verdict: PASS`.

## Owner answers (Task 3, 2026-11-24: "defaults")

1. **Solo installs (D-08, VCRD-07).** A person with no organization keeps their own declared clearances on their own computer, shown as "declared, not verified". They are never credentials, are never cited as evidence, and never count in a shared project, a hub, a wrap or your organization's policy. No device key ever issues. VCRD-07's text in `REQUIREMENTS.md` is rewritten to say so. 71-08's gate task may now proceed on this basis.
2. **The fallback (D-07).** Under the fallback, or at a strict-FIPS site, only an officer's person key that the signed policy names may issue. Devices and agents never issue.

## Findings for the plans that build on this

- **71-04:**
  - Implement the specification's whole resolver checklist and run every `negative-*` vector. The throwaway partial check refused only 6 of 24.
  - Compare only the document and the core metadata with `resolutionResult.json`, because those files are each implementation's raw output.
  - Pass each element of a log entry's `proof` array to `verifyProof`.
  - Treat a `versionTime` ahead of a slow edge clock as "not yet", not "invalid".
- **71-04 and 71-10:**
  - Set `portable: true` in the first entry; it is permanent.
  - Give the root DID a separate offline issuing key besides its pre-rotated update keys.
  - Make the hosting site's hub the witness, with its existing `HUB_SIGNING_KEY` as a `did:key` and threshold 1. HQ is the witness for its own people and for the root. Otherwise a disconnected edge's first sign-in would wait for HQ.
- **71-11 and 71-12:** a classified edge counts offline age from each list's `validFrom`, so an officer re-signs the lists (with a step-up) when an export for such an edge is cut, at most daily.
- **71-05 and 71-09:** the compare-and-swap key is the hash of the current list, sent as a request field, so no signed field is added. A later `validFrom` is required, and no revocation bit may clear.
- **48.1-09:** the condition text is in 71-RESEARCH.md. Gap G347 records it in `compliance/gaps.json`.

## Verification

- The plan's two automated checks pass: the verdict lines, the section headings, JSON that parses, and a licence that is not empty. Each verdict line and the `O8 posture:` line appears exactly once.
- These checks ran as throwaway scripts of our own, not committed:
  - 82 of 82 DIF happy-path logs verify with `canonical.ts`, `multibase.ts` and `verifyProof`;
  - the status-list gzip sizes, on Node 24.22.3 and Node 26.13.1;
  - the W3C `ecdsa-jcs-2019` P-256 example verifies with `node:crypto` (`ieee-p1363`);
  - Node 26.13.1 reports `getFips()` 0 and OpenSSL 3.5.9.
- Compliance tests: 536 of 536 pass after G347 (the register count test is updated from 349 to 350 for the added gap).

## Deviations from Plan

**1. [Rule 2 - Missing critical] The strict-FIPS condition added as gap G347.**
- **Why:** the owner's rule is that every open condition is recorded in `compliance/gaps.json`.
- **What:** `closesInPhase` 48.1 (the crypto inventory), controls sc-12 and sc-13. The count test is updated for the added entry.
- **Commit:** bafacfeb.

## Known Stubs

None.

## Self-Check: PASSED

All created files exist. Commits e5325e69, 0477d4b3 and bafacfeb, plus the owner-answers commit 36ac569d, are on `feat/phase-71-wave-1`.
