---
phase: 60-team-core-identity-signed-event-log-git-transport-roster
plan: 08
subsystem: team
tags: [enable, genesis, rollback, team-json, sec-01, canary, git]

requires:
  - phase: 60-01
    provides: "createDeviceIdentity, forgetDeviceIdentity, newTeamId, newMemberId, emailHash, runGit, redactGitMessage, GitNotFoundError"
  - phase: 60-03
    provides: "GitTransport genesis append with exists detection"
  - phase: 60-06
    provides: "writeTeamFile, canonicalTeamFile, teamStorageDir, checkTrustPin, readTeamFile, mirrorRosterEvents"
  - phase: 60-07
    provides: "buildGenesisEvents and TeamLog"
provides:
  - "enableTeamMode: VS Code-free Enable Team Mode flow with preconditions, defaults, genesis push, team.json-only commit, D-22 existing-team handling and rollback"
  - "checkEnablePreconditions, enableDefaults, pushCodeBranch, ENABLE_COMMIT_MESSAGE and the EnableInput, EnableResult and EnableFailureCode types"
  - "teamCanary test helper: runtime canaries, device key renderings, and scanners over raw git objects and files"
  - "SEC-01 canary proof across the mirror, the remote, the project repository, team.json, extension storage and the audit store"
affects: [60-09, 60-10, 60-11]

actuals:
  tokens: 12944
  tasks: 2
  commits: 4
plan_head_before: 019f26d2f780f904941f788e734f15f05f31a34e
plan_head_after: 32eb37529c3c733c6a42c30d25b9b7311d6fc8a5

tech-stack:
  added: []
  patterns:
    - "Push before write: the coordination branch is pushed first, team.json is written and committed only after it landed, so a failure before that point leaves nothing in the project"
    - "Lost-reply check: after a failed genesis push, fetch once and trust only a head equal to the member.joined id before rolling back"
    - "Rollback returns its own failures as message text instead of dropping them"
    - "Scanner controls: the same scanners are first shown to find planted canaries, so an empty result on the real surfaces is meaningful"

key-files:
  created:
    - src/team/enable.ts
    - src/test/helpers/teamCanary.ts
    - src/test/teamEnable.test.ts
  modified: []

key-decisions:
  - "A team.json that exists but cannot be parsed returns exists-locally with the parser's message and is left untouched, because overwriting a file we cannot read could destroy another team's pointer"
  - "Failures after the genesis landed (team.json cannot be saved, trust pin refused) return commit-failed and keep the device key, since the team already exists on the remote and removing the key would orphan it"
  - "The existence probe uses git ls-remote against the remote name with the transport's non-interactive ssh setting, so an ssh passphrase prompt cannot hang the check"
  - "scanGitObjects takes an includeConfig option (default on) because the clone's own config holds the canary remote URL by construction; objects of the clone are still fully scanned"
  - "deviceKeyForms drops repeated renderings: base64 and base64url are the same text for roughly one key in eight"

patterns-established:
  - "Enable messages state the exact manual command (git add -f ... && git commit --only ...) when the user's commit hook refuses the team.json commit"
  - "Tests that need a lost reply use faultRunner with runReal so the push lands but the caller sees a failure"

requirements-completed: [TEAM-01, SEC-01]

coverage:
  - id: D1
    description: "Enable creates the team, an owner member, a device key held only in SecretStorage, the parentless coordination branch with two events and team.json, and a team.json-only commit; the code branch is never pushed and a staged file stays staged"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#Enable creates the team, the device key, the orphan coordination branch and a team.json-only commit, and never pushes the code branch"
        status: pass
    human_judgment: false
  - id: D2
    description: "Missing initialisation, git, repository, commit or remote, an unreachable remote and invalid input each stop Enable with a plain-language reason before anything is created"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#preconditions report each missing prerequisite in plain language and write nothing"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a failed precondition stops Enable before any key, folder or file is created"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#invalid input is refused before anything is created"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#an unreachable remote stops Enable with the reason and nothing is created"
        status: pass
    human_judgment: false
  - id: D3
    description: "An existing team.json reports the existing team, and a remote that already has a coordination log stops Enable before a key exists"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#running Enable again reports the existing team and creates nothing"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a remote that already has a coordination log stops Enable before a device key is created"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a corrupt team.json is reported and left alone rather than replaced"
        status: pass
    human_judgment: false
  - id: D4
    description: "A failed genesis push removes the device key and the mirror; a push whose reply was lost but landed is detected; a failing commit hook unstages team.json, keeps it on disk and names the manual command"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a failed genesis push removes the device key, the mirror and the team storage and writes no team.json"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a genesis push whose reply was lost but that landed is detected and Enable finishes"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a failing commit hook leaves team.json unstaged on disk, explains the exact command and a re-run reports the existing team"
        status: pass
    human_judgment: false
  - id: D5
    description: "The owner email is signed only as a salted hash; the plain address appears in neither the remote nor team.json"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#the owner email is only present as a salted hash and the plain address is nowhere in the remote or team.json"
        status: pass
    human_judgment: false
  - id: D6
    description: "Canaries for the access key, reporting token, refresh token, prompt, remote URL password and every device key rendering never appear in any git object of the mirror, remote or project, in team.json, in extension storage or in the audit store after Enable and roster events"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#SEC-01 canary: no secret reaches any git object, team.json, extension storage or the audit store after Enable and roster events"
        status: pass
      - kind: unit
        ref: "src/test/teamEnable.test.ts#the canary scanners find a planted value in a git object, a file and every device key rendering"
        status: pass
    human_judgment: false
  - id: D7
    description: "A secret typed into the team name, owner name or email is refused with code secret and nothing is written"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a secret typed into the team name is refused and nothing is written anywhere"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#a secret typed into the owner name or email is refused as well"
        status: pass
    human_judgment: false
  - id: D8
    description: "pushCodeBranch is the only code path that pushes the user's code branch, validates its arguments and strips credentials from a failure message"
    requirement: TEAM-01
    verification:
      - kind: integration
        ref: "src/test/teamEnable.test.ts#pushCodeBranch pushes the current branch only when it is called"
        status: pass
      - kind: integration
        ref: "src/test/teamEnable.test.ts#pushCodeBranch refuses option-like names and strips credentials from a failed push message"
        status: pass
    human_judgment: false

duration: about 10 min
completed: 2026-11-01
status: complete
---

# Phase 60 Plan 08: Enable Team Mode Summary

**enableTeamMode runs the whole D-20 flow on real git: preconditions and defaults, a pre-key remote check, the signed genesis pushed to the orphan coordination branch, then a team.json-only commit with `git add -f` and `git commit --only`, with rollback on push failure and unstaging on commit failure; a runtime canary suite proves no secret reaches any git object, team.json, storage file or the audit store.**

## Performance

- **Duration:** about 10 min
- **Started:** 2026-11-01T12:56:04Z
- **Completed:** 2026-11-01T13:06Z
- **Tasks:** 2
- **Files created:** 3 (one source file, one test helper, one test file)

## Accomplishments

- `checkEnablePreconditions` checks git (a runner raising `GitNotFoundError` maps to `git-missing`), the `.planning/.near-ai/` folder (message names "NEAR AI: Set Up"), the repository, at least one commit and the remote name. The remote URL is only tested for existence and discarded. `enableDefaults` returns folder name, git user name and email, `origin`, the current branch, and `main` as integration branch when `refs/heads/main` exists.
- `enableTeamMode` order: preconditions, existing `team.json` (D-22), input validation and `assertNoSecrets` on the team name, owner name and email, `ls-remote` for the coordination branch (D-17), then ids, the email hash only (D-31), the device key, the genesis batch with `defaultTeamPolicy`, the `TeamFile`, and `GitTransport.append(..., { genesis })`. Only after the push is `team.json` written, the trust pin recorded, and `team.json` committed alone.
- A failed genesis push first fetches once; only a head equal to the `member.joined` id counts as landed (tested with a push that succeeds but reports failure). Otherwise the device key and the whole team storage folder (mirror, pin) are removed and `push-failed` carries the redacted reason plus any rollback error text.
- A failing commit hook gives `commit-failed`: `git reset -q` unstages `team.json`, the file stays on disk, the message includes the redacted hook output and the exact `git add -f ... && git commit --only ...` command, and a re-run reports the existing team.
- The code branch is never pushed by Enable (the test compares the remote's `refs/heads/main` before and after, and a file the user had staged stays staged and uncommitted). `pushCodeBranch` pushes only on call and rejects option-like remote and branch names.
- Canary suite: access key, refresh token, reporting token, prompt, remote password, user name and every rendering of two device keys are searched for in all objects (`cat-file --batch-all-objects --batch`, reachable or not) of the mirror, the bare remote and the project repository, in `team.json`, in all extension storage and in `audit.json` after Enable plus availability, skills and device events and the audit mirror. Controls prove the scanners see the canaries where they are meant to be.

## Task Commits

1. **Task 1: enableTeamMode with preconditions, defaults, genesis push, team.json commit-only, D-22 and rollback** - `9e47877` (feat), `13d9057` (test)
2. **Task 2: SEC-01 canary across Enable, roster events and the audit mirror** - `2a483aa` (test), `32eb375` (test, scanner self-test fix)

## Files Created

- `src/team/enable.ts` - enableTeamMode, checkEnablePreconditions, enableDefaults, pushCodeBranch, ENABLE_COMMIT_MESSAGE and the types
- `src/test/helpers/teamCanary.ts` - makeCanaries, deviceKeyForms, scanGitObjects, scanFiles
- `src/test/teamEnable.test.ts` - 20 tests: preconditions, defaults, success path, email hashing, existing-team cases, unreachable remote, invalid input, hook failure, push rollback, lost reply, Push helper, scanner self-test, canary scan, secret refusals

## Decisions Made

See `key-decisions` in the frontmatter. In short: an unreadable `team.json` is reported and left alone, failures after the genesis landed keep the key, the existence probe uses a non-interactive ssh setting, `scanGitObjects` can skip config for the clone, and duplicate key renderings are dropped.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Canary self-test assumed four distinct device key renderings**
- **Found during:** Task 2 (flaky once in a combined run, reproduced in the next full run)
- **Issue:** `deviceKeyForms` returned the stored base64, its base64url, seed hex and seed base64url. When the key has no `+` or `/` the first two are identical, so the self-test's "four distinct forms" assertion failed for roughly one key in eight.
- **Fix:** `deviceKeyForms` returns the distinct renderings (three or four), the test asserts that, and the expected labels in the self-test follow the returned list. 25 consecutive runs of the file passed afterwards.
- **Files modified:** `src/test/helpers/teamCanary.ts`, `src/test/teamEnable.test.ts`
- **Commit:** `32eb375`

**2. [Interpretation] `scanGitObjects` gained an optional `includeConfig` argument**
- The plan says the scan "also reads the repository config", and also says the clone is scanned for `canaryuser`, while the setup puts that URL in the clone's own config. The clone is therefore scanned for objects with `includeConfig: false`, and a control asserts the config does contain the canary URL. The default behaviour matches the interface in the plan.

**Total deviations:** 1 auto-fixed (1 bug in a test helper), 1 interpretation. **Impact:** none on the behaviour or interfaces other plans depend on.

## Issues Encountered

- None beyond the flaky self-test above. A first compile also failed because two U+2028 and U+2029 escapes in a regex were written as literal characters; fixed before any commit.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. The plan's threat register (T-60-36 to T-60-40) is covered by tests: secrets refused before key creation with the canary scan across every surface, the email only as a hash, `git commit --only` with a staged-file check and no code-branch push, the remote-exists check before any key plus rollback and unstaging, and a remote URL that is never read into persisted data (userinfo canary scan). No new network endpoints or auth paths were added; `package.json` is unchanged.

## Verification

- `npm run lint` exits 0.
- `node --test dist/test/teamEnable.test.js dist/test/teamLog.test.js`: 39 tests, 39 pass.
- `npm test` (compile plus the whole suite): 864 tests, 856 pass, 0 fail, 8 skipped (pre-existing skips in other suites).
- Acceptance greps: `'--only'`, `'-f'` and `chore(team): enable NEAR AI Team Mode` match in `enable.ts`; `pushCodeBranch` appears 0 times inside `enableTeamMode`; no `vscode` import and no empty catch in `enable.ts`; `batch-all-objects` matches in `teamCanary.ts`; `canary` appears 8 times in `teamEnable.test.ts`; no secret-shaped literal in either test file.
- Known tooling issue (not touched): `requirements.mark-complete` returns not_found for requirement lines, so `REQUIREMENTS.md` was not edited by hand. TEAM-01 and SEC-01 are listed in the frontmatter for the orchestrator.

## Next Phase Readiness

Ready for 60-09. The command adapter (60-11) can call `enableDefaults` to prefill the prompts, `enableTeamMode` with the extension's `SecretStorage` and `globalStorageUri.fsPath`, show `message` for every `ok: false` result (the `exists-locally` case carries `teamFile` for a Join offer in Phase 61), and call `pushCodeBranch` when the user clicks Push. Settings and the output channel are the command layer's part of the canary proof (60-11).

## Self-Check: PASSED

- FOUND: src/team/enable.ts
- FOUND: src/test/helpers/teamCanary.ts
- FOUND: src/test/teamEnable.test.ts
- FOUND commits: 9e47877, 13d9057, 2a483aa, 32eb375 (all ancestors of HEAD)
