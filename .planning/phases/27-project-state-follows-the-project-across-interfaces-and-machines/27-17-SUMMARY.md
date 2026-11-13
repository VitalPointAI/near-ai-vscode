---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 17
subsystem: state-sync
tags: [github, online-home, gh-cli, secret-check, token-hygiene, resume, vscode-authentication]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-03 state home (ensure, paths.sync, writeFileAtomic); 27-11 StateTransport, runStateGit and its injectable GitRunner seam, validateRemote, classifyGitFailure, redactGitMessage"
provides:
  - "src/domain/state/onlineHome.ts: Visibility, VISIBILITY_NOTES, repoNameFromFolder, validateRepoName, validateLogin, expectedCloneUrl, OnlineHomeStep/Method/Repo/Progress, nextOnlineHomeStep, classifyGitHubError, GITHUB_MESSAGES"
  - "src/services/githubApi.ts: FetchLike, GitHubApiError, createUserRepo, getRepo, currentLogin (fetch injected, api.github.com only)"
  - "src/services/onlineHome.ts: onlineHomeFlow, OnlineHomeUi, CodePushOffer, GitHubAuth, GhCli, GhExec, systemGhCli, withGitHubAuth, readProgress, writeProgress, OnlineHomeRemote"
  - "src/services/codePushCheck.ts: isSecretFileName, planCodePush, pushProjectCode, runPersonGit, CodePushUi/Plan/Summary/Result"
  - "src/services/onlineHomeVscode.ts: vscodeGitHubAuth, vscodeOnlineHomeUi, offerOnlineHomeAtStart"
affects: [27-15, 27-18, online-home, turn-on-flow, sync-control]

actuals:
  tokens: 25700
  tasks: 3
  commits: 5
plan_head_before: 172f51d860b92f9e1359b244a18070c3517bbd99
plan_head_after: a97800e90220a0d66b6884ac5518bcf2355d1ca6

tech-stack:
  added: []
  patterns:
    - "A flow with no vscode import takes every outside thing as an injected seam (ui, auth, gh, fetch, git runner, afterRemote, onStep), so the whole setup is tested on plain node with fakes and local bare repositories reached through url.<path>.insteadOf"
    - "The GitHub token lives in one local variable of the flow: GitHub API Authorization header, or a runner wrapper (withGitHubAuth) that adds GIT_CONFIG_COUNT/KEY_0/VALUE_0 to the child environment for https://github.com/ only; arguments are never changed"
    - "Saved progress is four fields (step, method, repo, startedAt); step is the last one finished, the file is re-validated strictly on read (a cloned project's file is not trusted), and resume asks GitHub with getRepo before it would ever create"
    - "Each irreversible step sits behind its own click: modal start, public or private (no default), the file list, the ignore click, the identity; the code push is a second question after sync"

key-files:
  created:
    - src/domain/state/onlineHome.ts
    - src/services/githubApi.ts
    - src/services/onlineHome.ts
    - src/services/codePushCheck.ts
    - src/services/onlineHomeVscode.ts
    - src/test/onlineHome.test.ts
    - src/test/codePushCheck.test.ts
  modified: []

key-decisions:
  - "The flow takes the plan-15 turn-on flow as afterRemote({ name, url, git }) where git is the runner already wrapped with the person's token, so the StateTransport built there can push with no credential helper; false from it means 'sync-incomplete' and the code push is not offered"
  - "Progress records the last finished step: init, signin, visibility, create (repository saved), remote, sync, offer-code, done. nextOnlineHomeStep skips creation when the saved repository still exists, re-adds the remote when it is missing, and does not run the turn-on flow twice once 'sync' was saved"
  - "A folder inside another git repository is refused with one sentence instead of getting a nested git init; the remote is named origin, or near-ai-home when origin is taken, and a saved repository is recognised by the address in the project's raw git settings"
  - "A pasted address is refused for helper transports (validateRemote), for a password or token inside it, and when ls-remote lists any refs; it is stored as method 'url' with visibility 'unknown'"
  - "The person's own code push uses a separate plain git runner (runPersonGit: their config and hooks apply) rather than runStateGit, because runStateGit forces hooks and signing off; both are wrapped with the same token wrapper"
  - "A blocked file git already tracks is never offered for .gitignore (it would not help); the message tells the person to remove it from git themselves. Untracked blocked files are added only after their click"

patterns-established:
  - "Test fakes for GitHub keep repositories in memory and answer 201, 422 with 'name already exists', 404 and 403; the gh fake and the real systemGhCli (with an injected exec) are both tested, so no real gh or account is touched"
  - "The token hygiene test scans every git argument, every file under the project and the mirror (binary too), every ui message and the console for the token and for its base64 header value, and also asserts the header is present in the child environment so the check is not vacuous; two mutations (token in a message, token in an argument) made it fail"

requirements-completed: [SYNC-09]

coverage:
  - id: D1
    description: "A folder with no repository gets a GitHub home on the person's clicks only: git init, sign-in, public or private asked every time with both notes and nothing preselected, one create request with the exact body, remote added, the turn-on flow called once with a token-bearing runner, and the sync branch reaches the (local stand-in) repository; declining or walking away writes and requests nothing"
    requirement: SYNC-09
    verification:
      - kind: integration
        ref: "dist/test/onlineHome.test.js#tracer: a folder with no repository gets a private GitHub home and the sync branch, all on the person's clicks"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#declining the start prompt writes nothing: no repository, no state home, no request"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#visibility is asked every time with no default: walking away creates nothing"
        status: pass
    human_judgment: false
  - id: D2
    description: "Without VS Code's GitHub sign-in the flow says so in one sentence, then creates the repository through gh (repo create <name> --private|--public, never a source or push, token from gh auth token) or takes a pasted empty repository; helper transports, embedded passwords and non-empty repositories are refused; the token is never asked for"
    requirement: SYNC-09
    verification:
      - kind: integration
        ref: "dist/test/onlineHome.test.js#without VS Code sign-in the flow says so and creates the repository through gh, never with a source or push"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#when gh is missing or signed out, the flow offers pasting the address of an empty repository and never asks for a token"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#a pasted address with a helper transport or a password in it is refused, and one that is not empty is refused, until an empty one is given"
        status: pass
      - kind: unit
        ref: "dist/test/onlineHome.test.js#gh is run with array arguments and prompts off, never with a source or push, and its token is read from gh auth token into memory"
        status: pass
    human_judgment: false
  - id: D3
    description: "A taken name, an offline machine, a refused permission (API 403 or a closed sign-in) and an invalid name each give one plain sentence, an invalid name never reaches the network, and a setup stopped after init or after create resumes at the next step without a second repository (getRepo finds it); a saved repository that GitHub no longer has starts again at sign-in; a tampered progress file is not trusted"
    requirement: SYNC-09
    verification:
      - kind: integration
        ref: "dist/test/onlineHome.test.js#GitHub answers become one plain sentence each: a taken name asks for another, offline and refused permission stop, an invalid name never leaves the computer"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#an interrupted setup resumes: after create the repository is found, not created again; after git init it carries on at sign-in"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#a saved repository that GitHub no longer has starts again at sign-in, and a tampered progress file is not trusted"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#a folder inside another repository is not given a repository of its own, and a remote already named origin is left alone"
        status: pass
    human_judgment: false
  - id: D4
    description: "The GitHub token appears in no git argument, no file under the project or the mirror, no progress record, no ui message and no console output, on both the VS Code and the gh route, and git receives it only as GIT_CONFIG_COUNT/KEY_0/VALUE_0 scoped to https://github.com/"
    requirement: SYNC-09
    verification:
      - kind: integration
        ref: "dist/test/onlineHome.test.js#the token never appears in a git argument, a file, the progress record, a message or the console, and git gets it only through its environment"
        status: pass
    human_judgment: false
  - id: D5
    description: "Pushing the person's own code is a separate question after the sync step; it lists exactly the files git would add (never the state folder), blocks secret file names (ported repo rules, kept in step by a test) and content (scanSecrets and SECRET_TOKENS) with reasons that carry no value, only an ignore click changes anything, the visibility line is shown for public, identity is the person's or one they accept for this project, a declined summary changes nothing, a refused push is one plain sentence, and no force option exists"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "dist/test/codePushCheck.test.js#isSecretFileName follows the repository's own rules, and stays in step with scripts/lib/workflow.mjs"
        status: pass
      - kind: integration
        ref: "dist/test/codePushCheck.test.js#planCodePush lists exactly the files git would add and blocks likely secrets by name and by content, without showing a value"
        status: pass
      - kind: integration
        ref: "dist/test/codePushCheck.test.js#pushProjectCode refuses while files are blocked, and only an ignore click changes anything"
        status: pass
      - kind: integration
        ref: "dist/test/codePushCheck.test.js#after the person ignores the blocked files, the rest is committed with their identity and pushed to the current branch, never forced"
        status: pass
      - kind: integration
        ref: "dist/test/codePushCheck.test.js#a public repository gets the extra line in the summary, and declining the summary leaves the sync branch and the repository untouched"
        status: pass
      - kind: integration
        ref: "dist/test/codePushCheck.test.js#a person with no git identity is asked once; accepting sets it for this project only, declining stops before any commit"
        status: pass
      - kind: integration
        ref: "dist/test/codePushCheck.test.js#a blocked file that is already tracked is not offered for ignoring, and the push stays blocked with a plain sentence"
        status: pass
      - kind: integration
        ref: "dist/test/codePushCheck.test.js#a push the online repository refuses is reported in one plain sentence and is never forced"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#the code push is a separate question asked only after the sync branch step, and declining it leaves sync as it was"
        status: pass
      - kind: integration
        ref: "dist/test/onlineHome.test.js#accepting the offer pushes the code through the signed-in runner with the repository's visibility in the summary"
        status: pass
    human_judgment: false
  - id: D6
    description: "The VS Code adapters: one getSession('github', ['repo']) call site (a missing provider means not available), a modal start, a QuickPick for public or private with nothing active, input boxes (never a token), a progress notification, and the one-time offer for a NEAR AI project with no repository or remote, with 'Not now' remembered per workspace"
    requirement: SYNC-09
    verification:
      - kind: command
        ref: "npm run lint (tsc --noEmit) clean; grep -c \"getSession('github', \\['repo'\\]\" src/services/onlineHomeVscode.ts prints 1"
        status: pass
    human_judgment: true
    rationale: "The adapters need a running editor; plain-node tests cannot show how the QuickPick looks with no active item, how the progress notification behaves around modal questions, or that code-server really lacks the GitHub provider (taken from D-14, not checked in code-server). A person should click through it once in desktop VS Code and once in code-server."

duration: 11min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 17: One-Click Online Home Summary

**"Give this project an online home": on the person's clicks, git init, VS Code GitHub sign-in (or gh, or a pasted empty repository), public-or-private chosen every time with plain notes, repository created and added as the remote, the turn-on flow handed a token-bearing git runner, and a separate, secret-checked offer to push their own code, with the GitHub token held only in memory and every failure one plain sentence.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-11-13T15:00:18Z
- **Completed:** 2026-11-13T15:11:51Z
- **Tasks:** 3 (one tracer, two TDD)
- **Files modified:** 7 created, 0 modified

## Accomplishments

- `onlineHomeFlow` runs the whole setup with no vscode import: a modal start, `home.ensure()`, git init (only for a folder that is not a repository of its own), sign-in, the public/private question with `VISIBILITY_NOTES` and no default, a name check before any request, `createUserRepo`, `git remote add`, progress saved after each step, then `afterRemote({ name, url, git })` for plan 15's turn-on flow. Declining writes and requests nothing.
- Three routes in: VS Code's GitHub session, the gh CLI (`gh repo create <name> --private|--public` only, token from `gh auth token`), or a pasted address that must pass `validateRemote`, carry no password or token, and list no refs on `ls-remote`.
- `withGitHubAuth(runner, token)` is the only way the token reaches git: three `GIT_CONFIG_*` environment entries scoped to `https://github.com/`. The hygiene test scans arguments, every file (binary included) under the project and the mirror, messages and the console for the token and its base64 header value.
- Interrupted setups resume: the saved repository is looked up with `getRepo`, never created twice; a repository GitHub no longer has sends the person back to sign-in (and the public/private question).
- `planCodePush` / `pushProjectCode`: the file list is git's own (tracked plus untracked not ignored, state folder excluded), secret names (port of the repository's own rules, with a test that reads `scripts/lib/workflow.mjs` and checks each pattern appears) and content (`scanSecrets` plus `SECRET_TOKENS`) block the push with reasons that carry no value. Ignoring untracked blocked files needs its own click; tracked ones are left to the person.
- 23 new tests (onlineHome 14, codePushCheck 9), all with fakes and local bare repositories; the 63 related existing tests (privacy, state*, scratch, pageScripts, agentTools, phase11) still pass.

## Task Commits

1. **Task 1: Tracer** - `7434743` (feat): domain rules, githubApi, flow with the VS Code route, 3 tests
2. **Task 2 RED** - `2debb00` (test): 9 new cases, 7 failing for the intended reasons (no gh or paste route, no plain errors, no resume)
3. **Task 2 GREEN** - `bb3e7ed` (feat): fallbacks, errors, resume, nested-repository refusal, near-ai-home naming
4. **Task 3 RED** - `094ce60` (test): codePushCheck tests and two flow tests, 10 failing against a skeleton
5. **Task 3 GREEN** - `a97800e` (feat): codePushCheck, the offer in the flow, onlineHomeVscode

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

**TDD evidence.** Task 2's RED run failed 7 of 12 (the gh and paste cases on the missing sign-in sentence, the error cases on an uncaught `GitHubApiError`, resume on a second create, `systemGhCli` on 'not implemented'); two of the new cases (saved repository gone, token hygiene) already passed because the tracer's behaviour satisfied them, and the hygiene test was then mutation-checked on the compiled output: putting the token in a progress message, and in a `remote add` argument, each failed it. Task 3's RED run failed 10 of 11 new cases against a skeleton that threw 'not implemented'. After GREEN, mutating `dist/` showed each safety assertion bites: adding `--force` to the push failed the never-forced test; dropping `scanSecrets` failed the blocked-by-content test; skipping the `SECRET_TOKENS` pass failed it as well. The build was restored after each mutation.

## Files Created/Modified

- `src/domain/state/onlineHome.ts` - names, notes, progress, next-step, error kinds and their plain sentences
- `src/services/githubApi.ts` - fetch-injected API client; response address must equal `expectedCloneUrl`
- `src/services/onlineHome.ts` - the flow, UI and auth seams, gh adapter, token wrapper, progress file
- `src/services/codePushCheck.ts` - name and content checks, the push, `runPersonGit`
- `src/services/onlineHomeVscode.ts` - VS Code sign-in, dialogs, one-time offer
- `src/test/onlineHome.test.ts`, `src/test/codePushCheck.test.ts` - 23 cases, fakes only

## Decisions Made

See `key-decisions`. The two worth restating for plan 15: `afterRemote` gets `{ name, url, git }` where `git` is already signed in to GitHub (build the `StateTransport` with it), and it should return `false` when the turn-on flow did not finish, so the code push is not offered over an unsynced project.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] Pasted addresses with an embedded password or token are refused**
- **Found during:** Task 2
- **Issue:** `validateRemote` accepts `https://user:token@host/...`; adding that as a remote would store a credential in the project's git settings and the progress file (T-27-76, D-14 "never asks for a token").
- **Fix:** `pastedAddressProblem` refuses any password, and any username on https; the same check re-validates a saved address on read.
- **Files modified:** `src/services/onlineHome.ts`, `src/test/onlineHome.test.ts`
- **Commit:** `bb3e7ed`

**2. [Rule 2 - Missing critical] A folder inside another repository is refused**
- **Found during:** Task 2
- **Issue:** `git rev-parse` succeeds in a subfolder, so a plain "is it a repository" check would have added a remote to someone else's repository (a dotfiles repository above the project, for example), or a nested `git init` would have split a monorepo.
- **Fix:** the repository's top level must be the project folder; otherwise one sentence tells the person to open that repository's folder, and nothing is created.
- **Files modified:** `src/services/onlineHome.ts`, `src/test/onlineHome.test.ts`
- **Commit:** `bb3e7ed`

**3. [Rule 3 - Blocking] A separate git runner for the person's own push**
- **Found during:** Task 3
- **Issue:** the plan says the push "uses the person's own git hooks and config", but `runStateGit` forces `core.hooksPath` to an empty folder and signing off on every call, and its commit-tree guard is specific to sync. It cannot be the person's normal push.
- **Fix:** `runPersonGit` in `codePushCheck.ts` (array arguments, timeout, own process group, no prompts, `protocol.ext.allow=never`, English output); `onlineHomeFlow` takes it as `personGit` (tests pass the hermetic runner) and wraps it with `withGitHubAuth` like the sync runner.
- **Files modified:** `src/services/codePushCheck.ts`, `src/services/onlineHome.ts`
- **Commit:** `a97800e`

**4. [Rule 2 - Missing critical] Tracked state-folder files block, files that were not read are reported**
- **Found during:** Task 3
- **Issue:** a tracked file under `.near-ai/state/` would go up as code, and binary or over-1-MiB files are skipped by the content scan without a word.
- **Fix:** a tracked state-folder file is a blocked entry; `CodePushPlan.unchecked` lists files that could not be read as text and the summary shows "N files are too large or not text, so they were not checked for secrets."
- **Files modified:** `src/services/codePushCheck.ts`
- **Commit:** `a97800e`

### Notes on the plan text (not code deviations)

- Interface additions beyond the plan's list: `OnlineHomeUi.pickFallback`, `askRepoUrl`, `done`, `codePush?`; `OnlineHomeInput.gh`, `personGit`, `onStep` (a test seam that stops the setup part way); `FetchLike`; `CodePushPlan.unchecked`; `GITHUB_MESSAGES`. The code-push questions are optional on `OnlineHomeUi` (the VS Code UI always supplies them) so the flow can be tested without them.
- The plan said the tracer's `afterRemote` runs a StateTransport push; the test does exactly that through `remote.git`, with `url.<bare>.insteadOf` set inside `afterRemote`.
- `git remote get-url` applies `insteadOf`, so the tests read `remote.<name>.url` from config to see the stored address.

**Total deviations:** 4 auto-fixed (3 missing-critical, 1 blocking). **Impact:** all tighten the plan's own safety goals; none changes scope.

## Authentication Gates

None. All sign-in, GitHub and gh behaviour is faked; no real account, token or `gh` was used.

## Known Stubs

None.

## Known Limitations

- The secret check reads the working tree. A secret that exists only in earlier commits of the person's history, or a staged version that was edited afterwards, is not seen, and pushing the branch publishes its history. The summary shows the files but not the history; a history scan was left out because the fix (rewriting history) is not something the extension should do for the person.
- Files over 1 MiB and binary files are not content-checked; they are listed in the summary note instead.
- That code-server lacks the GitHub authentication provider is taken from D-14, not verified in code-server's source (as the plan's assumption says).
- Plan 15 must call `onlineHomeFlow` with `vscodeOnlineHomeUi()`, `vscodeGitHubAuth()` and `systemGhCli()`, and `offerOnlineHomeAtStart(context, root, run)`; those are not wired into `extension.ts` here (plan 15 owns registration).

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: network | src/services/githubApi.ts | New outbound HTTPS to api.github.com (create repository, read repository, read the signed-in user); covered by T-27-74 to T-27-78, token only in the Authorization header |
| threat_flag: process | src/services/onlineHome.ts | Spawns the gh CLI from PATH (T-27-80, accepted); arguments are fixed arrays and its stderr is never shown |
| threat_flag: file-write | src/services/codePushCheck.ts | Appends lines to the project's .gitignore, only after the person's click |

## Issues Encountered

None. All runs used `systemd-run` with `MemoryMax=4G` (6G for the wider related run).

## Next Phase Readiness

Ready for 27-15 (turn-on flow and commands) and 27-18 (sync control). Notes:

- **Call shape:** `onlineHomeFlow({ root, ui: vscodeOnlineHomeUi(), auth: vscodeGitHubAuth(), gh: systemGhCli(), afterRemote })`. `afterRemote({ name, url, git })` is where plan 15 builds `new StateTransport({ root, remote: name, mirrorDir, hooksDir, git })`, shows the recovery code and pushes; return `false` if it did not finish.
- **Result:** `{ status: 'declined' | 'cancelled' | 'failed' | 'sync-incomplete' | 'done', message?, remote? }`; continue to the code screen only when `remote` is set and the status is 'done'.
- **Resume** needs no caller work: running the flow again reads `.near-ai/state/sync/online-home.json`.
- **Silent GitHub session for the scheduler** (plan 15 builds transports with the token when one exists silently) is not in this plan: `vscodeGitHubAuth().available()` uses `silent: true` but `token()` uses `createIfNone: true`, so plan 15 should call `vscode.authentication.getSession('github', ['repo'], { silent: true })` itself for background syncs.

## Self-Check: PASSED

- Files present: `src/domain/state/onlineHome.ts`, `src/services/githubApi.ts`, `src/services/onlineHome.ts`, `src/services/codePushCheck.ts`, `src/services/onlineHomeVscode.ts`, `src/test/onlineHome.test.ts`, `src/test/codePushCheck.test.ts`, this SUMMARY.
- Commits on the branch: `7434743`, `2debb00`, `bb3e7ed`, `094ce60`, `a97800e` (`git rev-list --count 172f51d..HEAD` is 5 before this docs commit).
- Acceptance criteria: onlineHome 14 passing (needs 11), codePushCheck 9 (needs 6), 0 failing; `from 'vscode'` 0 in the four non-adapter files; `api.github.com` 2 in githubApi.ts and 3 in the test; `auth token` 2 in onlineHome.ts; `scanSecrets(` 1 in codePushCheck.ts; force-option grep 0; `getSession('github', ['repo']` 1 in onlineHomeVscode.ts.
- Plan verification: both test files pass under the memory cap with fakes only; `npm run lint` clean; `node scripts/secret-scan.mjs --range 172f51d..HEAD` clean; related existing suites (63 tests) pass.
