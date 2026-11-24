---
phase: 33-live-multi-user-staff-projects
plan: 18
subsystem: replica-protocol
tags: [staff, replica, hub, tls]
provides:
  - Shared replica feature ids, registry and coverage checks
  - Signed session v2 feature announcements
  - Twelve certificate pin words for server re-admission
affects: [33-03, 33-07, 33-08, 33-11]
actuals:
  tokens: 8624
  tasks: 3
  commits: 1
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
requirements-completed: [POST-01, MUS-09]
completed: 2026-11-22
status: complete
---

# Phase 33 Plan 18 Summary

The hub and extension share one replica feature registry. A device signs its feature announcement in the TLS-bound session answer, and a staff lead can compare twelve certificate pin words with the operator before re-admission.

## Accomplishments

- Verified that the existing session commit signs version 2 answers with at most sixteen sorted, unique feature ids. A version 2 answer without the field has an empty announcement. Version 1 answers are refused.
- Added `missingFeatures` and `coversRequired`. A requirement is covered only when this build knows the feature and the device announces it. Missing ids are returned as a sorted, distinct list.
- Added `serverPinWords`, which hashes the 32 decoded pin bytes under `near-ai/server-pin/v1` with the same length framing and bit order as issuer words. It reads the first 132 bits as twelve indices into the shared safety word list. Uppercase and lowercase hex give the same words.

## Task Commits

1. Signed session features and shared registry base in existing commit `846733bc`.
2. Registry coverage checks and their nine tests are ready for the orchestrator to commit.
3. Pin word derivation and its four tests are ready for the orchestrator to commit.

## Verification

- The D-01 base check on the parent of `846733bc` matched the version 1 payload and expected entry points.
- Test-first compilation returned exit 2 with the two missing feature helpers and the missing pin-word module. The independent certificate pin vector was calculated from the framed bytes and the committed word list.
- Compilation and lint passed. All 139 focused extension tests passed across registry, pin words, signed session, hub transport, replica boundaries, architecture, and copy lint.
- The full Node 26.13.1 hub run passed 395 tests with no failures. Its three older-Node tests skipped because the older binary was unspecified. All three passed on a focused rerun with Node 24.22.3 supplied.
- Git whitespace and unchanged architecture and copy-lint baselines verified.

## Decisions

- The replica wire id requires a version, permits names up to 32 characters with lowercase letters, digits and hyphens, and permits versions 1 through 999. The gate bundle's separate id rule allows dots, names up to 64 characters and optional versions through 9999. The replica registry stays independent of the gate module to keep the hub's dependency boundary.
- The server words keep their own hash domain and use the existing safety list. Tests pin a stable vector and compare it with issuer words and the join code.

## Deviations and rollout

- The resumed commit includes the narrowly scoped Docker allowlist entry for the hub-side feature module. No package or baseline changed.
- The worktree's Git index is read-only in the sandbox. The orchestrator owns the remaining local commits.
- The environment denied the user systemd scope. Verification retained the shared heavy-check lock, timeout, OOM adjustment, Node heap limit and repository test runner. The local TLS and child-process suites used approved subprocess and socket access.
- The version 2 reader intentionally refuses version 1 as the plan specifies. The published v0.4.36 main commit now has the version 1 operator hub, so the first live staff release needs coordinated hub and extension upgrade instructions. The orchestrator has been notified.
