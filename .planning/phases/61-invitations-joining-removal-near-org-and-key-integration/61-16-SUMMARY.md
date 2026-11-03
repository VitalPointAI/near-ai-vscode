---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 16
subsystem: team
tags: [gap-closure, G-61-2, G-61-3, git, online-home, share, tdd]
status: complete

requires:
  - phase: 61-14
    provides: "fix-pass baseline; cleanRepoUrl (inviteBundle.ts), fetchIntegrationBranch/isAncestor (integrationSource.ts), classifyPush (gitTransport.ts)"
provides:
  - "src/team/projectHome.ts: configuredRemoteUrl, checkOnlineHome, teamSetupShared, planShare, shareTeamSetup, SHARE_COMMIT_MESSAGE and the OnlineHome, SharedState, SharePlan, ShareResult types"
  - "networkEnv exported from src/team/enable.ts (same behaviour)"
affects: [61-19, 61-20, 61-21, 61-22]

actuals:
  tokens: 13331
  tasks: 3
  commits: 6
plan_head_before: 94175a47dbf75d0f43c71cdadfb10b8589e27dc5
plan_head_after: eda949a

tech-stack:
  added: []
  patterns:
    - "Online home decided from git config only, with the invite's cleanRepoUrl plus a stricter credential check"
    - "Share by plumbing: temporary GIT_INDEX_FILE in the git dir, read-tree of the online tip, one team.json entry, commit-tree, push <sha>:refs/heads/<branch>"
    - "Each share attempt re-fetches and re-plans; a lost race becomes a setup-only commit on the teammate's tip"

key-files:
  created:
    - src/team/projectHome.ts
    - src/test/teamProjectHome.test.ts
  modified:
    - src/team/enable.ts
    - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/deferred-items.md

key-decisions:
  - "An http or https address with any user part, or an ssh address with a password, is not-shareable with cleanRepoUrl's own credentials sentence, even though cleanRepoUrl itself strips such credentials for an invite (cleanRepoUrl unchanged)"
  - "The setup-only commit reuses the local branch's team.json blob when it matches, and otherwise writes serialiseTeamFile bytes (what writeTeamFile writes), not canonicalTeamFile, so the lead's later merge or rebase meets identical bytes and cannot conflict"
  - "shareTeamSetup plans afresh on every attempt; a first upload (whole local branch) happens only when the caller passes the first-upload plan the person agreed to, otherwise it returns changed so the caller can ask"
  - "A fast-forward is used only for at most 100 unshared single-parent commits that each change team.json alone; anything else (merge, longer run) is shared as setup-only"
  - "Commit identity: the person's own when git var resolves both author and committer, NEUTRAL_IDENTITY_ENV otherwise"

patterns-established:
  - "scrub(detail, url): redactGitMessage plus removal of the configured URL and its redacted form from every detail and thrown message"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "checkOnlineHome tells shareable, local-only, no-remote or not-shareable from git config alone, with cleanRepoUrl's sentence as the reason and no URL in it"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamProjectHome.test.ts#checkOnlineHome tells shareable, local-only, no-remote and not-shareable from git config alone, with no network call"
        status: pass
    human_judgment: false
  - id: D2
    description: "teamSetupShared reports shared, not-shared (branch, team-file, different-team-file), record-missing, not-reachable-by-teammates (no fetch) and unknown with a redacted detail"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamProjectHome.test.ts#tracer: after Enable the team setup is not shared until main is pushed, and a different organization link counts as not shared"
        status: pass
      - kind: integration
        ref: "src/test/teamProjectHome.test.ts#teamSetupShared reports a missing integration branch, a missing coordination record, an unreachable home and a local-only home"
        status: pass
    human_judgment: false
  - id: D3
    description: "planShare and shareTeamSetup put exactly team.json on the integration branch (fast-forward, setup-only, first-upload with consent, already) without moving local branches, HEAD, the index or the working tree"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamProjectHome.test.ts#an unrelated local commit before Enable: planShare gives setup-only and only team.json reaches the online home, nothing local moves"
        status: pass
      - kind: integration
        ref: "src/test/teamProjectHome.test.ts#an online home without the integration branch: planShare gives first-upload, and only that consented plan uploads the local branch"
        status: pass
    human_judgment: false
  - id: D4
    description: "Lost push races are re-planned up to the attempts limit, refusals return rejected with the redacted reason, and no result carries a URL credential or the configured URL"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamProjectHome.test.ts#an online home that moves before every push: after exactly the given attempts the share stops as changed and nothing local moved"
        status: pass
      - kind: integration
        ref: "src/test/teamProjectHome.test.ts#no result, detail or thrown message carries a credential in the configured URL, or the configured URL of an unreachable home"
        status: pass
    human_judgment: false

duration: 12 min
completed: 2026-11-03
---

# Phase 61 Plan 16: Online Home and Team Setup Share Core Summary

**src/team/projectHome.ts reads the online home from git config alone with the invite's cleanRepoUrl, asks the remote whether this computer's team.json is on the integration branch, and shares exactly team.json there (by fast-forward or one plumbing commit on the online tip), re-planning lost races and never force-pushing or touching the person's branches, index or working tree.**

## Performance

- Duration: 12 min (2026-11-03T21:29:47Z to 2026-11-03T21:41:33Z)
- Tasks: 3 (tracer, two auto), each RED then GREEN
- Files: 1 source created, 1 source modified, 1 test file created, 1 deferred-items note

## Accomplishments

- G-61-2 core: `checkOnlineHome` gives `shareable`, `local-only` (local path or file://), `no-remote` or `not-shareable` (remote helper, unsupported scheme, credentials), reading only `git config --get remote.<name>.url`.
- G-61-3 core: `teamSetupShared` probes the coordination ref with `ls-remote --exit-code`, fetches the integration branch into `refs/near-ai/integration/<branch>`, reads team.json there with a 64 KiB cap and compares canonical forms.
- `planShare` and `shareTeamSetup`: `already`, `fast-forward` (every unshared commit changes team.json only), `setup-only` (one commit on the online tip, team.json only), `first-upload` (only with the consented plan), `blocked`; push is always `git push --porcelain <remote> <sha>:refs/heads/<branch>`.
- Races, refusals and redaction: up to `attempts` (default 3) fresh plan-and-push rounds; `changed`, `rejected`, `offline` codes; every detail redacted and scrubbed of the configured URL.

## Task Commits

1. Task 1 (tracer) RED: `71c21e7` test(61-16): expect the online home and shared team setup to be read from a real clone
2. Task 1 GREEN: `020dff5` feat(61-16): read the online home from git config and the shared team setup from the remote
3. Task 2 RED: `d0871df` test(61-16): expect the share to move only team.json to the integration branch
4. Task 2 GREEN: `e161805` feat(61-16): plan and share the team setup by the narrowest change
5. Task 3 RED: `ee581d1` test(61-16): expect a lost push race to be re-planned and refusals and addresses to stay redacted
6. Task 3 GREEN: `eda949a` feat(61-16): re-plan a share that lost a push race, up to the given attempts

## TDD Gate Compliance

- Task 1 RED: `node --test --test-reporter=tap dist/test/teamProjectHome.test.js`, exit 1, 4 tests, 4 fail; target "tracer: after Enable the team setup is not shared until main is pushed, and a different organization link counts as not shared" failed with "not implemented" from the declared-only teamSetupShared. Classifier: RED_EVIDENCE_OK (target_test_failed). Semantic assessment: the module compiled, the target ran and failed because the behaviour was absent, not on a load or syntax fault.
- Task 2 RED: same command, exit 1, 11 tests, 7 fail (the 4 Task 1 tests passed); target "an unrelated local commit before Enable: planShare gives setup-only ..." failed with "not implemented" from the declared-only planShare. Classifier: RED_EVIDENCE_OK. Semantic assessment: behaviour absent, every new Task 2 test failed for that reason only.
- Task 3 RED: same command, exit 1, 15 tests, 2 fail; target "an online home that moves before every push ..." failed on ERR_ASSERTION (1 push instead of 3) and the race test failed on deepEqual (`changed`, `[rejected] (fetch first)` instead of a setup-only success). Classifier: RED_EVIDENCE_OK. Semantic assessment: the planned retry assertion failed; the hook-refusal and redaction tests already passed because Task 2's push classification and scrub were in place.
- Every RED commit precedes its GREEN commit; no REFACTOR commits.

## Verification

- Task 3 command (`tsc` then `node --test dist/test/teamProjectHome.test.js dist/test/teamEnable.test.js dist/test/teamInviteBundle.test.js`, MemoryMax=4G): exit 0, 49 tests, 49 pass, 0 fail.
- `git diff --quiet a7fcba5 -- src/team/inviteBundle.ts`: exit 0 (cleanRepoUrl unchanged).
- `grep -c "^test(" src/test/teamProjectHome.test.ts`: 15. No vscode import in projectHome.ts (0); no `'--force`, `'--mirror'` or `'--all'` (0).
- Broader impacted check, all `dist/test/team*.test.js` (MemoryMax=6G): 968 tests, 963 pass, 2 skipped, 3 fail. Two are the known self-import failures owned by 61-22 (teamGsdImport, teamImport). The third, teamSession "an unreachable remote pauses ... recovers" (2 !== 1 paused writes), passed 3 times alone and in a full teamSession.test.js run (21/21); logged in deferred-items.md as load-sensitive.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A credential-bearing https or ssh address would have been "shareable"**
- Found during: Task 1 GREEN
- Issue: the plan expects `https://user:secret@...` to be not-shareable "with cleanRepoUrl's sentence", but cleanRepoUrl accepts such http, https and ssh addresses and strips the credential (it only refuses scp-style `user:pw@host:path`). Relying on cleanRepoUrl alone would have broken the TEAM-02 prohibition against accepting a credential-bearing address as shareable.
- Fix: `carriesCredentials` in projectHome.ts makes any user part of an http/https address, or a password in an ssh address, not-shareable, with the reason taken from cleanRepoUrl's own credentials sentence. cleanRepoUrl is unchanged. The Task 1 test was corrected to expect that sentence for the credential URLs (it had wrongly asserted cleanRepoUrl refuses them) and gained ssh-with-password, token-as-user, scp-with-password and plain `ssh://git@` (still shareable) cases.
- Files: src/team/projectHome.ts, src/test/teamProjectHome.test.ts
- Commit: 020dff5

**2. [Rule 1 - Bug] canonicalTeamFile bytes in the share commit would conflict with the Enable commit**
- Found during: Task 2 design
- Issue: the plan says hash-object of canonicalTeamFile text, but Enable commits team.json as serialiseTeamFile (pretty JSON). Two different blobs added at the same path give an add/add conflict when the lead merges or rebases, breaking the plan's own "catch up without a conflict, team.json byte for byte" behaviour.
- Fix: reuse the local branch's team.json blob when it matches canonically, otherwise write serialiseTeamFile bytes.
- Files: src/team/projectHome.ts
- Commit: e161805

**3. [Rule 2 - Safety] No first upload without the person's consent**
- Found during: Task 2
- Issue: the plan lets shareTeamSetup run without a plan; if a re-plan found no integration branch, it would have uploaded the whole local branch unasked.
- Fix: a first upload runs only when the caller passes the `first-upload` plan; otherwise `changed` is returned so the caller can ask. Tested.
- Commit: e161805

**Total deviations:** 3 auto-fixed (2 bugs, 1 safety). **Impact:** the API surface is the one in the plan's interfaces block; the online home check is stricter than the invite on credentials, as the plan's prohibition requires.

## Known Stubs

None.

## Threat Flags

None. The only new network surface is the push to `refs/heads/<integration branch>`, already in the threat model (T-61-67, T-61-68).

## Deferred Issues

- teamGsdImport and teamImport self-import tests still fail as recorded by 61-15 (owned by 61-22).
- teamSession timing failure under the all-team run, logged in deferred-items.md.

## Next

Ready for 61-17.

## Self-Check: PASSED
