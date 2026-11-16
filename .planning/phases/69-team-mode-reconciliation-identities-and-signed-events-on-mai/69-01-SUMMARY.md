---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 01
subsystem: team-mode
tags: [team-mode, ed25519, canonical-json, permissions, port]

requires:
  - phase: 60 (archive branch feat/team-fix-pass at ae5e9e1)
    provides: the pure Team Mode domain core, re-applied unchanged
provides:
  - "src/domain/team: types, canonical, permissions, policy, secrets, validate, materialize (byte-identical to ae5e9e1)"
  - "teamCanonical, teamPermissions, teamSecrets tests green on main"
  - "TMR-01 evidence for the archive branch, recorded before any code moved"
affects: [69-02, 69-03, 69-04, 69-05, 69-06, 69-07, 69-09, 69-10]

actuals:
  tokens: 31608
  tasks: 2
  commits: 2
plan_head_before: 4e5dbb9
plan_head_after: 87c8d90c8ebc1b06c01f1beb7637adb3a8e36ce3

tech-stack:
  added: []
  patterns:
    - "Re-apply from the archive by explicit path (git show ae5e9e1:<path>), never a glob or the branch tip"

key-files:
  created:
    - src/domain/team/types.ts
    - src/domain/team/canonical.ts
    - src/domain/team/permissions.ts
    - src/domain/team/policy.ts
    - src/domain/team/secrets.ts
    - src/domain/team/validate.ts
    - src/domain/team/materialize.ts
    - src/test/teamCanonical.test.ts
    - src/test/teamPermissions.test.ts
    - src/test/teamSecrets.test.ts
  modified: []

key-decisions:
  - "No drift: main's broader redactSecrets did not change any teamSecrets expectation, so every ported file stays byte-identical to ae5e9e1"
  - "Event type union left as Phase 60 declared it; the refusal text 'unsupported event type for this version' is present and used (D-04)"

requirements-completed: [TMR-01, TMR-02]

duration: 25min
completed: 2026-11-15
status: complete
---

# Phase 69 Plan 01: Domain core from ae5e9e1 Summary

**The pure Phase 60 Team Mode domain core (canonical JSON, event types, permission matrix, policy, secrets guard, validation, materializer) runs byte-identical on main, with 97 passing tests and the archive branch confirmed first.**

## Performance

- **Duration:** about 25 min
- **Tasks:** 2 of 2
- **Files created:** 10 (all new on main, nothing existing changed)

## Accomplishments

- TMR-01 checked read-only before any code moved; the archive branch is at the expected commit.
- Seven `src/domain/team` files and three tests copied from `ae5e9e1` by explicit path; `git diff --exit-code ae5e9e1` over all ten paths exits 0.
- teamCanonical (10), teamPermissions (57), teamSecrets (30): 97 tests, 0 failures, 0 cancelled.
- The worktree builds: `npm ci` then `npm run compile` exit clean, and `npx tsc -p tsconfig.json` is clean with the ported files.

## TMR-01 evidence

Collected before the first copy, all read-only.

- `git fetch origin` completed; `git ls-remote origin refs/heads/feat/team-fix-pass`:
  `4207080ca394d36cf36bbed37b179d8f8400b721	refs/heads/feat/team-fix-pass`
  This equals the expected hash.
- `git rev-list --count 6f779f3..origin/feat/team-fix-pass`: `777`
- `git show --name-status --format='%h %s' 4207080`:
  ```
  4207080 chore(team-mode): archive uncommitted work before pushing the branch as an archive

  M	.planning/PROJECT.md
  M	.planning/config.json
  A	.planning/phases/62.1-board-timeline-milestones-on-one-timeline-with-cards-as-dots/.gitkeep
  M	.planning/state.json
  M	src/test/e2e/cdp.ts
  M	src/test/e2e/codeServerTeam.ts
  ```
- Legacy worktree for `feat/team-fix-pass` (found through `git worktree list`, reachable from this session; its path is a local machine path and is left out of this file): `git --no-optional-locks status --short` printed nothing, so the worktree is clean and holds no loose files.
- `git cat-file -t ae5e9e1` prints `commit`, and `ae5e9e1` is an ancestor of `origin/feat/team-fix-pass` after `git fetch origin feat/team-fix-pass`.

## Unchanged-port evidence: domain core

| Test file | Tests | Pass | Fail |
|---|---|---|---|
| teamCanonical | 10 | 10 | 0 |
| teamPermissions | 57 | 57 | 0 |
| teamSecrets | 30 | 30 | 0 |

Combined run (`--test-concurrency=2`): 97 tests, 97 pass, 0 fail, 0 cancelled, 0 skipped.

Commands (run from the worktree root, inside the owner's cap):

- Task 1: `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/teamCanonical.test.js'`
- Task 2: same wrapper with `node --test --test-concurrency=2 dist/test/teamCanonical.test.js dist/test/teamPermissions.test.js dist/test/teamSecrets.test.js`

## Drift

None. main's `redactSecrets` (called by `assertNoSecrets` in `secrets.ts`) did not change any teamSecrets outcome, so no expectation was edited and no assertion was added, loosened or removed.

## Task Commits

1. Task 1 (tracer): `46ab343` feat(team): canonical JSON and team event types from Phase 60 (ae5e9e1)
2. Task 2: `87c8d90` feat(team): permissions, policy, validation, secrets guard and materializer from Phase 60 (ae5e9e1)

## Acceptance checks

- `git diff --exit-code ae5e9e1 -- src/domain/team src/test/teamCanonical.test.ts src/test/teamPermissions.test.ts src/test/teamSecrets.test.ts` exits 0.
- `git diff --name-status 4e5dbb9..HEAD` (the plan's two commits) lists exactly ten `A` lines and no `M` or `D`. No existing source file on main changed.
- `git ls-files src/domain/team` prints 7 paths (none before).
- `grep -c "unsupported event type for this version" src/domain/team/types.ts` is 1; `grep -c "TEAM_REJECTION_REASONS.unsupported" src/domain/team/validate.ts` is 3.
- `secrets.ts` references `redactSecrets` (2 matches), the key link to `src/domain/redaction.ts`.

## Deviations from Plan

### Environment notes (not code deviations)

**1. Worktree already existed.** The plan's Task 1 precondition asks for a dedicated worktree on `feat/team-core-on-main`. The orchestrator had created it from `origin/main` (c1730bf) with one docs commit on top (`4e5dbb9`, plan review findings). I verified the branch and worktree instead of creating them.

**2. Diff baseline.** The plan's acceptance wording uses `git diff --name-status origin/main...HEAD`. Because the branch also carries the `4e5dbb9` docs commit (`.planning` plan edits), that command additionally lists six `M` lines under `.planning`. The plan's own commits are measured with `4e5dbb9..HEAD`: ten `A` lines, nothing else. Filtering the `origin/main...HEAD` output for non-`.planning` paths gives the same ten `A` lines.

**3. Commit trailer.** The commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, the model that ran this plan, where the plan and owner rules name `Claude Opus 5.5`. Flagged for the owner in case the plain text matters.

Otherwise none: the plan executed as written, with no auto-fixes and no auth gates.

## Known Stubs

None. Nothing in the ported files is a placeholder; the later `TeamEventType` values beyond the ten implemented bodies are declared on purpose and refused by validation (D-04).

## Threat Flags

None. No new endpoint, auth path, file access or schema at a trust boundary: the ten files are pure domain code and tests, and nothing is imported by existing runtime code yet.

## Self-Check: PASSED

- All ten created files exist.
- Commits `46ab343` and `87c8d90` are ancestors of HEAD.
