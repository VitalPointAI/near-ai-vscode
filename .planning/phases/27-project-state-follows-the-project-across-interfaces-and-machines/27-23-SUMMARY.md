---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 23
subsystem: online-home-code-push
tags: [gap-closure, G-27-6b, G-27-6a, code-push, default-branch, readme, security]
status: complete

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-20 moveDefaultBranch, remoteDefaultBranch, defaultBranchAfterPush, GitHubRepo.defaultBranch; 27-21 held-back NEAR AI records in the code push summary; 27-17 pushProjectCode"
provides:
  - "src/services/codePushLater.ts: pushCodeLaterFlow (the checked code push for a project that already has an online home, no vscode)"
  - "src/services/onlineHomeVscode.ts: registerCodePushCommand (nearAi.sync.pushCode), vscodeOnlineHomeUi.confirmDefaultBranch"
  - "src/services/onlineHome.ts: repairDefaultBranch (click-confirmed, away from near-ai/state only, pushes nothing), OnlineHomeUi.confirmDefaultBranch, the re-run path that offers the code push, the decline sentence"
  - "README.md and SECURITY.md describing the gap fixes of plans 27-19 to 27-25"
affects: [27-16, release-notes]

requirements-completed: [SYNC-09]

actuals:
  tokens: 16390
  tasks: 3
  commits: 5
plan_head_before: 6cffb32970f560eb4a7f19a672a0ce98c1590e4d
plan_head_after: ee483fe5204b8c3eb44a005bac5d6fe3dd81524e

tech-stack:
  added: []
  patterns:
    - "A flow that needs the person's remote lives in its own file (codePushLater.ts) because syncFlows.ts imports onlineHome.ts and the reverse import would be a cycle"
    - "An optional UI question (confirmDefaultBranch) whose absence means 'never change it': a ui without the method sends no PATCH"
    - "Shared test fakes in src/test/helpers/onlineHomeFakes.ts, so two test files use one fake GitHub, one codeRun fixture and one set of ref-list assertions"

key-files:
  created:
    - src/services/codePushLater.ts
    - src/test/codePushLater.test.ts
    - src/test/helpers/onlineHomeFakes.ts
  modified:
    - src/services/onlineHome.ts
    - src/services/onlineHomeVscode.ts
    - src/extension.ts
    - package.json
    - src/test/onlineHome.test.ts
    - README.md
    - SECURITY.md

key-decisions:
  - "Owner decision 2026-11-13 (no extra branch) followed exactly: the only pushes are refs/heads/near-ai/state (sync, unchanged) and the person's current branch through pushProjectCode, never forced; the repair changes the default branch and nothing else"
  - "A token is used for the later push only when the remote is a github.com address that was not set up by pasting it; a pasted address never involves a token and never reaches the GitHub API, so the person's own credentials push and the settings sentence names the one setting"
  - "The re-run reads the remote with one ls-remote of the person's current branch; a project with no branch, an unreadable remote or an odd remote name gets the old plain sentence only, never an offer or a question"
  - "repairDefaultBranch on the pasted route names the setting only when the remote's HEAD is near-ai/state (27-20's after-push sentence also fires on 'cannot tell'; a repair has no pushed result to justify telling it)"
  - "The decline sentence is told for a declined offer and for a declined summary (both end with the way back)"

patterns-established:
  - "Re-run of a finished setup: no afterRemote, no repository created, progress record untouched; only the person's own code and, with a click, the default branch"

coverage:
  - id: D1
    description: "After a declined code offer, 'Put This Project's Code Online' blocks a planted .env with nothing pushed, then pushes the person's branch with their files and none of the held-back NEAR AI records once it is removed; one PATCH moves a default of near-ai/state after the push"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushLater.test.ts#tracer: after the code offer was declined, the command blocks a planted .env with nothing pushed, then pushes through the same checks once it is gone"
        status: pass
    human_judgment: false
  - id: D2
    description: "The summary carries the saved visibility (the public line only for a public repository); a default the person chose, a declined summary and a blocked push send no PATCH; a refused push changes nothing"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushLater.test.ts#the summary the person clicks on carries the saved repository's visibility"
        status: pass
      - kind: unit
        ref: "src/test/codePushLater.test.ts#the default branch moves only away from near-ai/state, only after a pushed result"
        status: pass
      - kind: unit
        ref: "src/test/codePushLater.test.ts#a refused push leaves the remote as it was, and no default is touched"
        status: pass
    human_judgment: false
  - id: D3
    description: "No remote is one plain sentence with no push and no request; several remotes and no pick push nothing; a pasted address uses the person's own runner, sends no request and gets the settings sentence only when the remote's HEAD is near-ai/state; the gh route uses the gh token in the Authorization header only"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushLater.test.ts#a project with no remote is told in one sentence how to get an online home"
        status: pass
      - kind: unit
        ref: "src/test/codePushLater.test.ts#on a pasted address the push uses the person's own credentials, no request reaches GitHub, and the settings sentence follows the remote's own default"
        status: pass
      - kind: unit
        ref: "src/test/codePushLater.test.ts#on the gh route the gh token is used, without asking for a sign-in, and it reaches the API only in the Authorization header"
        status: pass
    human_judgment: false
  - id: D4
    description: "The token appears in no git argument, file, message or console line of the later push and reaches git only through its environment; the command is declared once in package.json and registered once"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/codePushLater.test.ts#the token appears in no git argument, file, message or console line of the later push, and git gets it only through its environment"
        status: pass
      - kind: unit
        ref: "src/test/codePushLater.test.ts#the command is declared once in the manifest, registered once from the extension, and its id and title match"
        status: pass
    human_judgment: false
  - id: D5
    description: "Declining the code offer ends with one sentence naming 'Put This Project's Code Online' and saying the online repository holds only NEAR AI's encrypted sync branch until then"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#declining the code offer ends with one sentence that names the command and says what the online repository holds until then"
        status: pass
    human_judgment: false
  - id: D6
    description: "Running the setup again no longer dead-ends: with the branch not online it offers the code push (same checks, one PATCH after the push, no afterRemote, no new repository); declining names the command again"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#running the setup again on a project whose code is not online offers the code push"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#running the setup again and declining the code offer names the command again, sends no PATCH and creates nothing"
        status: pass
    human_judgment: false
  - id: D7
    description: "With the branch already online, a re-run says the online home has its code, asks once (only when GitHub shows near-ai/state first), and only on the click sends one PATCH; a default the person chose is never asked about; no question on the ui means no change; the repair pushes nothing"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a re-run whose branch is already online says so in one sentence, asks once whether to make it the default, and only on the click sends one PATCH"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#a re-run never asks about, or changes, a default the person chose or one that is already their branch, and without the question on the ui no PATCH is sent"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#on the gh route the re-run repair is the same click and one PATCH, with the gh token only in the Authorization header"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#repairDefaultBranch asks only when the default is near-ai/state, moves only on a yes, never pushes, and sends nothing to the API without a token and a GitHub name"
        status: pass
    human_judgment: false
  - id: D8
    description: "On a pasted address a re-run sends no GitHub request and names the setting only when the remote shows near-ai/state first; the code offer works; a project with no branch or an unreadable remote gets only the plain sentence; the re-run reads the remote with one ls-remote"
    requirement: SYNC-09
    verification:
      - kind: unit
        ref: "src/test/onlineHome.test.ts#on a pasted address a re-run sends no request to GitHub"
        status: pass
      - kind: unit
        ref: "src/test/onlineHome.test.ts#the re-run reads the remote with one ls-remote of the person's branch, leaves its progress record at done, and a branch it cannot place gets the plain sentence only"
        status: pass
    human_judgment: false
  - id: D9
    description: "README (Marketplace listing) and SECURITY.md state what NEAR AI pushes, the default branch behaviour and the repair click, the new command, which NEAR AI records stay on this computer, the real sync control labels, the reason line under the control and that the invitation appears after NEAR AI is connected"
    requirement: SYNC-09
    verification:
      - kind: other
        ref: "Task 3 verify command: README default branch count 7 (>= 2), SECURITY.md 3 (>= 1), command named, no 'Synced · 5 min', no near-ai/home, no 'NEAR organization'"
        status: pass
    human_judgment: true
---

# Phase 27 Plan 23: Code push later, re-run offer and click-confirmed default branch Summary

**A person who declined pushing their code can run "NEAR AI: Put This Project's Code Online" whenever they choose (the same checked step), the setup's re-run offers it instead of dead-ending, a default left on near-ai/state is moved to their branch only on a click, and README and SECURITY.md describe all the gap fixes.**

## Accomplishments

- `codePushLater.ts`: `pushCodeLaterFlow` resolves the remote with `resolveRemote`, learns owner, name and visibility from the saved setup (when its address matches the remote) or from the github.com address, takes a token only for a github.com address that was not set up by pasting it (a click, so a sign-in may be asked; gh's token for a gh setup), runs `pushProjectCode` unchanged through the person's runner (token-wrapped when signed in), and only after `pushed` calls `defaultBranchAfterPush`. It pushes nothing but the person's branch.
- The command `nearAi.sync.pushCode` ("Put This Project's Code Online", category NEAR AI): declared in `package.json`, registered once by `registerCodePushCommand(context)` (called right after `registerSyncCommands`), using the existing code-push dialogs without the offer question, a QuickPick for several remotes, and the "Open a folder first." sentence.
- `onlineHome.ts`: the early "already has an online home" return is replaced. A finished setup learns the person's branch and whether it is on the remote (one `ls-remote --heads` of that branch). Not online: it offers the code push (same checks, then 27-20's rule). Online: it says the home has its code, then `repairDefaultBranch` asks once through `ui.confirmDefaultBranch`, only when GitHub shows near-ai/state first, and moves the default with one PATCH only on the yes. Unknown (no branch, unreadable remote): the old plain sentence. The re-run never runs `afterRemote` and never creates a repository.
- Declining the code offer (or the summary) in any run now ends with one sentence naming "NEAR AI: Put This Project's Code Online" and saying the online repository holds only NEAR AI's encrypted sync branch until then.
- `vscodeOnlineHomeUi.confirmDefaultBranch`: one information message with "Make <branch> the default" and "Not now".
- Shared test fakes moved to `src/test/helpers/onlineHomeFakes.ts`; 9 new tests in `codePushLater.test.ts` and 9 new in `onlineHome.test.ts` (8 flow tests plus a direct `repairDefaultBranch` test).
- README and SECURITY.md updated: the two things NEAR AI pushes, the default-branch behaviour (shown first until the code is online, then made the default, never a default the person chose, the setting named on a pasted address), the one-click repair for earlier repositories, the new command and the re-run offer, which records stay on this computer (shared allowlist named), the real control labels (clock time, reason line under the control), and the invitation after NEAR AI is connected.

## TDD

- Task 1 was a tracer (one production-quality commit with its tests, after a test-helper refactor commit `512d031`).
- Task 2 RED: `d375003` `test(27-23)`: 8 of the 36 tests in `onlineHome.test.js` failed on the planned assertions (no decline sentence, a re-run that stopped at the plain sentence). The other 28 passed.
- Task 2 GREEN: `9a521a7` `feat(27-23)`: 45/45 across `onlineHome` and `codePushLater`. The direct `repairDefaultBranch` test was added in the GREEN commit because the export did not exist at RED and the RED commit had to compile. No refactor commit.

## Task Commits

1. Test fakes shared (refactor): `512d031`
2. Task 1 (tracer): `27283a1`
3. Task 2 RED: `d375003`; GREEN: `9a521a7`
4. Task 3: `ee483fe`

Tracer gate: the tracer `<verify>` (tsc plus `codePushLater`, `onlineHome`, `codePushCheck`, `syncFlows`) was re-run green before expanding: 87/87.

## Verification

- `tsc -p tsconfig.json && node --test dist/test/onlineHome.test.js dist/test/codePushLater.test.js dist/test/codePushCheck.test.js dist/test/syncFlows.test.js` under the memory cap: 96 tests, 96 pass, 0 fail.
- `npm run lint` exit 0; `node scripts/secret-scan.mjs --range 6cffb32..HEAD` clean (5 commits).
- Task 3 verify command: printed `VERIFY-OK`.
- Only targeted test files were run (per the wave's memory rule); the full unit suite and the extension-host suite are left to the orchestrator after the wave merges.

## Deviations from Plan

### Auto-fixed Issues

None needing a rule. Notes:

- **Extra test file.** `src/test/helpers/onlineHomeFakes.ts` is new and outside `files_modified`; the plan allowed it ("move shared fakes ... if that keeps both files simple"). Importing the fakes from `onlineHome.test.ts` would have registered its tests a second time in `codePushLater.test.ts`.
- **Decline sentence on a declined summary too.** The plan names the declined offer; the same way back is told when the person declines the summary click, since that is also a decline of the code push. No existing assertion forbids it (27-20's tests only forbid the words "default branch" there, which the sentence does not contain).
- **No COVERAGE.md change.** The new command adds no API capability (the PATCH is 27-20's INTEGRATE row), so `COVERAGE.md` was not edited; it is outside this plan's files.
- A pre-existing behaviour left alone: `nearAi.sync.onlineHome` in `syncCommands.ts` records a "synced" outcome whenever the flow returns `done`, including a re-run that only offered the code. That file is outside this plan.

## Known Stubs

None.

## Threat Flags

None. T-27-101: the command calls `pushProjectCode` unchanged (planted .env test). T-27-102: `repairDefaultBranch` pushes, creates and deletes no ref and moves the default only through `moveDefaultBranch` after a click; every new run asserts the remote's ref list and that no push forces or deletes. T-27-103: token hygiene test covers the later push (arguments, files, messages, console, environment-only).

## Next Phase Readiness

Bullets for plan 27-16 Task 3 to add to the 0.4.20 CHANGELOG (plans 27-19 to 27-25):

- Comparisons saved by an older build with the mode `run` are now read as `rerun`, so they move into the project state, list in Compare Models and sync (27-19).
- After your code is pushed to GitHub, NEAR AI makes your branch the repository's default branch when the default is still `near-ai/state` (never one you chose); on a pasted address it tells you which setting to change (27-20).
- The code push leaves NEAR AI's own account and run records in `.planning/.near-ai/` on your computer and names them in the summary; only `team.md`, `project.json` and `verifiers.json` go up with your code (27-21).
- The sync control and the profile chip are fully readable at every chat side bar width, and a sync problem is written as a plain sentence under the control (27-22).
- New command **NEAR AI: Put This Project's Code Online** pushes your code whenever you choose, with the same checks; running **Give This Project an Online Home** again offers it instead of stopping, and declining names the command; on a repository an earlier version set up, a re-run asks once, with a click, whether to make your branch the default branch (27-23).
- The sync control reads **No online home · Set up** as soon as the panel opens in a folder with no remote, and a failure reads the same in the message and on the control (27-24).
- The sync control and the pick-up card show the same clock time in your own locale, and **Keep this project on your other machines** appears only after NEAR AI is connected, with spacing (27-25).

The wave's orchestrator still needs to run the full unit suite and the extension-host suite once after merging.

## Self-Check: PASSED

- FOUND: src/services/codePushLater.ts, src/test/codePushLater.test.ts, src/test/helpers/onlineHomeFakes.ts, src/services/onlineHome.ts, src/services/onlineHomeVscode.ts, src/extension.ts, package.json, src/test/onlineHome.test.ts, README.md, SECURITY.md
- FOUND commits: 512d031, 27283a1, d375003, 9a521a7, ee483fe
