---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 20
subsystem: online-home-github
tags: [gap-closure, G-27-6a, default-branch, github-api, online-home]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-17 online-home flow, githubApi.ts client, pushProjectCode (codePushCheck.ts), StateTransport and STATE_REF"
provides:
  - "src/services/githubApi.ts: GitHubRepo.defaultBranch (from default_branch, safe names only), isSafeBranchName, setDefaultBranch (PATCH /repos/{owner}/{name})"
  - "src/services/onlineHome.ts: moveDefaultBranch, remoteDefaultBranch, defaultBranchAfterPush (all exported, reused by plan 27-23), called only after a pushed code result"
affects: [27-21, 27-23, release-notes]

requirements-completed: [SYNC-09, SYNC-05]

actuals:
  tokens: 7062
  tasks: 2
  commits: 3
plan_head_before: 29d566d63325a87ba6b4b86f98bc624060b50912
plan_head_after: 6164812565254349574aa15453b1986546f41f6a

tech-stack:
  added: []
  patterns:
    - "A move that can only go one way is built so no parameter widens it: moveDefaultBranch compares against the state branch name derived from STATE_REF and has no 'from' argument, so a default the person chose can never be changed"
    - "Absence of a capability is stated as a plain sentence naming the one setting to change (pasted address, no API), never a silent skip"

key-files:
  created: []
  modified:
    - src/services/githubApi.ts
    - src/services/onlineHome.ts
    - src/test/onlineHome.test.ts
    - .planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/COVERAGE.md

key-decisions:
  - "Owner decision 2026-11-13 (no extra branch) followed exactly: the sync step is unchanged and pushes only refs/heads/near-ai/state; after the person's own code push returns pushed, the GitHub routes read the default branch and PATCH only when it is near-ai/state"
  - "The state branch name is derived from STATE_REF (strip refs/heads/), never retyped; moveDefaultBranch has no parameter naming the branch to move away from"
  - "The default-branch failure sentence is its own (names the branch and the setting) and does not reuse GITHUB_MESSAGES, whose permission sentence speaks of creating a repository"
  - "Pasted-address route: no API request at all; the remote's default is read with git ls-remote --symref and an unreadable answer counts as cannot tell, so the settings sentence is told"

patterns-established:
  - "Fixture for GitHub-side behaviour on a local bare remote: the test points the bare remote's HEAD at a branch with symbolic-ref to stand in for GitHub's default branch"

coverage:
  - id: D1
    description: "On the VS Code route, after the person's code push returns pushed with the default near-ai/state, exactly one PATCH to /repos/me/<name> with body {default_branch:<pushed branch>} and the token in Authorization only is sent, after the git push of the person's branch; the fake default becomes the pushed branch, the bare remote holds only near-ai/state and that branch, and one sentence says it is now the default"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#tracer: once the code is pushed on the VS Code route, the default branch moves from near-ai/state to the pushed branch with one PATCH"
        status: pass
    human_judgment: false
  - id: D2
    description: "getRepo carries defaultBranch only for safe branch names and never fails the parse; setDefaultBranch sends one PATCH and refuses an unsafe owner, name or branch before any request; moveDefaultBranch moves only a default of near-ai/state"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#GitHub answers carry the default branch only when it is a safe branch name, and setDefaultBranch sends one PATCH and checks everything before any request"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#moveDefaultBranch moves only a default of near-ai/state"
        status: pass
    human_judgment: false
  - id: D3
    description: "No PATCH and no default-branch sentence when the code offer is declined, the summary is declined, a .env blocks the push, the online repository refuses the push, or there is nothing to push; the default stays near-ai/state and the remote holds only near-ai/state"
    requirement: SYNC-05
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a declined code offer sends no PATCH and leaves the default as it was"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a declined summary sends no PATCH and leaves the default as it was"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a planted .env blocks the code push, and with it any PATCH"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a push the online repository refuses sends no PATCH and leaves the sync branch there"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#nothing to push sends no PATCH and leaves the default as it was"
        status: pass
    human_judgment: false
  - id: D4
    description: "A default the person chose (develop), or one already equal to the pushed branch, is read and never changed and nothing extra is told; the gh route makes the same move with the gh token only in the Authorization header"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a default the person chose is read and never changed, and one that is already the pushed branch is left alone too"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#on the gh route the same move happens, with the gh token only in the Authorization header"
        status: pass
    human_judgment: false
  - id: D5
    description: "Pasted-address route: no GitHub request at all; after a pushed result the settings sentence naming the pushed branch is told when the remote's default (git ls-remote --symref) is near-ai/state or cannot be read, and nothing when another branch is shown first; remoteDefaultBranch returns undefined for anything unreadable or unsafe"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a pasted address sends no GitHub request, and names the setting to change when the remote still shows near-ai/state first"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a pasted address whose remote already shows another branch first gets no settings sentence"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#remoteDefaultBranch reads the symbolic HEAD with git alone, and anything it cannot read means \"cannot tell\""
        status: pass
    human_judgment: false
  - id: D6
    description: "A PATCH answered 403 or 422, or a fetch that rejects, is told in one plain sentence naming the branch; the setup still ends done and the pushed code and sync branch are unchanged"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a default-branch change GitHub refuses or cannot reach is told in one plain sentence, the setup still ends done, and the pushed code is left as it is"
        status: pass
    human_judgment: false
  - id: D7
    description: "The token reaches GitHub only in Authorization headers: the extended hygiene test (both routes, code pushed, PATCH sent) finds it in no URL, request body, git argument, file, progress record, message or console line"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#the token never appears in a git argument, a file, the progress record, a message or the console, and git gets it only through its environment"
        status: pass
    human_judgment: false
  - id: D8
    description: "COVERAGE.md lists the default-branch PATCH as an INTEGRATE row, keeps the near-ai/state-only sync row, and the api-coverage check passes"
    requirement: SYNC-09
    verification:
      - kind: other
        ref: "gsd-tools check api-coverage.verify-pre: passed true (11 capabilities, 4 opt-out)"
        status: pass
    human_judgment: false

duration: 25 min
completed: 2026-11-13
---

# Phase 27 Plan 20: Default branch after the code push Summary

**Once the person's own code is pushed on a GitHub route, the repository's default branch moves from near-ai/state to the pushed branch with one PATCH (only ever away from near-ai/state); a pasted address gets one sentence naming the setting to change; sync still pushes nothing but refs/heads/near-ai/state.**

## Accomplishments

- `githubApi.ts`: `GitHubRepo.defaultBranch` is read from `default_branch` only when `isSafeBranchName` accepts it (an unsafe or missing value never fails the parse, so create and resume are unchanged); `setDefaultBranch` validates owner, name and branch before any request and sends one PATCH; `call()` accepts PATCH.
- `onlineHome.ts`: `moveDefaultBranch` (reads with `getRepo`, PATCHes only when the default is the state branch, which is derived from `STATE_REF`), `remoteDefaultBranch` (`ls-remote --symref`, no API), `defaultBranchAfterPush` (branch read with the runner the push used; token route moves the default, tokenless route tells the setting). `onlineHomeFlow` calls it only when `pushProjectCode` returns `pushed`, with the same authenticated runner, and tells its sentence after the push message.
- Tests: 14 new tests plus the token hygiene test extended to a run that sends the PATCH. Every new code-push test asserts the bare remote holds only `refs/heads/near-ai/state` (and the person's branch when pushed) and that no push carries `--force`, `--force-with-lease`, `-f`, `--mirror`, `--delete` or a `+`/`:` refspec.
- `COVERAGE.md`: INTEGRATE row for the default-branch PATCH; opt-out row narrowed to "deletion and other settings changes".

## TDD

- Task 1 was a tracer (production quality, one commit). The implementation was written before the tracer test file was run; the tests were then added and pass (17/17). No separate RED was captured for the tracer.
- Task 2 RED: `af98045` `test(27-20)`: the pasted-address test failed on the planned assertion (the flow told no settings sentence: messages were only "GitHub sign-in is not available in this editor." and "Your code is on origin (master)."). The other 26 tests in the file passed, as expected: most are guards for behaviour Task 1 already gave (nothing but a pushed result moves the default). The default spec reporter was used, so `check tdd-red-evidence` (TAP) was not run; evidence is the captured console report. Semantic assessment: the failing test executed and failed for the intended reason, not a build or fixture fault.
- Task 2 GREEN: `6164812` `feat(27-20)`: 47/47 pass across onlineHome and codePushCheck. No refactor commit.

## Task Commits

1. Task 1 (tracer): `4bf8cb6`
2. Task 2 RED: `af98045`; GREEN: `6164812`

Tracer gate: the tracer `<verify>` (tsc plus `onlineHome.test.js`) was re-run green before expanding.

## Verification

- `tsc -p tsconfig.json && node --test dist/test/onlineHome.test.js dist/test/codePushCheck.test.js` under the memory cap: 47 tests, 47 pass, 0 fail.
- `npm run lint` exit 0; `node scripts/secret-scan.mjs --range 29d566d..HEAD` clean.
- api-coverage check: passed true. `grep -rl 'near-ai/home' src | wc -l`: 0.
- `grep -c default_branch src/services/githubApi.ts`: 2; `grep -c setDefaultBranch src/services/onlineHome.ts`: 2; `grep -c defaultBranchAfterPush src/services/onlineHome.ts`: 2 (definition and the call); `grep -c symref src/services/onlineHome.ts`: 2.

## Deviations from Plan

None needing a rule. Small notes:

- `isSafeBranchName` also rejects `//` and a trailing `.` in addition to the plan's rule (both are names git itself refuses; stricter only).
- The `remoteDefaultBranch` parsing test was added in the GREEN commit, not RED, because the function did not exist yet and the RED commit had to compile.
- In the gh-route tests the fake GitHub is told the repository exists (gh creates it itself in production, so the later GET finds it).

## Known Stubs

None.

## Threat Flags

None. T-27-95 (refs): every new test asserts the remote's ref list and the push arguments. T-27-96: `moveDefaultBranch` has no parameter that widens which default may move; owner, name and branch are validated before any request. T-27-97: token only in the Authorization header, hygiene test extended to a PATCH run.

## Self-Check: PASSED

- FOUND: src/services/githubApi.ts, src/services/onlineHome.ts, src/test/onlineHome.test.ts, .planning/phases/27-project-state-follows-the-project-across-interfaces-and-machines/COVERAGE.md
- FOUND commits: 4bf8cb6, af98045, 6164812
