---
phase: 30-replication-contract-and-co-editing-core
plan: 10
subsystem: replica-versions
tags: [replication, decisions, release-gate, contested, attribution, fold]
status: complete

requires:
  - phase: 30-06
    provides: attributionAtSnapshot, attributeText, summariseAuthors, signed client registrations
  - phase: 30-07
    provides: resolveDecisions (the decision algebra)
  - phase: 30-08
    provides: versionsReducer, per-version gate chain through release.ts
  - phase: 30-09
    provides: checkpoints and isFinal
provides:
  - src/domain/replica/versions.ts: decision derivation per version (decide, release, withdraw, supersede), personForTransition, VersionView overlay, decision, attribution and sourceChanged, ProductVersions.working
  - src/test/replicaVersionDecisions.test.ts: 27 tests (15.4 rows G6 to G12, 15.5 transitions, D12 to D24 through the fold, N5, N6, attribution, working text)
  - src/test/replicaForbiddenActs.test.ts: 11 tests (F1 to F9, agent and hub actors)
affects: [30-12, Phase 31, Phase 33]

requirements-completed: [MUS-03, MUS-02]

actuals:
  tokens: 24300
  tasks: 3
  commits: 3
plan_head_before: 41db67925cbe205cde47dfdbbdc7d377b8d559b6
plan_head_after: 88034e56968d52a917d83fc01119f9e8dfa29972

key-files:
  created:
    - src/test/replicaVersionDecisions.test.ts
    - src/test/replicaForbiddenActs.test.ts
  modified:
    - src/domain/replica/versions.ts

key-decisions:
  - "Every decision act is judged alone first. A non-person actor (agent or hub) is passed to release.ts transition() with the matching event and refused agent-cannot-decide before any roster check; a person must hold decision_for:<decisionFor> at the roster the act cites (not-decision-holder), and a decide act needs an effective submit in its causal past (wrong-state). Only surviving acts reach resolveDecisions."
  - "Per-act probing through transition(): an approve or reject is probed against the awaiting-decision record with the real person, a release against an approved probe record, a supersede against a released probe record, so reasons-required, unnamed-person and stale-version come from release.ts itself and the final application cannot fail."
  - "An act is unconfirmed when roleWithdrawnBy(member, role, cited roster) names a roster entry that is present in the fold and concurrent with the act. A removal the act saw confirms it; a removal absent from the fold counts as confirmed until it arrives."
  - "A contested version stays where its undisputed past put it: the acts that precede every contested act are resolved again until the result is not contested, and that outcome is applied. For the plain cases this is awaiting-decision with overlay contested."
  - "Approve-class effective: approve step by the first effective approve act by entry hash (a release act if only releases are maximal), release step when a release act is among the effective acts. Reject uses the first effective act's reasons. Withdraw uses the first effective withdraw. Supersede takes the version through the approval and release in the superseder's causal past and then supersedes."
  - "Supersede needs the newer version to have a valid release act in the supersede's own causal past (not-released otherwise), numbered higher (out-of-order), and to exist (stale-version). Versions are derived newest first so this needs no iteration."
  - "Withdraw: whether the version was approved in the withdraw's own past (resolveDecisions on the decide and release acts before it) decides who may: owner side or decision-role person before, decision-role person only after (not-decision-holder), an agent never after (agent-cannot-decide through transition()). A person who is neither is refused not-owner-or-person."
  - "actorForTransition now maps a hub actor to an agent, never to a person (the fold already keeps hub entries before they reach a reducer; this is the second guard)."
  - "sourceChanged counts only a version whose state is released, and does not report a pin that names a version newer than the newest released one."

duration: single session
completed: 2026-11-19
---

# Phase 30 Plan 10: Decisions on versions Summary

Every decision on a version now comes from real signed entries: approve, reject, release, supersede and withdraw run through the decision algebra and release.ts, an agent or hub can never decide, concurrent conflicting decisions show as contested until a fresh decision that saw them settles it, a decision that races the removal of its role waits for confirmation, and each version carries who shaped its text, its dependants' source changes and the working text state.

## Commits

| Commit | Task | What |
|--------|------|------|
| `8e9864ca` | 1 (tracer) | versions.ts decision derivation, attribution, sourceChanged, working; tracer tests (3) |
| `dea365ef` | 2 | supersede through approval and release; G6 to G12, D2 to D24 and F1 to F9 tests |
| `88034e56` | 3 | attribution, N5, N6 and working-text tests |

The source for all three tasks landed in the first commit (written in one pass); Task 2 added the supersede fix found by its tests, and Tasks 2 and 3 added the tests. Every test was run against the final code.

## Verification

All runs under the shared lock and the 4 GB cap, no swap, 300 s timeout, after `node scripts/vendor-libs.mjs` and `tsc -p tsconfig.json` (clean):

- `replicaVersionDecisions` 27, `replicaForbiddenActs` 11, `replicaVersions` 21, `replicaDecisions` 31, `staffRelease` 13, `replicaAttribution` 7, `replicaCheckpoint` 14: 124 tests, 124 pass, 0 fail in one run.
- `replicaTracer`, `replicaContracts`, `replicaOrder`, `replicaDoc`: 56 tests, 56 pass.
- Acceptance: `grep -c resolveDecisions versions.ts` 3, `summariseAuthors` 2, `sourceChanged` 4, `git diff --stat 41db6792 -- src/domain/staff` empty, G6 to G12 lines 8, F1 to F9 lines 12, "hub" in the forbidden-acts test present, no em-dash in any written file. The full suite was not run (owner instruction).

## What was built

- **Judging acts alone** (`deriveDecisions` in versions.ts): agent and hub acts go to `transition()` and are refused there; persons need the decision role at the cited roster; decide acts need an effective submit in their past; supersede needs a released, higher-numbered newer version. Algebra refusals (terminal, no-approval, no-release, decline-not-pending, stale-version) are added to the version's refusals.
- **Applying the outcome**: APPROVE through approve and release, REJECT with its reasons, WITHDRAW, SUPERSEDE, each through `transition()` with `personForTransition` (roster name, decision role, signing device).
- **Overlays**: `contested` (state stays where the undisputed past left it) and `pending-confirmation` (status none with unconfirmed acts). `decision` carries status, outcome, names, contested, effective, pending, held and finalBeforeDispute.
- **Attribution**: `attributionAtSnapshot` plus `attributeText` and `summariseAuthors` per version, from the snapshot the proposal pinned (kept on the proposal).
- **sourceChanged** and **working** (`open` or `withdrawn`), both in the digest input.
- `VERSION_REFUSALS` gained not-decision-holder, not-released, no-approval, no-release, decline-not-pending (wrong-state and out-of-order come from the existing lists).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Supersede was applied to a record that was not released**
- **Found during:** Task 2 (G10 and G12 failed, v1 stayed awaiting-decision)
- **Issue:** the first version applied the effective SUPERSEDE to the post-submit record, which release.ts refuses (the version must be released).
- **Fix:** take the version through the approval and release acts in the superseder's past, then supersede.
- **Files modified:** src/domain/replica/versions.ts
- **Commit:** dea365ef

**2. [Rule 2 - Missing critical functionality] A hub actor fell through to the person branch of actorForTransition**
- **Issue:** `actorForTransition` treated any non-agent as a person. The fold keeps hub entries before they reach a reducer, so it never happened, but a future change could present a hub as a person.
- **Fix:** a hub maps to an agent that can never decide; tested directly (F1 release.ts test).
- **Files modified:** src/domain/replica/versions.ts
- **Commit:** 8e9864ca

### Plan interpretations worth knowing

- **Hub actors cannot be refused by the reducer**: the fold keeps a hub entry as `hub-actor` (kept, no state change) before any reducer sees it, so for hub actors F1 to F4 assert `kept` with reason `hub-actor` and that nothing changed, and assert the machine-level refusal (agent-cannot-decide) through `actorForTransition` and `transition()` directly. Agent actors are asserted refused agent-cannot-decide in the fold, on a device whose member holds the role and on one that does not.
- Test world builders are local copies in both test files (the shared helper is not edited), as the plan says.
- Supersede is shown as a stale hash when the version it names is unknown (stale-version), and the stale-version check now covers every version act kind, not only verdict and submit.

## Notes for 30-12 and Phase 31

- Register `versionsReducer` after `textReducer` (unchanged from 30-08). `ProductVersions` gained `working`; `VersionView` gained `overlay`, `decision`, `attribution`, `sourceChanged`. All four are in `canonical`, so digests now cover them.
- A removal whose roster entry is not in the fold yet is treated as absent (the decision counts as confirmed). When the entry arrives and is concurrent with the decision, the decision becomes pending-confirmation. Phase 31's real roster fold should keep `roleWithdrawnBy` returning the hash of the roster entry itself.
- Writers must put the submit (and for a release or withdraw the acts it saw) in `deps` and `decisionsSeen`: deps are capped at 16, and the algebra reads both, so a write path should list the decision heads it saw in `decisionsSeen`.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-30-39 (agent or hub deciding: F1 to F4 on devices with and without the role), T-30-40 (person without the role: not-decision-holder), T-30-41 (release without or with another hash's approval: F6, F7) and T-30-42 (a removed role's decision: D16 to D21, F9) are covered.

## Files touched outside files_modified

None (this SUMMARY aside).

## Self-Check: PASSED

Files exist: `src/domain/replica/versions.ts`, `src/test/replicaVersionDecisions.test.ts`, `src/test/replicaForbiddenActs.test.ts`. Commits `8e9864ca`, `dea365ef`, `88034e56` are ancestors of HEAD on `agent-30-10`.
