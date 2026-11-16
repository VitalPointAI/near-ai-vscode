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
  - "PR 2 (#61) open from feat/team-signed-payloads into main, rebased onto main, only its own commits (24 plan commits, five owner-requested fixes, the TMR-01 evidence commit, this plan's summary and the review fixes: 39 above main)"
  - "Fresh TMR-01 evidence dated 2026-11-15 in .planning/research/v0.6.0-disposition.md"
  - "The full gate passed once on the rebased branch: lint and suite, e2e, verify:release, range secret scan, review budget"
  - "Five owner-requested fixes on top of the plan (verify report key status, remote address allowlist, preview gate in the Enable core, bounded reported sets, separator-proof canary scanners)"
affects: [70, 71, 80]

actuals:
  tokens: 21000
  tasks: 3
  commits: 9
plan_head_before: 08fd60d7306394d65b0cd2301977b6f7fd0ca8a9
plan_head_after: 1610bac61fddbf9d125996cdd9ca13c398f4ce82

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

**PR 2 (#61) stands on main with only its own commits, passed the full gate (2,629 tests, 20 of 20 e2e, release content, range secret scan, 428,532 byte diff before review; 2,632 tests, 20 of 20 e2e and a 453,731 byte diff after four review rounds), carries fresh TMR-01 evidence and names its costly formats for the owner; nothing was merged, approved or pushed to main.**

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

After the agent review fixes (head `1610bac`) the gate was run again where the changes could matter: lint and `npm test` 2,632 tests, 2,623 passed, 0 failed, 0 cancelled, 9 skipped (exit 0); e2e 20 of 20 (exit 0); `npm run verify:release` exit 0 ("Release content verified: 355 entries, 277 runtime JavaScript files, and 50 required release assets."); range secret scan clean (1,092 tracked files, 38 commits); `package-lock.json` unchanged; PR diff 453,731 bytes; `gateFileChanges` empty.

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

- PR number and URL: #61, https://github.com/VitalPointAI/near-ai-vscode/pull/61, opened from `feat/team-signed-payloads` into `main` with the title `feat(team): one signer for policy bundles, grants and approvals, with key rotation and revocation (Phase 69, part 2)` and every template section filled. The body names the four costly formats with their decision ids (signed payload format v1 and its domain prefix D-08, D-20; the `device.rotated` body D-04, D-09; the key history format v1 and the identity secret names D-06, D-09; the D-21 limit that only revocation stops a copied key), says each is cheap to change until the merge and a release, asks the owner to say so in the review if one should change, lists the five owner-requested fixes and the rebase note, and gives the rollback. State `OPEN`, never merged, approved or auto-merged.
- GATE_PATHS (`scripts/lib/workflow.mjs`): `gateFileChanges` over the 47 files the PR changes against main returns an empty list. The PR touches no workflow, gate script, `SECURITY.md` or agent command, so nobody had to approve a gate.
- Required checks (branch protection: `lint, test, e2e, release-content, audit, secret-scan, agent-review, relay`): on the first head `3fffef6` and on the second head `6dc84f5`, lint, test (3 m 25 s and 3 m 3 s), e2e (3 m 54 s and 3 m 39 s), release-content, audit, secret-scan and relay all passed, and `agent-review` passed. The last head is recorded at the end of this section. No infrastructure rerun was needed.

### Agent review record

Round 1, head `3fffef6`: verdict PASS (merge), 1 MAJOR, 3 MINOR, 1 NIT.

| Finding | What was done |
| --- | --- |
| [MAJOR] `prepareDeviceRotation` did not repair key state first, so after a crash that wrote a `revoked` record but did not delete the key, `ensureCreatedRecord` archived the history and made the revoked key active again | Real defect. Fixed in `d6406a8`: `prepareDeviceRotation` calls `repairKeyState` first, so every path that can write a created record (first need, revoking, preparing) repairs first. The new test failed before the fix (checked red), and passes after: the revoked key is deleted, nothing is archived, no created record is written, and the key stays refused. |
| [MINOR] `signPayload` refuses a payload with a secret-like value, and key records carry base64url keys and hashes, so a detector rule could block identity creation nondeterministically | Not a defect in practice: `publicKey` and `sig` values are exempt by shape in the write guard, and hashes are hex. A 20,000-round check found 0 refusals, and a 3,000-round test now pins it (`6dc84f5`). |
| [MINOR] STATE.md session line still said 69-11 | Fixed in the final documentation commit. |
| [MINOR] this SUMMARY ended with a pending self-check and a PR placeholder | Fixed in the final documentation commit (this section). |
| [NIT] `checkRotations` reported an inconsistent `rotatedTo` as `deviceIndex` | Now reports `devices.rotatedTo`, and the tests assert the path (`6dc84f5`). |

Round 2, head `6dc84f5`: verdict PASS (merge), 0 MAJOR, 3 MINOR, 1 NIT.

| Finding | What was done |
| --- | --- |
| [MINOR] the signers allowed for a key record are chosen from the untrusted first read while the verified copy is what is applied, so an object that reads differently the second time could pick its own signer | Real, in-process only (not the file path). Fixed in `77d10e1` by an invariant instead of a case: the replay refuses a record whose verified copy differs from the first read. The new getter-object test failed before the fix (the replay accepted the attacker's key) and passes after. |
| [MINOR] a snapshot's `rotatedAt` accepted any short text and moves the `key-rotated` boundary | Fixed in `473f6e5`: it must match the same time pattern as event times. Test failed first. |
| [MINOR] STATE.md session line | Fixed in the final documentation commit. |
| [NIT] the restore after a failed head store is best-effort and says nothing if it fails | Left: the history then reads as changed from outside and archiving recovers it, which fails closed; a message-only change with no behaviour to test. Raise again if the owner wants it. |

After round 2 the local suite was rerun (lint, `npm test` 2,632 tests, 2,623 passed, 0 failed, 9 skipped).

Round 3, head `473f6e5`: verdict PASS (merge), 0 MAJOR, 3 MINOR, 1 NIT.

| Finding | What was done |
| --- | --- |
| [MINOR] the remote-helper guard matched only a name starting with a letter and did not trim the value (`1ext::` passes) | Fixed in `83acbf1` by widening the class, not the instance: any leading run of letters, digits, plus, dot and dash before two colons, on the trimmed address, is refused. Cases added and seen failing first. |
| [MINOR] `forgetCreatedDeviceIdentity` can now throw during an Enable rollback and hide the real failure | Not a defect: `rollback` in `src/team/enable.ts` already catches it and reports it as a problem next to the original failure (it never replaces it). No change. |
| [MINOR] `verifyPayload` canonicalises before the size limit | Intended (one read of the input, so the checks and the caller see the same bytes). Callers already cap what they read (the key history caps its file). The comment now says so (`4b36bb3`). |
| [NIT] the 3,000-round secret-guard test used fresh randomness | Now a fixed seed (`4b36bb3`). |

Round 4, head `4b36bb3`: verdict PASS (merge), 0 MAJOR, 4 MINOR, 1 NIT. All five were small and were handled in `1610bac`:

| Finding | What was done |
| --- | --- |
| [MINOR] a project `url.<base>.insteadOf` rewrite could still turn an allowed address into a helper | A limit, stated in the code comment: the address is checked as the project's git config states it, and `insteadOf` lives in that same project-owner config. |
| [MINOR] the leading-dash refusal tested the untrimmed value (`" -oProxyCommand=x"` passed) | The address is trimmed once at the top and every check uses the trimmed value (control characters are still checked on the original). Cases added. |
| [MINOR] the key chain hashed the untrusted object, not the canonical copy | `replay` reads each record once as canonical JSON and uses that one copy for the checks, the signature, the chain hash and the head. |
| [MINOR] STATE.md session line still said 69-11 | Fixed in the documentation commit that follows. |
| [NIT] `readStoredKeySafely` used one label for all three keys | Each stored key is read under its own name. |

Local runs after the review fixes (head `1610bac`): lint and `npm test` 2,632 tests, 2,623 passed, 0 failed, 0 cancelled, 9 skipped; e2e 20 of 20, exit 0.

The review is not deterministic across heads and returns new minor findings on each push; the rounds above are recorded as found. Every round returned PASS with no blocker, and the one MAJOR (round 1) was a real defect fixed with a test. Later rounds on documentation-only heads are left in the PR conversation.


## Deviations from Plan

### Auto-fixed Issues

The five owner-requested fixes above are additions requested by the owner, not plan deviations. Found by the agent review of PR 2 and fixed with a test seen failing first:

**1. [Rule 1 - Bug] Preparing a key rotation after a crashed revocation made the revoked key active again**
- **Found during:** Task 3, agent review round 1 (MAJOR)
- **Fix:** `prepareDeviceRotation` repairs key state first, like first need and revoking. **Commit:** `d6406a8`.

**2. [Rule 1 - Bug] A key record could choose its own signer by reading differently on a second look**
- **Found during:** Task 3, agent review round 2
- **Fix:** the replay refuses a record whose verified copy differs from the first read (`77d10e1`), then reads each record once as canonical JSON for every later use (`1610bac`).

**3. [Rule 1 - Bug] A snapshot's `rotatedAt` accepted any text** (`473f6e5`); **the remote-helper guard missed a leading digit and untrimmed values** (`83acbf1`, `1610bac`); **a stored pending or previous key was read under the wrong name** (`1610bac`).

Review findings that were not changed, with the reason, are in the review record above.

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

## Self-Check: PASSED

- Commits `defdb0f`, `3fffef6`, `d6406a8`, `6dc84f5`, `77d10e1`, `473f6e5`, `83acbf1`, `4b36bb3` and `1610bac` are ancestors of HEAD and on `origin/feat/team-signed-payloads`.
- `.planning/research/v0.6.0-disposition.md` exists and carries `4207080ca394d36cf36bbed37b179d8f8400b721` and today's date in `## TMR-01: the archive`.
- PR #61 is `OPEN`, base `main`; every required check passed on each pushed head; nothing was merged, approved or pushed to main.
