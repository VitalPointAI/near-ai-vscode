---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 10
subsystem: team-mode
tags: [team-mode, signed-payloads, ed25519, key-status, domain-separation, near-implicit-account]

requires:
  - phase: 69-09
    provides: device.rotated and the DeviceKey rotation fields (rotatedEvent, rotatedAt, rotatedTo) that the roster status source reads
provides:
  - "signPayload(signer, purpose, payload, options?) and a never-throwing verifyPayload(envelope, { purpose, status }) in src/domain/team/signedPayload.ts"
  - "A closed list of ten failure reasons with plain messages (PAYLOAD_FAILURES)"
  - "KeyStatusLookup with the team roster as first source (teamKeyStatus), NO_KNOWN_KEYS and combineKeyStatus"
  - "implicitAccountId: the NEAR implicit account id of an Ed25519 key, derived offline"
affects: [69-11, 69-15, 70, 71, 80]

pr2_base: 6fd91a6a7be56d52ba9a9cb07297e511d744874a

actuals:
  tokens: 13316
  tasks: 2
  commits: 2
plan_head_before: 1c16f11da860a3c74183dff0bf19fd26fed4a914
plan_head_after: ead696b22dd6338b8ae953f22569924516a41257

tech-stack:
  added: []
  patterns:
    - "Domain separation by a text prefix (domain, purpose) in front of the canonical JSON, so a payload signing input starts with n and a team event's with a brace"
    - "The verifier takes the expected purpose and the status source from its caller and canonicalises the untrusted input once, so the checks, the size and the returned payload all describe the same bytes"
    - "Optional fields are left out, never undefined (memberId, since, replacedBy), so the canonical form never throws on them"

key-files:
  created:
    - src/domain/team/signedPayload.ts
    - src/domain/team/keyStatus.ts
    - src/test/teamSignedPayload.test.ts
    - src/test/teamKeyStatus.test.ts
  modified: []

key-decisions:
  - "verifyPayload canonicalises the input once and checks a JSON copy of that text, so a getter or Proxy that answers differently on a second read cannot show the check one payload and the caller another"
  - "signedAt must be exactly the text toISOString() gives, because signPayload is the only signer; any other form is malformed"
  - "A status source that throws, a rotated answer with no readable since, and any state other than active or rotated-before-since all refuse (fail closed)"
  - "signPayload also checks the signer: the public key must match the fingerprint, and the returned signature must verify against the public key, so a broken signer cannot produce an envelope every verifier refuses"
  - "The payload size limit counts the whole canonical envelope (signer, time and signature included), on both sign and verify"

patterns-established:
  - "Later phases add a purpose by adding one entry to PAYLOAD_PURPOSES and a test; a new format takes v 2 beside v 1"

requirements-completed: []
status: complete
---

# Phase 69 Plan 10: one signer and verifier for any canonical payload Summary

**Any Ed25519 signer (the person's device identity or an agent-style key) signs and verifies any canonical payload through `signPayload` and `verifyPayload`, with purpose-bound domain separation and a key status lookup that honours rotation and revocation, with the team roster as the first status source.**

## Task 1: tracer, the person's identity signs a policy-bundle sample

Commit `5a1ccd8`. `keyStatus.ts` holds `KeyState`, `KeyStatus`, `KeyStatusLookup`, `NO_KNOWN_KEYS`, `teamKeyStatus` and `combineKeyStatus`. `teamKeyStatus` finds a key through `deviceIndex`, requires the stored public key to equal the presented one (otherwise unknown), and answers in this order: removed member (revoked, reason "removed from the team", since the removal time), revoked key, rotated key (since the rotation time, with the replacement's fingerprint), active. The header says callers choose the sources and a solo check never combines a team's roster.

`signedPayload.ts` builds the envelope `{ v: 1, purpose, signer: { fingerprint, publicKey, memberId? }, signedAt, payload, sig }`. The signing input is the domain `near-ai-vscode/signed-payload/v1`, a newline, the purpose, a newline, then the canonical JSON of the envelope without `sig`. `verifyPayload` never throws and checks in order: shape and version, size, purpose in the list and equal to the caller's, public key shape and fingerprint, signing time, signature, then the key status.

The tracer test creates the identity with `loadOrCreateDeviceIdentity` (a `MemorySecrets` and a temp folder), makes it the owner's device in a team built from the real genesis events, signs the policy-bundle sample, and verifies it against the roster. The same envelope against `NO_KNOWN_KEYS` gives `unknown-key`.

## Task 2: the full contract

Commit `ead696b`. Tests only; the two modules passed every case unchanged, so no product code changed in this commit. `teamSignedPayload.test.ts` has 21 tests and `teamKeyStatus.test.ts` has 8.

- Every purpose round-trips for the device identity and for a plain in-test Ed25519 signer; `memberId` present and absent (absent means no key at all, and adding or changing it breaks the signature).
- Domain separation both ways: the first byte is `n` for a payload and `{` for an event; a payload signature on an event fails `verifyEventSignature`; an event signature in a payload envelope gives `bad-signature`; signed for `grant` and checked as `policy-bundle` gives `wrong-purpose`; the purpose field edited gives `bad-signature`.
- Single changed fields give `bad-signature` or `key-mismatch`; `v: 2` gives `unsupported-version` whose text asks to update the extension.
- `signPayload` refuses a fraction, an undefined value, nesting past the canonical depth, a payload over the limit, an unknown purpose, a non-plain object, a signer whose key does not match its fingerprint, a signer that returns a foreign signature, and a run-time generated secret canary (the message names the path and never repeats the canary).
- 2000 seeded inputs (null, numbers, huge strings, circular objects, Proxies whose traps throw, mutated valid envelopes) never throw and always answer with a reason from the closed list; a second test shows every reason in the list is produced by some input.
- Rotation at the instant: a payload claimed one millisecond before the rotation verifies (key state `rotated`), at exactly the rotation time or later gives `key-rotated` whose message points to revoking; the replacement key is active. A revoked key is refused whatever `signedAt` says; a removed member's key is revoked in the roster and active in the person's own history.
- `implicitAccountId` of a generated key is the 64 lowercase hex characters of the raw key, and the NEAR documentation vector holds through a ten-line base58 decoder inside the test.

A mutation check confirmed the tests bite: changing `>=` to `>` in the rotation comparison failed the rotation test, and dropping the purpose from the signing input failed the domain-separation test; both were restored before committing.

## Verification

All commands run from the PR 2 worktree inside the owner-rules cap wrapper (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

| Command | Result |
| --- | --- |
| Task 1 verify: `npx tsc -p tsconfig.json && node --test dist/test/teamSignedPayload.test.js dist/test/teamKeyStatus.test.js dist/test/teamBoundaries.test.js` | 8 tests, 8 pass, 0 fail, 0 cancelled |
| Task 2 verify: `npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/teamSignedPayload.test.js dist/test/teamKeyStatus.test.js dist/test/teamMaterialize.test.js dist/test/teamCanonical.test.js` | 75 tests, 75 pass, 0 fail, 0 cancelled |
| Same plus `dist/test/teamBoundaries.test.js` (after the last edit) | 80 tests, 80 pass, 0 fail |
| All team suites: `node --test --test-concurrency=2 dist/test/team*.test.js` | 579 tests, 579 pass, 0 fail |
| `npx tsc -p tsconfig.json` (the repo's `lint` is `tsc --noEmit`) | clean |

Acceptance: the domain string appears on 1 line of `signedPayload.ts`; `export function verifyPayload` and `export function teamKeyStatus` each on 1 line; the NEAR vector on 1 line of the test; both `node -e` checks (no em-dash in any message, the rotated message mentions revoking) exit 0; payload tests 21 (at least 15), key status tests 8 (at least 6). `git diff --stat 6fd91a6..HEAD` for plan 10's own commits touches exactly the four files in `files_modified`; `package.json` and the lockfile are unchanged (T-69-SC).

## Deviations from Plan

### Auto-fixed Issues

None needed. Task 1's header comment first quoted the domain string in prose, which made the plan's acceptance grep count 2 instead of 1; the comment was reworded before the first commit.

### Other deviations

- Commit trailers use the model that ran (`Claude Sonnet 5.5`), per the owner rules, not the `Claude Opus 5.5` line in the plan text.
- Task 2 is test-only. The behaviours it lists were built into Task 1's modules because the sign and verify paths are one design; I did not stage a failing-first run and instead confirmed the tests bite with the two mutations above.
- Two small additions beyond the plan text, both fail-closed: `signPayload` verifies its own signature before returning, and `verifyPayload` reads its input once (a JSON copy of the canonical text) so a changing getter cannot split what is checked from what is returned.

## Known Stubs

None. This plan adds no UI, data source or placeholder.

## Threat Flags

None beyond the plan's register. T-69-24 (cross-protocol replay) is covered by the domain prefix, the caller-supplied purpose and the first-byte test both ways; T-69-25 by the fingerprint recomputation before the signature check; T-69-26 by version 1 only; T-69-27 is accepted and the rotated message says only revoking stops a copied key; T-69-28 by the size limit, the canonical depth limit and the never-throw fuzz; T-69-29 by `assertNoSecrets` on sign with a run-time canary; T-69-SC by the unchanged lockfile.

## Open for the owner and for later plans

1. Plan 09's hand-off: `TeamLog.verifyAll` in `src/team/eventLog.ts` still reports each device as `{ fingerprint, revoked }`, so a rotated key shows as an ordinary active device there. This plan's status lookup does report `rotated` (with `since` and `replacedBy`), and `verifyPayload` returns `keyState: 'rotated'` for an old key that verifies; but `eventLog.ts` is outside this plan's `files_modified`, so the report and the session's "(revoked)" label were not changed. A later plan that touches the report can read `teamKeyStatus` instead of the flag.
2. The reversibility rating "costly" for the signed format (D-08) should be named in the PR 2 body (plan 15), as the plan says.
3. Plan 11 (local key history) can import `signedPayload.ts` with no cycle: it imports `keyStatus` only as a type.

## Self-Check: PASSED

- Commits `5a1ccd8` and `ead696b` are ancestors of HEAD on `feat/team-signed-payloads`.
- `src/domain/team/signedPayload.ts`, `src/domain/team/keyStatus.ts`, `src/test/teamSignedPayload.test.ts` and `src/test/teamKeyStatus.test.ts` exist.
- The full set of team suites (579 tests) passes with 0 failures.
