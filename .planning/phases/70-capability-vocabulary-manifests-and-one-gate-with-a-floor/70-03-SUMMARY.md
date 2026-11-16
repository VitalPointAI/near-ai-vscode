---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 03
subsystem: gate
tags: [policy-bundle, routing-table, fail-closed, signed-payload, clock-rule, pure-domain]

requires:
  - phase: 70-02
    provides: "labels, scale presets, mappings, clearances and the dominance check (parseLabel, parseClearance, parseMapping, SCALE_PRESETS, RELEASABILITY_NONE, dominates)"
  - phase: 69
    provides: "signPayload and verifyPayload with the policy-bundle purpose, canonicalBytes, KeyStatusLookup"
provides:
  - "src/domain/gate/routing.ts: ROUTING_TIERS, TIER_ORDER, ROUTING_HANDLING_FLAGS, RoutingTable, DEFAULT_ROUTING (CLAS-05) and parseRouting"
  - "src/domain/gate/bundle.ts: the policy bundle v1 payload (fourteen fields), parseBundle, defaultBundlePayload, bundleHash, verifyBundleEnvelope, the failed-closed states and sentences, effectiveNow, needsRenewal, isDefaultBundle"
  - "src/test/gateBundle.test.ts: 43 tests"
affects: [70-04, 70-05, 70-06, 70-07, 70-11]

actuals:
  tokens: 19500
  tasks: 2
  commits: 2
plan_head_before: a1d507340994b4c963d11cfe9a62d5cf300394db
plan_head_after: 9d1e33bc685231fda895847d6f3259b1c3ef65a7
commits: 2

tech-stack:
  added: []
  patterns:
    - "One verifier, no second signer: the bundle module calls verifyPayload with purpose policy-bundle and holds no key and no signing call"
    - "Closed failure table: every cause is one key of BUNDLE_FAILURES with one sentence naming the fix, and a test enumerates the keys"
    - "Epoch milliseconds in from the caller (now, lastValidAt), so the pure folder holds no clock"

key-files:
  created:
    - src/domain/gate/routing.ts
    - src/domain/gate/bundle.ts
    - src/test/gateBundle.test.ts
  modified: []

key-decisions:
  - "Parse refusals from the label, routing and list parsers collapse into the plan's closed reasons: unknown-field and unknown-verb give unknown-field; a bundleVersion above 1 gives unsupported-version; a vocabulary above 1 gives vocabulary-unknown; everything else (missing, wrong kind, not allowed) gives wrong-type. The precise path stays in an optional detail on the state for logs and is never the sentence"
  - "A verb with no entry in ceiling.contexts is allowed in no context; the default bundle omits gpu for that reason. Plan 04 should read the ceiling that way"
  - "routing.localHosts takes host patterns in ceiling form (a subdomain wildcard such as *.lan.example.com is allowed) but refuses a lone *, which would call every host local"
  - "maxOfflineAge keys must be scale/level of a declared scale and level; expiresAt must be after issuedAt; issuedAt equal to the envelope's signedAt means a caller must sign with the same time it put in the payload"

patterns-established:
  - "verifyBundleEnvelope(envelope, { status, now, lastValidAt }) returns valid or failed-closed and never throws; store-level causes (unparseable, no-identity, identity-unavailable) are built with failedClosed(reason)"

requirements-completed: [OFFL-02, OFFL-03, CLAS-02, CLAS-05]

duration: about 45 min
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 03: Signed policy bundle v1, routing table and fail-closed states Summary

**The policy bundle v1 as a closed fourteen-field payload signed and verified only through Phase 69's one signer, a default that decides and routes as today, the CLAS-05 routing table, twenty failure reasons each with one plain fixing sentence, and the clock and renewal rules, all pure.**

## Performance

- **Duration:** about 45 min (start time was not captured, so this is an estimate)
- **Completed:** 2026-11-16
- **Tasks:** 2 (a tracer, then the full build)
- **Files:** 3 created

## Accomplishments

- `defaultBundlePayload({ issuer, now })` gives a fresh install everything today's settings can allow: maxMode fully-autonomous for interactive and unattended, approve-risky for the reserved relay and routine, every verb in interactive and unattended except `gpu`, no MCP server named for unattended use, the four scale presets, no mapping, the clearance org Restricted, default label org Public, `DEFAULT_ROUTING`, and empty reserved fields. It lives 365 days (`SELF_SIGNED_LIFETIME_DAYS`).
- `DEFAULT_ROUTING` is the CLAS-05 list (D-30) as a frozen literal: org Public any-cloud; org Internal and Confidential, Protected A and NATO Unclassified attested-cloud; everything else local-only; handling is `{ 'local-only': 'local-only' }`; no compartment entries; no local hosts. `ROUTING_HANDLING_FLAGS` is `['local-only']`, so `parseRouting` refuses a handling key `no-agent-tools`, `attested-cloud-ok` or any other with `unknown-field` (D-47). A table missing a level of any declared scale is refused with `missing-field`, so no level falls through to an unknown tier.
- `parseBundle` checks exact keys at every level, so an extra key anywhere is refused, and a bundle missing any of the fourteen fields (reserved ones included) is refused, so absent and empty are never confused. Reserved fields are shape-checked and then ignored: anchor roots (64 character lowercase hex root, at most 64 hex proof steps), status lists (https address plus a short purpose name) and maximum offline age (declared scale/level keys to whole seconds). Every number anywhere must be a safe whole number: a fraction, a negative, negative zero, NaN, an infinity and a value past `Number.MAX_SAFE_INTEGER` are refused wherever they sit, and `signPayload` refuses a fraction before signing.
- `verifyBundleEnvelope` calls `verifyPayload` with purpose `policy-bundle` and the caller's key status, then `parseBundle`, then checks the payload's issuer and `issuedAt` against the envelope's signer and `signedAt` character for character, then the clock and expiry. Every failure is `{ state: 'failed-closed', reason, sentence }`; a verified bundle is `{ state: 'valid', bundle, hash, signer, expiresAt, renewDue }`. The tampered-file sentence is the exact D-13 text.
- Clock rule (D-15): `effectiveNow` is the later of the wall clock and the last valid time; a bundle is valid one millisecond before `expiresAt` and expired at exactly `expiresAt`; a recorded later time keeps an expired bundle expired when the clock is turned back; an `issuedAt` more than 5 minutes after the effective time is `clock-behind` (exactly 5 minutes is accepted); an unusable clock reading is `clock-behind` too.
- `needsRenewal` is true from exactly `expiresAt` minus 30 days up to, not including, `expiresAt`. `isDefaultBundle` is true only for a valid bundle equal to the default apart from issuer, `issuedAt` and `expiresAt` (ten kinds of customisation each tested to make it false) and never throws.
- `bundleHash` is the lowercase hex SHA-256 of `canonicalBytes(payload)`: reversing the key order of the whole payload gives the same hash, one changed value gives another, and the parsed bundle hashes the same as the signed payload.
- A mutation check (expiry `>=` to `>`, and ignoring `lastValidAt`) made four boundary and clock tests fail, so the tests have teeth; the code was restored before the commit.

## Task Commits

1. **Task 1: Tracer, the default bundle signed with the one signer and verified back to a valid state with its hash** - `094fdf0` (feat); adds `routing.ts`, `bundle.ts`, `gateBundle.test.ts`.
2. **Task 2: Fail-closed states with plain fixes, reserved fields, the clock rule, renewal and the never-customised check** - `9d1e33b` (feat)

## Verification

Each run inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536`.

- Task 1: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateBundle.test.js dist/test/teamBoundaries.test.js'`: 7 tests, 7 pass, 0 fail, 0 cancelled.
- Task 2 and plan level: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateBundle.test.js dist/test/gateLabels.test.js dist/test/gateVocabulary.test.js dist/test/teamSignedPayload.test.js dist/test/teamBoundaries.test.js'`: 102 tests, 102 pass, 0 fail, 0 cancelled, 0 skipped (gateBundle 43, of which 20 are the one-per-reason tests; gateLabels 12; gateVocabulary 19; teamSignedPayload 22; teamBoundaries 6). No full suite or e2e was run, as the plan asks.
- Acceptance: `grep -c "sign(" src/domain/gate/bundle.ts` prints 0; `grep -c "createPrivateKey\|generateKeyPair" src/domain/gate/bundle.ts` prints 0; the test file signs with `signPayload(` and the verifier is called with purpose `policy-bundle`; a test asserts the producers cover exactly the 20 keys of `BUNDLE_FAILURES`; the expiry test uses `expiresAt` exactly and one millisecond before. `teamSignedPayload` passes unchanged. `package.json` and `package-lock.json` are unchanged. No em-dash and no local path in any new file.

## Decisions Made

See the key-decisions above. Also: the verifier's own message for each of its ten reasons is replaced by the plan's fixing sentence (the verifier says what is wrong; a person needs what to do), and a mapping function typed over the verifier's reason list means a new verifier reason will not compile until it has a sentence here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The plan's `defaultBundlePayload({ issuer, now })` and `verifyBundleEnvelope(... { now, lastValidAt })` need a type for time**
- **Issue:** the plan does not say whether `now` is a Date or a number. The pure gate folder already uses epoch milliseconds (plan 02's `DominanceContext.now`).
- **Fix:** all four time inputs (`defaultBundlePayload.now`, `verifyBundleEnvelope.now` and `lastValidAt`, `effectiveNow`, `needsRenewal`) are epoch milliseconds. Callers sign with `now: () => new Date(sameMs)` so the payload's `issuedAt` equals the envelope's `signedAt`.
- **Committed in:** `094fdf0`, `9d1e33b`

**2. [Rule 2 - Missing critical] A routing `localHosts` entry of `*` would make every host local**
- **Fix:** `parseRouting` accepts host patterns in ceiling form but refuses a lone `*` (`not-allowed-here`). Duplicates are refused too.
- **Committed in:** `094fdf0`

**3. [Rule 1 - Bug in my own output] A literal em-dash reached the test file**
- **Fix:** the no-dash check now builds the character with `String.fromCharCode(0x2014)`, so the repo holds none. Committed in `9d1e33b`.

**Plan wording, not deviations:** the plan's closed failure list has no reason for "missing field", "not allowed here" and similar; they map to `wrong-type` as recorded in key-decisions, with the exact path kept in `detail`. `unparseable`, `no-identity` and `identity-unavailable` are produced by the store and identity code in later plans through `failedClosed(reason)`; here they are covered by tests that build the state directly. No existing assertion was changed, weakened or removed.

---

**Total deviations:** 3 auto-fixed. **Impact on plan:** none on scope; nothing imports the new modules yet, so the running extension is unchanged.

## Issues Encountered

None. All 43 gateBundle tests passed on the first full run; the mutation check above confirmed they fail when the clock rules are wrong.

## Authentication Gates

None.

## Known Stubs

None. The reserved fields (`anchorRoots`, `statusLists`, `maxOfflineAge`) and the reserved contexts (`relay`, `routine`) are validated-and-ignored by design (D-12, D-47), not stubs.

## Threat Flags

None. The new files add no endpoints, file access or auth paths beyond the plan's threat model: T-70-08 (tamper) is covered by the signature check and the bad-signature test, T-70-09 (clock set back) by `effectiveNow` and the clock-behind test, T-70-10 (rotated or revoked key) by the status-driven tests, T-70-11 (extra field read as a grant) by closed keys at every level; T-70-SC: no package added.

## User Setup Required

None.

## Next Phase Readiness

- Plan 04 (decision) can read `bundle.ceiling`, `bundle.routing` and `TIER_ORDER` and take the strictest tier of level, handling flag and compartment. It should treat a verb absent from `ceiling.contexts` as allowed nowhere.
- Plan 11 (bundle store) uses `verifyBundleEnvelope`, `failedClosed('unparseable' | 'no-identity' | 'identity-unavailable')`, `needsRenewal` and `isDefaultBundle`, and must sign with the same time it writes into `issuedAt`.
- Reversibility reminder for the owner (task 1 was rated costly): bundle v1's fourteen fields, the context names, the tier names and the `scale/level` routing key form end up in every install's signed file, so a change after release is bundleVersion 2 beside v1.

## Self-Check: PASSED

- Files present: `src/domain/gate/routing.ts`, `src/domain/gate/bundle.ts`, `src/test/gateBundle.test.ts`.
- Commits `094fdf0` and `9d1e33b` are on `feat/gate-vocabulary`; `git rev-list --count` from the recorded base `a1d5073` to `9d1e33b` is 2.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*
