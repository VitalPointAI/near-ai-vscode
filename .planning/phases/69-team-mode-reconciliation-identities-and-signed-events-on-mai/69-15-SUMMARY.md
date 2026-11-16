---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 15
subsystem: team-mode
tags: [team-mode, pull-request, gate, rebase, release-content, secret-scan, e2e, review-budget]

requires:
  - phase: 69-08
    provides: PR 1 (#59), merged to main as squash 1cbcb9b
  - phase: 69-09
    provides: device.rotated and the PR 2 branch
  - phase: 69-14
    provides: the v0.6.0 disposition record with TMR-01 evidence
provides:
  - "PR 2 (see the PR section) open from feat/team-signed-payloads into main, rebased onto main, only its own 30 commits"
  - "Fresh TMR-01 evidence dated 2026-11-15 in .planning/research/v0.6.0-disposition.md"
  - "The full gate passed once on the rebased branch: lint and suite, e2e, verify:release, range secret scan, review budget"
  - "Five owner-requested fixes on top of the plan (verify report key status, remote address allowlist, preview gate in the Enable core, bounded reported sets, separator-proof canary scanners)"
affects: [70, 71, 80]

actuals:
  tokens: 21000
  tasks: 3
  commits: 2
plan_head_before: 08fd60d7306394d65b0cd2301977b6f7fd0ca8a9
plan_head_after: defdb0f61fddbf9d125996cdd9ca13c398f4ce82

tech-stack:
  added: []
  patterns:
    - "A gate that lives in the command layer is repeated in the core function that does the work (preview gate in enableTeamMode)"
    - "A remote address read from git config is checked against an allowlist of schemes once, where it is read"
    - "Sets of things the session already reported are bounded (last 500) with one plain note when the bound is hit"

key-files:
  created: []
  modified:
    - .planning/research/v0.6.0-disposition.md
    - .planning/REQUIREMENTS.md
    - .planning/ROADMAP.md
    - .planning/STATE.md

key-decisions:
  - "PR 2 was rebased with `git rebase --onto origin/main 4ae901f`, not the plan's PR2_BASE 6fd91a6: PR 1 was squash-merged, so main's tree equals PR 1's final head 4ae901f and that commit is the true fork point. PR2_BASE in 69-09-SUMMARY.md and the plan is superseded."
  - "The owner's five fixes were made as separate commits, each with a test that was checked red first, before the gate was run, so the gate covers them"
  - "The TMR-01 evidence commit comes before the gate so the range secret scan covers it"

requirements-completed: [TMR-01, TMR-02, TMR-03, TMR-04, TMR-05]
status: complete
---

# Phase 69 Plan 15: PR 2 rebased, gated and opened Summary

**PR 2 stands on main with only its own 30 commits, passes the full gate once (2,629 tests, 20 of 20 e2e, release content, range secret scan, 428,532 byte diff), carries fresh TMR-01 evidence and names its costly formats for the owner; nothing was merged, approved or pushed to main.**

## Task 1: PR 1 is on main, PR 2 rebased onto it (done before this part)

- PR 1 is #59, merged as squash `1cbcb9b` on `origin/main`. `git merge-base --is-ancestor 1cbcb9b origin/main` exits 0. The number equals the one in 69-08-SUMMARY.md. Main's tree equals PR 1's final head `4ae901f`.
- Rebase: `git rebase --onto origin/main 4ae901f` replayed PR 2's 24 commits. The old merge commit `7a9121b` (main merged into the branch) was dropped. A local tag `backup/team-signed-pre-rebase` marks the old head `6ce2622`; it was never pushed. Three commits had test-import conflicts only; they were resolved without reintroducing `emailHash`.
- The plan and 69-09-SUMMARY.md name `6fd91a6` as PR2_BASE. That value is superseded by `4ae901f` (PR 1's final head, equal to the tree of `1cbcb9b`).
- New PR 2 commits (24 plan commits): 69-09 `b0ad0ca` `ee9dd37` `afd7766` `50c32b6`; 69-10 `b2e8e8a` `94f0ff2` `532fad1` `8a2f5d8`; 69-11 `136f55b` `5576572` `b2740b0` `bd87db8`; 69-12 `a8b76ac` `0ff576d` `7656347` `575bb48`; 69-13 `baee6fd` `aa8808a` `88c2a9e` `6daec0d`; 69-14 `766047e` `7d5c72e` `bf77cb1` `b791e2c`.
- After the rebase: `npx tsc` clean, `dist/test/team*.test.js` 664 of 664 pass, diff against `origin/main` 428,448 bytes (budget 950,000), `package-lock.json` unchanged.

## Owner-requested fixes (made before the gate)

Each has a test whose red state was checked first.

| Commit | Subject | What it does |
| --- | --- | --- |
| `9b4ac33` | fix(team): Verify Team Log shows a rotated key as rotated, not active | `verifyAll` asks `teamKeyStatus` for each device; the `VerifyReport` device entry is now `{fingerprint, state, replacedBy?}`; the e2e suite was updated to match |
| `bf6190d` | fix(team): contact only file, ssh, git and http(s) remote addresses | `remoteUrl` accepts ssh, git, http, https, file, scp-like addresses and local paths, and refuses `<x>::` remote helpers and every other scheme, before any network call |
| `6213069` | fix(team): the preview gate holds in the Enable core, not only in the command | `enableTeamMode` refuses unless `previewEnabled: true` is passed |
| `47cc28a` | fix(team): bound the rejections and problems a session remembers it reported | `recentMap` keeps the last 500 reported rejections and issues and says so once in a plain note |
| `08fd60d` | test(team): the canary scanners see through separators and line wraps | the canary helper's scanners find key renderings split by separators or wraps; its limits are stated in the helper header |

## Task 2: fresh TMR-01 evidence, then the full gate once

TMR-01 evidence commit `defdb0f` (`docs(69): refresh the archive evidence for TMR-01`), run 2026-11-15, read-only, with the legacy worktree shown as `<legacy worktree>` (T-69-40, no local path written):

- `git fetch origin`, then `git ls-remote origin refs/heads/feat/team-fix-pass` printed `4207080ca394d36cf36bbed37b179d8f8400b721	refs/heads/feat/team-fix-pass`.
- `git rev-list --count 6f779f3..origin/feat/team-fix-pass` printed `777`.
- `git show --name-status --format='%h %s' 4207080` listed the same six paths as before.
- `git --no-optional-locks -C <legacy worktree> status --short` printed nothing; the worktree is at `4207080 [feat/team-fix-pass]`.
- `grep -c 4207080ca394d36cf36bbed37b179d8f8400b721` on the record is above 1; the section now says it was re-run on 2026-11-15, the day PR 2 opened.

Gate, in order, one heavy run at a time with `free -g` checked first, all on 2026-11-15, head `defdb0f`:

| Gate | Command (inside the cap) | Exit | Result |
| --- | --- | --- | --- |
| lint and full suite | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run lint && npm test'` | 0 | 2629 tests: 2620 passed, 0 failed, 0 cancelled, 9 skipped (the same nine as on main: two ripgrep tests, the LibreOffice deck test, the Open-GSD runtime test, five live NEAR AI tests without an API key), 70.7 s |
| e2e | `MemoryMax=6G`, `timeout 1800 env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u DISPLAY -u XDG_SESSION_TYPE -u GDK_BACKEND -u QT_QPA_PLATFORM -u ELECTRON_OZONE_PLATFORM_HINT NODE_OPTIONS=--max-old-space-size=1536 npm run test:e2e` | 0 | 20 of 20 passed, 0 failed (15 in the project scenario, 5 in the plain scenario) |
| release content | `MemoryMax=4G`, `timeout 900 npm run verify:release` | 0 | "Release content verified: 355 entries, 277 runtime JavaScript files, and 50 required release assets."; no "development or source artifacts" line |
| range secret scan | `MemoryMax=4G`, `timeout 900 node scripts/secret-scan.mjs --range origin/main..HEAD` | 0 | "Secret scan clean: 1091 tracked files and 30 commit(s) in origin/main..HEAD. Allowlisted fixtures: 8." |
| budget and dependency | `MemoryMax=4G`, `git diff --quiet origin/main...HEAD -- package-lock.json` and `git diff origin/main...HEAD \| wc -c` | 0 | `package-lock.json` unchanged; PR diff 428,532 bytes (limit 950,000); 47 files, 4,831 insertions, 92 deletions |

No infrastructure failure occurred; nothing was rerun.

### e2e pass lines for the Team Mode tests (this run)

```
✔ [project] Enable Team Mode is in the Command Palette only with the preview on (D-13, D-24, A3)
✔ [project] Enable Team Mode answers its prompts with their defaults and commits only team.json (D-30)
✔ [project] Verify Team Log reports the owner and no rejected events (D-30, D-31)
✔ [project] no rendering of the new device key or the owner email reaches settings, team.json or the remote (TMR-03)
✔ [plain] a folder without team.json starts no team session and creates no identity (D-14, D-30)
```

## Requirements, roadmap and state

- `.planning/REQUIREMENTS.md`: TMR-01 to TMR-05 checked and their traceability rows set to Complete, edited by hand (10 lines, nothing else). The `requirements.mark-complete` verb was not run, per the owner rules.
- `.planning/ROADMAP.md`: `roadmap update-plan-progress 69` only (diff limited to the Phase 69 plan list and progress line).
- `.planning/STATE.md`: edited by hand (Phase 69 plans 15 of 15, PR 2 open, next step is the owner's review and merge). `state.advance-plan` and `state.update-progress` were not run.

## Task 3: PR 2, CI and the agent review

The PR is opened right after this commit; its number, URL, checks and review record are added by the next commit.

## Deviations from Plan

### Auto-fixed Issues

None in this part. The five owner-requested fixes above are additions requested by the owner, not plan deviations.

### Other deviations

- The plan's rebase base `PR2_BASE` (`6fd91a6`) was replaced by `4ae901f`, because PR 1 was squash-merged and main's tree equals PR 1's final head.
- The plan's e2e verify line was replaced by the owner-rules e2e line (display and Wayland variables all stripped, xvfb only).
- The plan's commit trailer names Claude Opus 5.5; commits of this run carry the trailer the harness gave for the model that ran.
- Task 1 and the five fixes were done in a first part of the run; the commit count in `actuals` counts from the end of that part (`plan_head_before`), so it covers this part only. The whole branch has 30 commits above `origin/main`.

## Known Stubs

None. This plan adds no UI, data source or placeholder.

## Threat Flags

None beyond the plan's register. T-69-41 (doubled diff) is covered by the commit list and the 428,532 byte diff; T-69-42 by the clean range scan; T-69-43 by the PR body naming each costly format; T-69-48 by the merged check; T-69-SC by the unchanged lockfile. The remote address allowlist (`bf6190d`) narrows an existing tampering surface.

## Open for the owner

1. Review and merge PR 2 through the normal gates (this run did not and will not merge).
2. Say in the review if any of the costly formats named in the PR body should change; they are cheap to change until PR 2 merges and a release ships.
3. The CHANGELOG line for Team Mode and the Phase 70 work that uses the signer come after the merge.

## Self-Check: pending (filled in by the next commit)
