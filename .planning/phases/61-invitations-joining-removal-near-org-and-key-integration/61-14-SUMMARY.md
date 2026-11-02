---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 14
subsystem: team-verification
tags: [end-to-end, privacy-canary, live-test, phase-gate, fake-near, tdd]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-07 invite, 61-08 link, 61-09 join, 61-10 key delivery, 61-11 removal and own-removal cleanup, 61-12 TeamSession, 61-13 commands, and the fake NEAR server from 61-02"
provides:
  - src/test/helpers/teamFlowRig.ts - a three-clone rig (owner, developer, lead) with one function per lifecycle step over the real flow modules, the fake NEAR and real git
  - src/test/teamFlow.test.ts - the whole lifecycle linked and unlinked (criterion 3 against the fake)
  - src/test/teamInvitePrivacy.test.ts - the criterion 4 canary over the full flow, each place asserted on its own, with positive controls
  - src/test/teamNearLive.test.ts - the opt-in live test behind NEAR_LIVE_TEAM=1, skipped otherwise
  - teamCanary.ts inviteCodeForms and an access-token canary; fakeNear addUser can take caller-supplied tokens
  - the Per-Task Verification Map in 61-VALIDATION.md filled for plans 01 to 14
affects: [62, 66, verify-work]

plan_head_before: 81256e18e7eef9edf275af3944270e92daa195cc
plan_head_after: c508a26516869e07266916942a348a30ae9232a7
actuals:
  tokens: 34400
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "a lifecycle rig built from the real flow functions, so an end-to-end test cannot drift from the product"
    - "canary secrets are made at run time and handed to the fake server (key prefix, issued tokens), so the scan looks for the exact values that flowed through the system"
    - "each scanned place is its own assertion so a failure names the place; a planted value and the values' legitimate homes (SecretStorage, invites.json, the clone's git config) are controls"

key-files:
  created:
    - src/test/helpers/teamFlowRig.ts
    - src/test/teamFlow.test.ts
    - src/test/teamInvitePrivacy.test.ts
    - src/test/teamNearLive.test.ts
  modified:
    - src/test/helpers/teamCanary.ts
    - src/test/helpers/fakeNear.ts
    - src/test/teamEnable.test.ts
    - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-VALIDATION.md

key-decisions:
  - "No production code changed: the lifecycle, the privacy canary and the full gate all passed against the modules from plans 01 to 13, so there is no defect fix to list"
  - "The 'coordination push between cap and revoke' ordering is proven by counting the event files on the remote's coordination branch at the moment of each NEAR call made through the lead's session (exactly one more at the revoke than at the cap), because the fake NEAR cannot see git"
  - "The unlinked variant gives each person a key of their own in a separate NEAR organization, and asserts that the only requests the fake sees after the invitations are the two check_api_key calls of the pasted keys, all authenticated by an API key"
  - "The privacy test also starts a TeamSession for the owner, the lead and the removed developer after the flow so the NEAR AI Team output channel, notifications, status bar and audit mirror are part of what is scanned"

patterns-established:
  - "openLog(rig, who): a synced TeamLog for one computer that signs when that computer still holds a device key and is read-only otherwise"

requirements-completed: [TEAM-02, TEAM-03]

coverage:
  - id: D1
    description: "Linked lifecycle on three clones and the fake NEAR: enable, link, invite a developer and a lead, the developer joins with no NEAR request, the lead joins and is an admin in NEAR, the owner confirms both, keys carry the allocation as their limit and are installed, the lead removes the developer (limit 0, push, revoke in that order), and the developer's computer cleans up"
    requirement: "TEAM-02, TEAM-03"
    verification:
      - kind: integration
        ref: "src/test/teamFlow.test.ts#tracer: enable, link, invite a developer and a lead, join, confirm, deliver keys, remove through the lead, clean up the removed computer"
        status: pass
    human_judgment: false
  - id: D2
    description: "The same lifecycle in a team with no NEAR organization uses the members' own keys and makes no organization or workspace-key call"
    requirement: "TEAM-02, TEAM-03"
    verification:
      - kind: integration
        ref: "src/test/teamFlow.test.ts#the same lifecycle in a team with no NEAR organization uses the members' own keys and makes no organization or workspace-key call"
        status: pass
    human_judgment: false
  - id: D3
    description: "A privacy canary finds no API key, token, invite code in any rendering, device or seal private key, remote password or plain email in the bare remote, any mirror, team.json, .planning, extension storage, the output channel, notifications, status bar, settings or commit text"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "src/test/teamInvitePrivacy.test.ts#SEC-01: after invite, join, confirm, key delivery, removal and cleanup no secret, code, private key or plain email is written anywhere"
        status: pass
    human_judgment: false
  - id: D4
    description: "The opt-in live test exists, skips without NEAR_LIVE_TEAM=1 and its variables, never prints the token, and always revokes its key"
    requirement: "TEAM-02"
    verification:
      - kind: unit
        ref: "src/test/teamNearLive.test.ts#the skip reason names what is missing and never shows a value"
        status: pass
    human_judgment: true
    rationale: "Running it against a real organization needs the owner's credentials and was not done here; it is the first step of the manual check"
  - id: D5
    description: "The full repository gate: npm run check, e2e and verify:release"
    requirement: "criterion 5"
    verification:
      - kind: command
        ref: "npm run check"
        status: pass
      - kind: command
        ref: "DISPLAY=:0 env -u ELECTRON_RUN_AS_NODE node dist/test/e2e/run.js"
        status: pass
      - kind: command
        ref: "npm run verify:release"
        status: pass
    human_judgment: false
  - id: D6
    description: "The manual check against a real NEAR organization"
    requirement: "TEAM-02, TEAM-03"
    verification: []
    human_judgment: true
    rationale: "Needs a real organization, an owner or admin account and a second account; pending for the owner (see Manual check pending)"

duration: ~15 min
completed: 2026-11-02
---

# Phase 61 Plan 14: Phase gate - lifecycle, privacy canary, live test Summary

**The whole invite, join, confirm, deliver, remove and clean-up lifecycle now passes on three real clones and the fake NEAR (linked and unlinked), a run-time privacy canary finds nothing anywhere, the opt-in live NEAR test is in place, and `npm run check`, e2e and `verify:release` are green; only the manual check against a real NEAR organization is left for the owner.**

## Performance

- **Duration:** about 15 min
- **Completed:** 2026-11-02
- **Tasks:** 3
- **Files:** 4 created, 4 modified (plus the pre-existing config and state modifications, left alone)

## Accomplishments

- **Lifecycle (criterion 3 against the fake).** `teamFlowRig.ts` calls the real `enableTeamMode`, `linkChoices` and `linkNearOrganization`, `pushCodeBranch`, `inviteMember`, `prepareJoin` and `joinTeam`, `confirmMember`, `installDeliveredKey`, `removeMember` and `handleOwnRemoval`. The linked test shows: the developer's join sends zero requests to NEAR; the lead's join accepts the organization invitation and NEAR lists the lead as admin; keys carry 5 and 20 USD as their limits; the developer's installed key answers 200; the lead removes the developer through the kept NEAR session, and the fake's request log has the spend-limit PATCH before the key DELETE with exactly one event (the removal) pushed in between; the key then answers 401, the lead's own key still 200; the developer's next append is refused as removed; their computer restores the personal profile, deletes the device and seal keys and writes `removed.json`; all three clones end with identical `serialiseState`. The lead's cleanup list holds only the repository reminder.
- **Unlinked variant (D-04).** Same flow with each person's own pasted key: the notice says spend is not capped, confirmation returns `not-applicable`, the lead removes the developer with no NEAR call, and the fake saw only the two `check_api_key` requests of the pasted keys.
- **Privacy canary (criterion 4).** Keys (run-time `sk-canary` prefix given to the fake), the owner's and lead's access and refresh tokens (run-time canaries given to the fake, plus the rotated refresh tokens read back from SecretStorage), both invite codes in 7 renderings each, the Ed25519 and X25519 private keys in every stored form (taken before cleanup deletes the developer's), the remote URL password and user, and the plain emails are looked for in: the bare remote, every mirror, every clone's project objects, `team.json`, each clone's whole `.planning`, every extension storage file, text the flows produced plus the NEAR AI Team output channel, notifications, the status bar, VS Code settings writes and commit text. `invites.json` is scanned for secrets only, since it is the one file allowed to hold an email. Controls: the URL password is in the owner clone's git config, the refresh token and the developer's key are in SecretStorage, `invites.json` holds exactly the two emails, and a canary planted in a storage folder is found. I also broke the test on purpose (an invite-code rendering written into a clone's `.planning`, in the compiled output only) and confirmed it failed naming that place.
- **Live test.** `teamNearLive.test.ts` is skipped with a reason that names the missing variable and never a value. With the environment it lists organizations and workspaces, creates `near-ai-live-<random>` at limit 0, polls up to 70 s for 402, raises to 1,000,000 nano-USD and polls for 200, sets 0, revokes, polls for 401, and always zeroes and revokes in a `finally`. A second test (needs `NEAR_LIVE_TEAM_INVITE_EMAIL`) invites at member role, finds the invitation and cancels it.
- **Gate.** See Verification.

## Task Commits

1. **Task 1: lifecycle rig and tests** - `f4f630d` (test)
2. **Task 2: privacy canary and live test** - `ca69a07` (test)
3. **Task 3: validation map** - `c508a26` (docs)

The metadata commit that carries this summary follows.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The fake NEAR could not be given recognisable tokens**
- **Found during:** Task 1 (needed for Task 2)
- **Issue:** `fakeNear.addUser` always made random `fa-`/`rt_` tokens, so a canary built at run time could not be the token that actually flows through the system.
- **Fix:** `addUser` takes optional `accessToken` and `refreshToken`; behaviour without them is unchanged.
- **Files modified:** `src/test/helpers/fakeNear.ts`
- **Commit:** `f4f630d`

**2. [Plan consequence] A pre-existing assertion counted five canaries**
- **Found during:** Task 2
- **Issue:** The plan adds the access token to `labelled()`. `teamEnable.test.ts` asserts the number of distinct labelled canaries is 5.
- **Fix:** The expected count is now 6. The assertion's purpose (every canary is a different value) is unchanged and it still guards that; no test was skipped or loosened.
- **Files modified:** `src/test/teamEnable.test.ts`
- **Commit:** `ca69a07`

**Total deviations:** 2 (one test-helper extension, one expectation updated by the plan's own change). **Impact:** none on product code. No defect was found in any module from plans 01 to 13, so no fix is listed for a responsible plan.

### TDD note

All three new suites passed on their first run, because the behaviour they pin already exists; there was no RED failure to commit. Instead of a failing-first commit I proved the canary can fail (see Accomplishments) and relied on the request-order and event-count assertions, which would fail if the cap, the push and the revoke were reordered.

## Authentication Gates

None. The live test needs the owner's credentials and was not run (by design).

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or file access in product code; this plan added only tests and a test helper.

## Verification

- `npx tsc -p tsconfig.json && node --test dist/test/teamFlow.test.js`: 2 tests, 0 failed (`grep -c "^test(" src/test/teamFlow.test.ts` is 2).
- `node --test dist/test/teamInvitePrivacy.test.js dist/test/teamNearLive.test.js`: exit 0, 1 canary test passed, the skip-reason test passed, 2 live tests skipped; also `teamEnable` and `teamCommands` re-run green after the canary helper change.
- `npm run check` (once, at the end): lint clean, 1210 tests, 1200 pass, 0 fail, 10 skipped. The other 8 skips are the same environmental ones as before this plan (ripgrep, LibreOffice, Open-GSD runtime, NEAR_AI_API_KEY live tests).
- e2e: `npm run compile && DISPLAY=:0 env -u ELECTRON_RUN_AS_NODE node dist/test/e2e/run.js` exit 0, 13 checks passed, 0 failed, including "activates in a project set up with the extension and registers every contributed command". `package.json` contributes the five new commands (`nearAi.team.invite`, `join`, `manageMembers`, `linkNearOrganization`, `signOutNear`) and the scenario fails if any contributed command has no handler, so all five are registered.
- `npm run verify:release`: exit 0, "Release content verified: 243 entries, 173 runtime JavaScript files, and 44 required release assets", no `ERROR`.
- Acceptance: `grep -n "export function inviteCodeForms" src/test/helpers/teamCanary.ts` and `grep -n "NEAR_LIVE_TEAM" src/test/teamNearLive.test.ts` match; the `| OPT-OUT |` counts in COVERAGE.md are 9 and 9; `grep -c "61-"` on `61-VALIDATION.md` went from 1 to 40; the privacy test has one assertion per scanned place.
- **Node 22:** not available on this host (only Node 24.22.x under nvm, nothing else found), so the team family was not run under Node 22. Everything above ran on Node 24.22.2.
- `package.json` dependencies unchanged (`teamManifest.test.ts` passed in the full run). The pre-existing modifications to `.planning/config.json` and `.planning/state.json` were left alone.

## Manual check pending (owner)

The one criterion not proven here is the real-NEAR check, recorded for UAT and **not** faked:

1. Run the live test first: set `NEAR_LIVE_TEAM=1`, `NEAR_LIVE_TEAM_ACCESS_TOKEN` (a short-lived session access token, never a refresh token, because rotation would burn it), `NEAR_LIVE_TEAM_ORG_ID`, `NEAR_LIVE_TEAM_WORKSPACE_ID`, optionally `NEAR_LIVE_TEAM_INVITE_EMAIL`, then `npm run compile && node --test dist/test/teamNearLive.test.js`.
2. In two VS Code windows: link the real organization, invite a developer, join from the second window with the bundle, confirm from the first, make one chat request on the developer's team key, remove the developer, and confirm their key answers 402 (limit 0) and then 401 (revoked) within about a minute.
3. Invite a lead to a disposable address, accept in the extension, and check the NEAR console shows the lead as admin.

Known limit from 61-11 to keep in mind while testing: removing a lead from the NEAR organization is a manual console step, because NEAR's member list carries no emails.

## Release notes for v0.6.0

A client built from Phase 60 rejects `member.invited` and `member.key-sealed` as unsupported event types (research Pitfall 9). **Every member must update the extension before the first invitation is sent**, or their client will refuse the log and show the "update the extension" message.

## Requirements

TEAM-02 and TEAM-03 are ticked in REQUIREMENTS.md because every success criterion of the phase is proven by automated tests (criteria 1 and 2 by plans 01 to 13, criteria 3 to 5 by this plan) **except the manual part of criterion 3**, the check against a real NEAR organization, which stays pending for the owner above.

## Next Phase Readiness

Phase 61 is complete apart from the owner's manual real-organization check and the live test run. Phase 62 can rely on the lifecycle rig (`teamFlowRig.ts`) for any test that needs a joined, confirmed team across clones.

## Self-Check: PASSED

- Files present: `src/test/helpers/teamFlowRig.ts`, `src/test/teamFlow.test.ts`, `src/test/teamInvitePrivacy.test.ts`, `src/test/teamNearLive.test.ts`, `src/test/helpers/teamCanary.ts`.
- Commits present on this branch: `f4f630d`, `ca69a07`, `c508a26`.
- `commits: 3` is measured with `git rev-list --count` from the persisted plan-start ledger (`plan_head_before`).
