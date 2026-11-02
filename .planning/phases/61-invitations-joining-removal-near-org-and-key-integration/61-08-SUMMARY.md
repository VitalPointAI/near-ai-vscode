---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 08
subsystem: team-core
tags: [near-link, team-json, commit-only, enable-refactor, unpushed-check]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-02 NearOrgClient.listOrganizations and listWorkspaces and the fake NEAR server; 61-04 NEAR session"
provides:
  - src/team/nearLink.ts - linkChoices, linkNearOrganization, LinkResult, teamFileUnpushed, LINK_COMMIT_MESSAGE
  - src/team/enable.ts - commitTeamFileOnly, the shared team.json-only commit used by Enable and by linking
affects: [61-09, 61-10, 61-11, 61-12]

plan_head_before: afe5e2f11b8a3e1859de7d489f982f71aefee056
plan_head_after: accee056b6cbe6f755f2f905faedbe08d4855631
actuals:
  tokens: 9800
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "one commit helper for both Enable and link; its failure text is written to follow 'but ' so each caller prefixes its own sentence and Enable's message stays byte-identical"
    - "trust pin checked before the file is rewritten, so a team.json that names a different team or owner key is never overwritten"
    - "mutation checks on the compiled output to prove the new tests can fail"

key-files:
  created:
    - src/team/nearLink.ts
    - src/test/teamNearLink.test.ts
  modified:
    - src/team/enable.ts

key-decisions:
  - "commitTeamFileOnly takes the commit message and builds the manual command from it, so the same helper serves Enable and link; its failure message starts with 'committing ...' and callers add their own lead-in"
  - "linkNearOrganization checks the trust pin before writing team.json (not after), so a mismatching file is left as found"
  - "A damaged, missing or wrong-team team.json, invalid near ids, a secret in the file and a trust pin mismatch all map to code team-file with 'Nothing was changed.'; only a git commit failure is commit-failed and it leaves the written link on disk"
  - "teamFileUnpushed answers unknown when there is no upstream or git returns anything other than 0 or 1 for the diff, never a guess"

requirements-completed: []  # TEAM-02 is only partly delivered here; later plans finish join, confirm and removal, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "A lead links the team to a NEAR organization and workspace; near is written to team.json and exactly one commit is made whose only path is team.json, with unrelated staged work left staged and nothing pushed"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearLink.test.js#tracer: linking a team commits only team.json, leaves other staged work alone and keeps the trust pin"
        status: pass
    human_judgment: false
  - id: D2
    description: "linkChoices offers only organizations where the lead is owner or admin, each with its workspaces, and an empty list for a lead who administers none"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearLink.test.js#linkChoices lists only organizations ...; #linkChoices returns an empty list ..."
        status: pass
    human_judgment: false
  - id: D3
    description: "Enable uses the extracted commitTeamFileOnly with identical results and messages (teamEnable.test.ts unchanged and green)"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamEnable.test.js (all 17 existing tests, file unchanged)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Linking is idempotent (same values: unchanged, no commit), refuses a different existing link unless replace, refuses a damaged file, bad ids, a wrong team id and a trust pin mismatch without rewriting, and a failing commit hook leaves the link on disk with the exact manual command"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearLink.test.js (idempotent, different-link, damaged file and bad ids, pin mismatch, hook failure, wrong team id)"
        status: pass
    human_judgment: false
  - id: D5
    description: "teamFileUnpushed answers true while the committed team.json differs from the upstream, false after a push, unknown without an upstream"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearLink.test.js#teamFileUnpushed answers true until ..."
        status: pass
    human_judgment: false

duration: ~12min
completed: 2026-11-02
---

# Phase 61 Plan 08: NEAR organization link Summary

**A lead can pick an owner or admin NEAR organization and workspace, record it as `near` in team.json and commit only that file through the same helper Enable now shares, with idempotent re-links, a refused silent replace and an unpushed check so the invite command can warn.**

## Performance

- **Duration:** about 12 min of wall clock
- **Tasks:** 2 (one tracer, one auto), 4 commits
- **Files:** 2 created, 1 modified

## Accomplishments

- `commitTeamFileOnly(projectRoot, message, git)` extracted from `enableTeamMode` (the `add -f` / `commit --only` / reset-on-failure block). Enable calls it with `ENABLE_COMMIT_MESSAGE` and its results and messages are unchanged; `manualCommitCommand` now takes the message. The `'commit', '--only'` pair appears once in `enable.ts` and not at all in `nearLink.ts`.
- `linkChoices(org)` lists organizations, keeps role owner or admin, then lists each kept organization's workspaces.
- `linkNearOrganization` re-reads team.json, refuses a missing or damaged file and a team id mismatch, returns `unchanged` when the same near is set, returns `different-link` unless `replace`, checks the trust pin, writes through `writeTeamFile` (which runs `assertNoSecrets` and re-parses, so invalid ids and extra keys are refused), and commits with `LINK_COMMIT_MESSAGE`. On a commit failure it returns `commit-failed` with the manual command and leaves the written file in place.
- `teamFileUnpushed` resolves `@{u}` (failure: unknown) then `git diff --quiet @{u} HEAD -- team.json` (1: true, 0: false, anything else: unknown). Nothing in `nearLink.ts` pushes.

## Task Commits

1. **Task 1 (tracer): link and team.json-only commit** - RED `5378f17` (test), GREEN `8679aaa` (feat)
2. **Task 2: refusals, idempotency, unpushed check** - RED `873931c` (test), GREEN `accee05` (feat)

Tracer feedback gate (auto mode): the end-to-end verify command was re-run after the tracer GREEN and passed (27 tests across nearLink and Enable); logged as "Tracer verified end-to-end, expanding".

## Files Created/Modified

- `src/team/nearLink.ts` - link choices, link write and commit, unpushed check
- `src/team/enable.ts` - `commitTeamFileOnly` extracted and used by Enable
- `src/test/teamNearLink.test.ts` - 10 tests on real git and the fake NEAR server

## Decisions Made

See `key-decisions`. One for a reviewer: the pin is checked before the write, so a forged team.json that names a different genesis is never replaced by a "linked" file the lead's client then commits.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug, test only] Pin-mismatch test forged an invalid owner fingerprint**
- **Found during:** Task 2 GREEN
- **Issue:** the first version of the pin-mismatch test changed the owner fingerprint, which `writeTeamFile` refuses as an invalid device reference before the link code ran, so the test failed in setup.
- **Fix:** the test now forges a different but valid genesis event id, which the trust pin also covers.
- **Files modified:** `src/test/teamNearLink.test.ts`
- **Commit:** `accee05`

**Total deviations:** 1 test-side fix. **Impact:** none on scope or production behaviour.

## TDD Gate Compliance

- **Task 1 RED (`5378f17`):** the test file fails to compile because `nearLink.ts` does not exist. That is a build failure, not an assertion failure, so a strict classifier would call it INVALID_RED; it is unavoidable for a brand-new TypeScript module without a stub commit (same as plans 61-01 and 61-07). GREEN `8679aaa` followed.
- **Task 2 RED (`873931c`):** compile failure again, for the missing `teamFileUnpushed` export. Most of Task 2's refusal and no-op tests exercised behaviour already delivered in Task 1 (the plan's Task 1 action specifies the whole `linkNearOrganization`), so they passed on first run: expected GREEN-on-arrival, not a red-green pair. They are regression gates. Mutation checks on the compiled output prove they can fail: dropping the pin check, ignoring `replace`, removing the owner/admin filter, removing the `unchanged` branch and returning `false` for a differing team.json each fail at least one test.
- No REFACTOR commit was needed.

## Verification Results

- `npm run lint`: exit 0.
- `npx tsc -p tsconfig.json && node --test dist/test/teamNearLink.test.js dist/test/teamEnable.test.js dist/test/teamFile.test.js`: 52 pass, 0 fail.
- `node --test dist/test/team*.test.js dist/test/testIntegrity.test.js dist/test/security.test.js dist/test/privacy.test.js`: 532 pass, 0 fail (510 team tests at the end of 61-07 plus 10 new, plus the integrity, security and privacy files).
- Acceptance greps: `export async function commitTeamFileOnly` in `enable.ts`; `grep -c "'commit', '--only'" src/team/enable.ts` is 1; no `'--only'` and no `'push'` in `nearLink.ts`; `export async function teamFileUnpushed` in `nearLink.ts`.
- `teamEnable.test.ts` is unchanged (`git diff` shows no change to it).
- The full repository suite was not run: the change touches the Enable module and adds one new module, and the full suite belongs to the phase boundary.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-61-33 (commit --only with a single path, shared with Enable; staged unrelated file test) and T-61-34 (assertNoSecrets before write, extra keys refused, ids validated) are covered by tests. T-61-32 is accepted as planned.

## Open Items For Later Plans

- The commands plan should call `linkChoices` for the pick lists, `linkNearOrganization` for the write and commit, show `result.message` for `commit-failed`, offer Push through `pushCodeBranch` after a `linked` result, and call `teamFileUnpushed` before showing an invite bundle to warn that an invitee cloning now would not see the NEAR link.
- `linkNearOrganization` does not verify that the lead is owner or admin of the organization passed in `near`; `linkChoices` is the gate, and NEAR's own role checks apply to every later invite and key call.

## Self-Check: PASSED

- Files found: `src/team/nearLink.ts`, `src/test/teamNearLink.test.ts`, `src/team/enable.ts`
- Commits `5378f17`, `8679aaa`, `873931c`, `accee05`: present in history
