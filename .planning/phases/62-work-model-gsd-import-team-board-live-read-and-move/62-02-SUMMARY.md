---
phase: 62-work-model-gsd-import-team-board-live-read-and-move
plan: 02
subsystem: team-core
tags: [team-mode, git-plumbing, gsd-import, private-ref, change-detection]

requires:
  - phase: 60-team-core-identity-signed-event-log-git-transport-roster
    provides: runGit, redactGitMessage, isGitRefName, the blobSizes and cat-file batch precedent
provides:
  - fetchIntegrationBranch, fetching the integration branch into refs/near-ai/integration/<branch> without FETCH_HEAD
  - readPlanningSnapshot, size-checked capped reads of .planning from any ref plus the .planning tree hash
  - remoteBranchHead, a cheap ls-remote "did the branch move" check
  - isAncestor, the stale-leader ancestry check returning true, false or unknown
affects: [62-03, 62-04, 62-05, 62-06]

actuals:
  tokens: 4538
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "The ref is a parameter: tests and the live check read HEAD, the product reads the private ref"
    - "Every git call goes through the injected GitRunner; every failure reason passes redactGitMessage"
    - "Tree paths come from ls-tree -r -z and are data only, never used to open a file"

key-files:
  created:
    - src/team/integrationSource.ts
    - src/test/teamImportSource.test.ts
  modified: []

key-decisions:
  - "The fetch uses --no-write-fetch-head and an explicit forced refspec, so FETCH_HEAD, HEAD, the index, the working tree and local branches are untouched"
  - "A symbolic link under .planning is listed but never read, and a blob that is not a regular file is never opened"
  - "remoteBranchHead throws an Error with the redacted reason on failure, and returns undefined only when the remote lacks the branch"
  - "isAncestor returns unknown without calling git when an argument is not a hexadecimal commit id"

requirements-completed: []
requirements-advanced: [BOARD-01]

coverage:
  - id: D1
    description: "The integration branch is fetched into a private ref and .planning is read from it; an unpushed local draft never appears and the member's HEAD, branches, status and FETCH_HEAD are unchanged"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamImportSource.test.js#the integration branch is read from a private ref and an unpushed local draft stays invisible"
        status: pass
    human_judgment: false
  - id: D2
    description: "The remote head and the .planning tree hash serve as change detectors: a README-only push moves the head but not the tree hash, a new plan moves both"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamImportSource.test.js#the remote head moves with every push but the .planning tree hash moves only when .planning changes"
        status: pass
    human_judgment: false
  - id: D3
    description: "Ancestry answers true, false and unknown for a commit that does not exist locally"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamImportSource.test.js#isAncestor answers yes, no, and unknown for a commit that does not exist locally"
        status: pass
    human_judgment: false
  - id: D4
    description: "Reads are bounded and failures are redacted: oversize files are listed and not read, a missing branch is missing, an unreachable remote is offline, and a canary password never appears"
    requirement: BOARD-01
    verification:
      - kind: integration
        ref: "dist/test/teamImportSource.test.js#a plan file over the size cap is listed as oversize and never read, and files the caller does not want are listed but not read"
        status: pass
      - kind: integration
        ref: "dist/test/teamImportSource.test.js#a missing integration branch is reported as missing and an unreachable remote as offline without leaking credentials"
        status: pass
      - kind: integration
        ref: "dist/test/teamImportSource.test.js#remoteBranchHead is undefined for a branch the remote does not have and explains a failure without the credentials"
        status: pass
    human_judgment: false
  - id: D5
    description: "Hostile names are inert: refused branch names never reach git, and a path with a space or newline is listed exactly with nothing created on disk"
    requirement: BOARD-01
    verification:
      - kind: unit
        ref: "dist/test/teamImportSource.test.js#a branch name git would refuse never reaches git"
        status: pass
      - kind: integration
        ref: "dist/test/teamImportSource.test.js#a .planning path with a space or a newline is listed exactly and nothing is created on disk for it"
        status: pass
    human_judgment: false

duration: 8min
completed: 2026-11-02
status: complete
plan_head_before: 94f87a385358bf15b9ee28afb8589591f1b6eaf8
plan_head_after: bed1d33d065af274f6611a7d17cb05dff0d6950b
commits: 4
---

# Phase 62 Plan 02: Integration branch source Summary

**vscode-free git plumbing that fetches the team's integration branch into refs/near-ai/integration/<branch>, reads .planning from that ref with size checks and caps, and exposes a remote-head probe, a .planning tree-hash change detector and an ancestry check, proven on real git with an unpushed draft staying invisible.**

## Performance

- **Duration:** 8 min
- **Tasks:** 2 (1 tracer, 1 auto), both TDD
- **Files:** 2 created (`src/team/integrationSource.ts`, `src/test/teamImportSource.test.ts`)

## Accomplishments

- A second clone holding an unpushed local draft plan fetches the integration branch into the private ref and reads exactly the four pushed `.planning` paths; the draft is not listed and not read. HEAD, `git branch --list`, `git status --porcelain` and the presence of `.git/FETCH_HEAD` are the same before and after.
- The `.planning` tree hash read from the private ref on one clone equals the hash read from `HEAD` on the author clone. It stays equal when only `README.md` changes and differs when a plan file is added, so it detects re-import need without a diff.
- Each blob is size-checked with `cat-file --batch-check` before one `cat-file --batch` read. A 300 KB plan is reported in `oversize` and not read; reads stop at 2000 listed paths or 8 MB of wanted text with `truncated` set.
- A branch absent on the remote gives kind `missing`; an unreachable remote gives kind `offline`. A canary password in the remote URL never appears in either reason.

## Task Commits

1. **Task 1 (tracer): private-ref fetch and planning read** - `c3f5e42` (test), `dfd9ee8` (feat)
2. **Task 2: change detection, remote head, ancestry, caps, failures** - `5eafc66` (test), `bed1d33` (feat)

Tracer gate: auto mode, the tracer verify command was re-run and passed before Task 2 started (`Tracer verified end-to-end - expanding`).

## TDD Gate Compliance

- RED (Task 1): `c3f5e42`. The module existed as a stub that threw "not implemented", so the file compiled and both tests failed when the stubbed functions ran. The failure is a stub throw, not an assertion on the planned values; this is the standard way to get a compiling RED for a new module. Semantic assessment: both target tests executed and failed for the intended reason (the behavior did not exist). The `gsd_run check tdd-red-evidence` classifier was not run.
- RED (Task 2): `5eafc66`. Three tests failed for the same reason (remoteBranchHead, isAncestor stubs). The oversize, failure-mapping, hostile-name and odd-path tests passed at RED because that behavior had already been implemented with the tracer (caps and failure mapping were part of the Task 1 implementation). They are regression coverage, not RED proof, and are recorded here rather than hidden.
- GREEN: `dfd9ee8`, `bed1d33`. No REFACTOR commit was needed.

## Verification

- `npx tsc -p tsconfig.json && node --test dist/test/teamImportSource.test.js dist/test/teamRunGit.test.js`: 11 tests, 11 pass.
- `npm run lint`: exits 0.
- Acceptance greps: `refs/near-ai/integration/` and `no-write-fetch-head` match in the module, no `from 'vscode'`, both `export async function` lines match, `canary-secret-62` matches in the test.

## Deviations from Plan

None - plan executed exactly as written. (The temporary stub module in each RED commit is the TDD mechanism, not a deviation.)

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. The fetch updates the remote-tracking ref for the named remote as an ordinary git fetch does when an explicit refspec matches a configured one; this is the same state a normal `git fetch` leaves and no local branch, HEAD or index is touched.

## Next Phase Readiness

Ready for 62-03. The importer can now read GSD files committed on the integration branch with `readPlanningSnapshot(projectRoot, integrationRef(branch), wanted)` after `fetchIntegrationBranch`, can probe `remoteBranchHead` cheaply, and can compare `treeHash` against the last imported hash.

## Self-Check: PASSED

- FOUND: src/team/integrationSource.ts
- FOUND: src/test/teamImportSource.test.ts
- FOUND commits: c3f5e42, dfd9ee8, 5eafc66, bed1d33
