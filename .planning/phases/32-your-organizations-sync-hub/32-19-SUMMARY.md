---
phase: 32-your-organizations-sync-hub
plan: 19
subsystem: hub
status: complete
tags: [hub, append-checks, enrolment, equivocation, rate-limits, roster-fold]
requires: [32-14, 32-15, 32-18]
provides:
  - "hub/src/append/rosterCache.ts: ProjectRoster (build, load, withBatch, withEquivocations, anchor, state, view, head, headPosition, ring, placedGrants, context(now), streamKnown, accessList(stream), quarantinedAt, standing(writer), isRosterWriter(writer), blob, entries), RosterCache (get, peek, replace, invalidate), sealedOf, blobsNamed"
  - "hub/src/append/checks.ts: APPEND_REFUSALS, checkBatch(input, ctx), commitBatch(store, cache, checked, now), appendBatch(input, ctx) with one batch at a time per project"
  - "hub/src/enrol.ts: HubIdentity, hubIdentityOf, HUB_FILE_DAYS, ISSUE_REFUSALS, issueHubFile, ENROL_REFUSALS, enrolProject, secretHashOf"
  - "hub/src/limits.ts: LIMITS, TokenBucket, BucketMap, RateLimits (takeWriter, takeAddress, tracked)"
  - "hub/test/helpers/hubWorld.ts: Yjs-free world (worldDevice, makeHubIdentity, otherCertPin, createHubWorld with write, rosterEntry, grant, admitHub, admitMember, labelCell, enrolRequest)"
affects: [32-20, 32-21, 32-22, 32-23, 32-25, 32-26, 32-27]
tech-stack:
  added: []
  patterns: ["immutable roster overlay folded again per roster entry, swapped into the cache only after COMMIT", "token bucket before any signature check", "enrolment secret derived from the hub's own key so only its hash is stored"]
key-files:
  created:
    - hub/src/append/rosterCache.ts
    - hub/src/append/checks.ts
    - hub/src/enrol.ts
    - hub/src/limits.ts
    - hub/test/append.test.ts
    - hub/test/enrol.test.ts
    - hub/test/limits.test.ts
    - hub/test/helpers/hubWorld.ts
  modified: []
decisions:
  - "The enrolment secret is HKDF-SHA256 of the hub's X25519 private key, salted with the enrolment id (info near-ai-hub/enrolment-secret/v1). The plan asks for an HMAC under the secret and for the hub to keep only the secret's hash; an HMAC cannot be checked from a hash, so the hub derives the secret again at enrol time and compares its hash with the stored one. A database copy alone cannot enrol a project. A hub whose encryption key changed refuses its older hub files as enrolment-unknown (ask the operator for a new file)."
  - "The genesis is found by header alone: every base-stream entry at seq 0 is a candidate, and the one whose hash makes the MAC check is the genesis. So the MAC is checked before any body is opened or any roster is folded."
  - "Admitting the hub follows D-64: hub.admit, hub.grant for the base cell, then the base cell grant. Enrolment needs a base cell grant to the hub that the roster places (refused no-base-grant otherwise, before roster-mismatch), so a grant made before hub.admit never counts and the hub can always fold the roster again from its own store."
  - "Refusal order for the hub's key: no base grant wrapped to the hub is no-base-grant; a wrap to the hub that does not open is wrong-key (the lead used another X25519 key); hub.admit naming another X25519 key is wrong-key too."
  - "Batch-level refusals (malformed-batch, batch-too-large, rate-limited, unknown-project, blob-missing) refuse everything; every other refusal is per entry, in batch order, with {index, hash?, reason, message}. Held entries are listed in accepted and in held."
  - "The writer bucket counts entries plus grants; a count above the capacity needs a full bucket and empties it, so a 200-entry, 64-grant batch can always pass once the bucket refills."
  - "checkBatch also refuses a header over 4 KiB measured as received, before reading its fields; parseHeaderShape alone can never see a valid header over 4 KiB."
  - "A base-stream body that names a blob the hub does not hold refuses the whole batch blob-missing, like a missing blob reference, so the client uploads it and sends again."
  - "Grants are kept only if the final overlay fold places them. The ring prefers stored grants, and if a key came from a grant the fold did not place, the fold runs again with keys from placed grants only."
  - "Bucket maps evict the least recently used idle (full) bucket among the 64 oldest, else the oldest, so a map never grows past maxTracked (10,000 by default)."
metrics:
  duration: "about 50 min"
  completed: 2026-11-20
estimate:
  tokens: 85044
  tasks: 3
actuals:
  tokens: 33200
  tasks: 3
  commits: 3
plan_head_before: 061e01eb9e603cfdbca27d2bf2dad1cee2de8e1b
plan_head_after: 0f85dfb19f6e5c1c5aabd2ee6dbf3e09cbe7bd6e
---

# Phase 32 Plan 19: Append checks, roster cache, enrolment, equivocation and limits Summary

The hub now decides for itself who may put a project on it (the operator's one-time hub file, an HMAC and a roster that admits this hub's key and pin) and, for every entry offered, whether it is the next step of an admitted writer's log in a part of the project that writer may write, folding the roster with the extension's hub-side foldRoster and no key but its own.

## What was built

- **Roster cache (D-40, D-42, D-64).** `ProjectRoster.load` reads the base stream, grants, blobs and stored proofs from the store and folds them with `foldRoster`; the ring holds only epoch keys wrapped to the hub's X25519 key. `accessList(stream)` is `cellGrantees` of the stream's cell at the head. `standing(writer)` is not-admitted, revoked (known, not admitted at the head), quarantined (a stored proof or roster quarantine at a place with no `device.release`) or admitted. `withBatch` and `withEquivocations` return new rosters, so the cached one changes only after COMMIT.
- **Append checks (D-42, D-43, D-44, D-26).** `checkBatch`: batch shape and caps, the pushing device's bucket, the project, the blob references; then per entry header size and shape, body size and ciphertext hash, stream known, signature with the roster key (injectable verifier), standing, access list, place (held, equivocation proof via `canonicalProof`, seq-gap, prev-mismatch), and for base-stream entries the body opened with the ring and, for roster kinds, a lead or deputy device citing the head. `commitBatch` writes everything in one `commitAppend` and then swaps the cache (or drops it when another batch swapped it meanwhile). `appendBatch` runs check and commit one batch at a time per project for 32-20.
- **Enrolment (D-41).** `issueHubFile` (1 to 30 days, a public address required) stores `{enrolment, sha256(secret), expiry}` and returns the signed file and its text. `enrolProject` checks shape, enrolment id, MAC, project, base grant, genesis, fold, placed hub grant, claimed head, signatures, hub.admit (writer, X25519 key, pin) and base cell grantee, then stores the project, entries, placed grants, used blobs and blob references in one store call and places the roster in the cache.
- **Limits (D-37, D-38, D-39).** `LIMITS` holds every size and rate of the phase; `TokenBucket` and `BucketMap` take the time from the caller; `RateLimits.takeWriter` (50 a second, burst 200) and `takeAddress` (session 120, join 10, enrol 10 a minute).
- **Test world.** `hubWorld.ts` builds devices from labels, the genesis with the base founding grant, the hub admission, members, label cells, forks and the enrolment request, from hub-side modules only.

## Tests

Hub suite with `NEAR_AI_HUB_OLD_NODE` set: **209 tests, 209 pass, 0 fail, 0 skipped** (157 before this plan). append.test.js 29, enrol.test.js 17, limits.test.js 7. `npm run lint` (tsc) is clean; the workspace boundary test passes with the new `@ext` imports.

Acceptance greps: `foldRoster` in rosterCache.ts 3, `canonicalProof` in checks.ts 2, `wrong-pin` in enrol.ts 2.

### Failing-first evidence

- **Task 1:** the tracer test and hubWorld written first; the build failed with `Could not resolve "../src/append/checks"`, `"../src/append/rosterCache"`, `"../src/enrol"`, `"../src/limits"` and `"../../src/enrol"`. After the implementation: 1 of 1 pass, then the full suite 157 of 157.
- **Task 2:** the 28 new tests run on the Task 1 code: 29 tests, 28 pass, **1 fail** (header-too-large: a header over 4 KiB was refused malformed-header). Task 1 already held most of the checks, so the other tests prove their teeth by stated mutations (D-66), each applied alone and restored:
  - M1 quarantine standing removed: the quarantined, equivocation and proof-after-restart tests fail.
  - M2 revoked counted as admitted: the revoked and equivocation tests fail.
  - M3 access list skipped: not-on-access-list fails. M4 used-place check skipped: equivocation, held and proof-after-restart fail. M5 prev check skipped: prev-mismatch fails. M6 roster writer check skipped: not-a-roster-writer fails. M7 rosterPrev check skipped: roster-not-at-head and the appendBatch test fail. M8 unplaced grants kept: the member-signed grant test fails. M9 cache swapped before COMMIT: the store-failure test fails. M10 body hash check removed: body-mismatch fails. M11 blob existence check removed: blob-missing fails. M12 per-project lock removed: the appendBatch test fails.
- **Task 3:** the 23 new tests run on the Task 1 `limits.ts` and `enrol.ts`: 24 tests, 21 pass, **3 fail**: the writer bucket (a count above the capacity could never pass), no-base-grant (a grant made before hub.admit gave roster-mismatch) and the issue-then-used test (a bug in the test's own helper, fixed). Teeth for the rest, each alone: E1 MAC not checked fails bad-mac; E2 pin not checked fails wrong-pin; E3 X25519 not checked fails wrong-key; E4 expiry not checked fails enrolment-expired; E5 hub.admit not checked fails not-admitted; E6 secret stored instead of its hash fails 12 tests; E7 no enrol bucket fails rate-limited; E8 claimed head not compared fails roster-mismatch; E9 days 0 to 31 fails the issue refusals; L1 no idle preference and L2 no cap fail the bound tests; L3 session 121 fails the LIMITS and session tests.
- Removing the enrolment-used or project-exists checks in enrol.ts does not fail a test: the store refuses both in its transaction and enrolProject maps them to the same ids (defence in depth, by design).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] An HMAC cannot be checked from a hash**
- **Found during:** Task 1
- **Issue:** the plan keeps only the enrolment secret's hash and checks an HMAC under the secret, which needs the secret itself.
- **Fix:** the secret is derived from the hub's X25519 private key and the enrolment id (HKDF-SHA256), the store keeps its hash, and enrolment derives it again and compares the hash before the MAC. See Decisions.
- **Files:** hub/src/enrol.ts. **Commit:** a5e9e39c

**2. [Rule 1 - Bug] A batch at the batch cap could never pass the bucket**
- **Found during:** Task 3
- **Issue:** 200 entries plus 64 grants is 264 tokens against a burst of 200.
- **Fix:** a count above the capacity needs a full bucket and empties it.
- **Files:** hub/src/limits.ts. **Commit:** 0f85dfb1

**3. [Rule 2 - Correctness] Race between two appends to one project**
- **Issue:** two batches checked against the same cached roster could both commit, and the second swap would drop the first one's roster change.
- **Fix:** `commitBatch` swaps the cache only when it still holds the roster the batch was checked against (else drops it), and `appendBatch` serialises check and commit per project. 32-20 should call `appendBatch`.
- **Files:** hub/src/append/checks.ts. **Commits:** a5e9e39c, 8da7b202

**4. [Rule 2 - Correctness] Extra refusal ids**
- Append: `malformed-batch`, `unknown-project`, `unknown-header-version`, `bad-signature`, `rate-limited`, `grant-not-placed` for unreadable grants too. Enrol: `rate-limited` (when the route passes limits and an address) and `malformed` for broken chains, unknown signers and bad blobs.

## Decisions

The owner accepted the 32-CONTEXT defaults; this plan had no checkpoint. The decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- **32-20:** call `appendBatch(input, {store, cache, limits, now})`; a batch-level refusal carries `retryAfterSeconds` for rate-limited (429). `commitBatch` throws on a store failure (nothing accepted). `enrolProject({store, identity, now, cache, limits, address}, body)`. `issueHubFile(store, identity, {days, now, address?})` returns `{ok, file, text}` or `{ok: false, reason: 'days' | 'address', message}`. `hubIdentityOf(signing, encryption, certificatePem, HUB_PUBLIC_ADDRESS)`. Body caps for the routes are in `LIMITS`.
- **32-21:** `ProjectRoster.accessList(stream)`, `standing(writer)`, `isRosterWriter(writer)`, `head`, `view`; `AppendResult.rosterChanged`, `equivocations` (proofs) and `accepted` feed the events.
- **32-22:** `ProjectRoster.context(now)` gives a ReplicaContext with the hub's ring (base cell and granted cells) and the base-stream blobs.
- **Cost:** a batch folds the roster again after each roster entry in it (lazily, only when the next check needs it). Fine for the lead's usual handful; a batch of many roster entries on a long roster is the slow case.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. The enrolment secret derivation reuses the hub's X25519 private key as HKDF input under its own info string; the key never leaves the process and the derived secret is zeroed after use.

## Self-Check: PASSED

- All 8 created files are present; commits a5e9e39c, 8da7b202 and 0f85dfb1 are on the branch.
