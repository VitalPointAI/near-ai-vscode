---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 14
subsystem: team-mode
tags: [team-mode, disposition, archive, planning-record, v0.6.0]

requires:
  - phase: 69-01
    provides: the first TMR-01 evidence (archive sha, commit count, six paths)
  - phase: 69-13
    provides: the effect of a local key rotation on team membership
provides:
  - ".planning/research/v0.6.0-disposition.md: TMR-01 archive evidence, a disposition for each of the nine v0.6.0 phases and 34 requirements, the archive paths L2 needs, D-28 and the hand-offs from plans 04, 09, 10 and 13"
  - "src/test/teamDisposition.test.ts: 14 tests that pin the record's structure, the four landed ids and the no-local-path rule"
affects: [69-15, L2]

pr2_base: 6fd91a6a7be56d52ba9a9cb07297e511d744874a

actuals:
  tokens: 8600
  tasks: 2
  commits: 2
plan_head_before: 87a55ed85daf9841ee01f79fa416f15dcc162b54
plan_head_after: 235bd0b332a04b1f8211be4837b95415e08b9e2c

tech-stack:
  added: []
  patterns:
    - "A planning record is checked like code: a node:test reads the markdown, parses its tables and fails on an empty cell, a missing or extra row, or a row out of the archive's order"
    - "Expected id lists are hard-coded in the test because CI does not fetch the archive branch"

key-files:
  created:
    - .planning/research/v0.6.0-disposition.md
    - src/test/teamDisposition.test.ts
  modified:
    - .planning/REQUIREMENTS.md
    - .planning/ROADMAP.md

key-decisions:
  - "Phase 67 is recorded as 'Carried to L2' with the retirement of relayTransport.ts in its reason, because a phase row takes one of four disposition prefixes and most of Phase 67 is carried"
  - "The record carries no local path: the legacy worktree is named only as on the owner's machine, the commands show <legacy worktree>, and the test fails on any line matching the path pattern (T-69-40)"
  - "The addendum spec stays on the archive and is cited by path and sha (research open question 3)"
status: complete
---

# Phase 69 Plan 14: v0.6.0 disposition record Summary

**What remains of v0.6.0 now has a recorded place in the new plan: `.planning/research/v0.6.0-disposition.md` carries fresh archive evidence (TMR-01), one row for each of the nine phases and 34 requirements (TMR-04), the `TM-` prefixes and a same-id column, and a 14-test structure check pins it. REQUIREMENTS.md and ROADMAP.md link to it.**

## Task 1: tracer, the record with its archive evidence and the phase table

Commit `acb05b2`.

- The read-only TMR-01 commands were re-run: `git ls-remote origin refs/heads/feat/team-fix-pass` printed `4207080ca394d36cf36bbed37b179d8f8400b721`, `git rev-list --count 6f779f3..origin/feat/team-fix-pass` printed 777, `git show --name-status 4207080` listed the same six paths (the sixth, the Phase 62.1 `.gitkeep`, is why the archive's roadmap said five), and the legacy worktree's `git --no-optional-locks status --short` printed nothing. Nothing on the archive was changed, and the checks only read, so they can be repeated, run twice at once or resumed after an interruption.
- The record names the legacy worktree only as "the legacy worktree on the owner's machine (path kept out of the repository)" and shows `<legacy worktree>` in the command.
- The `## Phases` table has nine rows in roadmap order (60, 61, 62, 62.1, 63 to 67); Phase 60 is the only one landed.
- The test parses the table under a given H2 and checks the rows, the dispositions, the reasons, the full sha in the TMR-01 section, the path-free and em-dash-free text and both link lines. The links: the REQUIREMENTS.md "Carried from v0.6.0" line (now at line 481, not 442) ends with "Record: `.planning/research/v0.6.0-disposition.md`." and the ROADMAP.md L2 section has one line after its table.
- Tracer gate: the Task 1 verify (compile, then `node --test dist/test/teamDisposition.test.js`) passed 6 of 6 before Task 2 began.

## Task 2: all 34 requirements, the archive paths and the D-28 note

Commit `235bd0b`.

- The eight new cases were written first and failed (6 failing, 8 passing) before the tables existed. `V060_REQUIREMENTS` holds the 34 ids in the archive's order.
- `## Requirements` has six columns (archive id, meaning, id from now on, disposition, same id elsewhere, reason). `TM-` goes on TEAM-01..04 and SETUP-01 only. The same-id column names the v0.4.0 archive for SEC-01..03 and UX-01, BUDG for BUDGET-01..05, and the v0.7.0 TEAM and SETUP ids.
- Exactly TM-TEAM-01, TM-TEAM-04, SEC-01 and SEC-04 are landed, each naming Phase 69 test files that the test checks exist (teamEnable, teamCommands, teamSoloParity; teamForgery, teamMaterialize; teamPermissions). The record says the archive header's 33 is wrong and the list has 34.
- `## What L2 finds on the archive` lists the Phase 60, 61, 62 and 62.1 folders and the addendum spec at 4207080, and carries plan 04's hand-off (Phase 65's `integrationBranch` must refuse the sync branch by reusing `collidesWithSyncRef`).
- `## Consequences and notes` states D-28 in plain words (one fingerprint per person in every team's signed log, readable by anyone who can read the project's remote; one install can be one identity for several people on a shared code-server, owned by SHRD-02 and SHRD-03), PROJECT.md decision 10 (the device key becomes a `did:key`, there is no `did:near`), plan 13's rotation effect on one line (`device.rotated`, read-only, and the owner-only team left with no signer if the previous key is revoked first), and the plan 09 and 10 hand-off (`TeamLog.verifyAll` shows only `{ fingerprint, revoked }`, so a rotated key looks active there; read `teamKeyStatus`).

## Verification

| Command | Result |
|---------|--------|
| `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/teamDisposition.test.js'` (Task 1) | 6 tests, 6 pass, 0 fail, 0 cancelled |
| the same command (red step of Task 2) | 14 tests, 8 pass, 6 fail |
| the same command (Task 2, final) | 14 tests, 14 pass, 0 fail, 0 cancelled |

Acceptance greps on the record: `grep -c "4207080ca394d36cf36bbed37b179d8f8400b721"` 3 lines; `grep -c "TM-TEAM-0[1-4]\|TM-SETUP-01"` 6; `grep -ci code-server` 2; `grep -c "SHRD-0[23]"` 1; the `device.rotated` line containing "read-only" 1; `grep -c "—"` 0; `grep -nE '/(home|Users|mnt|tmp)/|[A-Za-z]:[\\]'` prints nothing. `package.json` and the lockfile are unchanged (T-69-SC).

## Deviations from Plan

### Auto-fixed Issues

None - plan executed as written, with two notes.

1. The plan says the "Carried from v0.6.0" line is at `.planning/REQUIREMENTS.md` line 442; it is now line 481. The link was appended to that line by content, not by number.
2. The plan asks for the research's Pitfall 6 sentence in the record and in the Enable confirmation. The Enable flow has no such sentence (no confirmation dialog in `src/services/team/teamCommands.ts` or `src/team/enable.ts` mentions the shared fingerprint), and this plan's files do not include product code, so the record says "No sentence in the Enable flow says this yet, so L2 should add one plain sentence to the confirmation." Nothing was added to product code.

## Known Stubs

None.

## Threat Flags

None. The record is a planning file; it holds no secret, no email and no local path.

## Hand-offs

1. L2 should add one plain sentence about the shared fingerprint to the Enable confirmation (see deviation note 2).
2. Plan 15 (the PR 2 gate) can rely on `teamDisposition.test.js` running with the team suite; it reads only repo files and needs no archive branch.

## Self-Check: PASSED

- Files found: `.planning/research/v0.6.0-disposition.md`, `src/test/teamDisposition.test.ts`, this SUMMARY.
- Commits found as ancestors of HEAD: `acb05b2`, `235bd0b`.
