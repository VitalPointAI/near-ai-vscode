---
phase: 33-live-multi-user-staff-projects
plan: 18
status: complete
subsystem: replica wire pieces
tags: [staff, replica, hub, features, post-01, server-pin]
requires: []
provides: [KNOWN_REPLICA_FEATURES, REPLICA_FEATURE_PATTERN, isReplicaFeature, missingFeatures, coversRequired, UPDATE_SENTENCE, MAX_FEATURES, SESSION_VERSION 2, SessionAnswerPayload.features, serverPinWords, SERVER_WORDS_DOMAIN, SERVER_WORD_COUNT]
affects: [33-03, 33-07, 33-08, 33-11]
tech-stack:
  added: []
key-files:
  created:
    - src/domain/replica/features.ts
    - src/domain/replica/serverWords.ts
    - src/test/replicaFeatures.test.ts
    - src/test/replicaServerWords.test.ts
  modified:
    - .dockerignore
    - src/domain/replica/hubFile.ts
    - src/test/replicaHubFile.test.ts
    - src/test/replicaBoundaries.test.ts
    - hub/test/session.test.ts
requirements: [POST-01, MUS-09]
requirements-completed: []
actuals:
  tokens: 9000
  tasks: 3
  commits: 4
completed: 2026-11-24
plan_head_before: d9a3736996de01b643784d111d240f850def5a3a
plan_head_after: 72d9e3cd
---

# Phase 33 Plan 18: Wire pieces Summary

The hub and the engine share one replica feature registry. A device signs the features it folds inside its TLS-bound session answer (session version 2), and a staff lead can compare twelve words of a server's certificate pin with the operator before re-admitting it.

## Reconciled from Codex

`feat/phase-33-18-wire-pieces` started from `main` before the integration branch existed, so it was not merged directly. Its two commits were applied onto the integration work, keeping their authorship. `846733bc` (signed session features) was cherry-picked as it was. The untested WIP `c94b2f21` (feature negotiation, server words, tests and a draft summary) was taken apart into normal commits, with the fixes below.

## Contract

- `KNOWN_REPLICA_FEATURES` is `cells@1, hub@1, replica@2, require@1`, sorted and frozen. It is the one registry. Ids have the form `name@N`, matching `/^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/`. `features.ts` has no imports and is on `HUB_SIDE`, so the hub compiles the same file. It is also allowed into the hub image by `.dockerignore`.
- `missingFeatures(required, known)` returns a sorted list with no duplicates. `coversRequired(announced, required)` is true only when every required id is both announced and known to this build, so a lying announcement cannot cover a feature the build lacks.
- `UPDATE_SENTENCE` is "This shared work needs a newer version of Sterling. Ask your administrator to update it." This is D-67 and the owner's text rule. It replaces portfolio DESIGN 3.9's "extension" sentence, which the plan text still quoted. It names no version and does not call the shared work a project (D-69).
- `SESSION_VERSION` is 2. The session answer signs `features` sorted, unique and at most 16 valid ids. An answer without the field reads as an empty announcement. A version 1 answer is refused as malformed.
- `serverPinWords(certPin)` gives twelve lower-case words from the one safety word list, at 11 bits per word. They come from the first 17 bytes of sha256 over `near-ai/server-pin/v1`, a NUL byte, a 4-byte big-endian length, and the pin bytes. Upper-case and lower-case hex give the same words. A pin that is not 64 hex characters throws a TypeError that does not print it. Nothing is imported from `src/domain/gate`.

## Decisions (A1)

The local id pattern differs from the gate bundle's `FEATURE_ID_PATTERN`. The gate allows dots, names up to 64 characters and an optional version up to 9999. The replica id requires a version (1 to 999), allows no dots, and limits names to 32 characters. It stays independent of the gate module so that the hub's dependency boundary holds.

## Deviations from Plan

1. **[Owner rule, D-67] The update sentence** is the Sterling sentence, and its test now checks those words, that no version number appears, and that the word "project" does not appear.
2. **Rollout:** the v2 reader refuses v1 answers, as the plan specifies. A hub image or extension released before this change speaks v1. The first live staff release therefore needs the hub and the clients upgraded together, which belongs to the release notes of the Sterling container release (D-66).

## Verification

This was the first combined test run of the WIP. Under the shared heavy lock, MemoryMax=6G and choom: a clean compile, then `run-tests` on replicaHubFile, replicaBoundaries, staffHubTransport, replicaFeatures, replicaServerWords, architecture and copyLint: **139 tests passed, 0 failed, 0 skipped.** Then the full hub suite on Node 26.13.1: **401 passed, 0 failed, and 3 skipped.** The 3 skipped are the existing older-Node refusal checks. They need `NEAR_AI_HUB_OLD_NODE` and run in GitHub Actions. They are unrelated to this plan.

- Commits: `a20dc2d5` (cherry-pick of `846733bc`), `a0a1e0dc` (coverage rules and the Sterling sentence), `72d9e3cd` (pin words), and this summary.
- Tests added: 13 from the WIP (9 feature-rule tests and 4 pin-word tests), plus the session and hub tests from `846733bc`: 8 replicaHubFile tests named for features, and 2 hub session tests.
- Test changed: 1. The update-sentence test now checks the D-67 words, and also checks that the sentence contains no "project".
- Acceptance: `SESSION_VERSION = 2;` is present. `'domain/replica/features'` is on HUB_SIDE. `serverWords.ts` imports nothing from `domain/gate`. The copy-lint and architecture baselines are unchanged.

## Known Stubs

None. The hub's enforcement of features is 33-07, the client's announcement is 33-08, and the Re-admit action is 33-11.

## Threat Flags

None beyond T-33-12, T-33-72 and T-33-73 in the plan.
