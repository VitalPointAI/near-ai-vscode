---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 13
subsystem: team-commands
tags: [vscode-commands, invite, join, manage-members, near-link, sign-out, quick-pick, modal, clipboard, tdd]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-04 NEAR session and sign-in copy; 61-07 invite flow; 61-08 NEAR link; 61-09 join; 61-10 key delivery; 61-11 removal and cleanup retry; 61-12 session accessors and notification buttons"
provides:
  - src/services/team/memberCommands.ts - Invite to Team, Join Team, Manage Team Members, Link Team to NEAR Organization and Sign Out of NEAR (Team) as thin adapters over the vscode-free flows, plus parseUsdToNanoUsd and formatNanoUsd
  - five contributed commands in package.json (seven nearAi.team commands in total), all registered in every project
  - registerTeamMode wiring with restartSession and optional test options (NEAR address, fetch, sign-in)
  - Enable on a project that already has a team now offers Join Team
  - vscode stub extensions (quick picks, clipboard, modal options, external commands, message responder) for later command tests
affects: [61-14, 62, 66]

plan_head_before: decb5385259439434223d164f43980966a051cb5
plan_head_after: d4c327b9e0e4a6008348d7aae18cfb7a507a8800
actuals:
  tokens: 30728
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "every team module is loaded with a dynamic import inside a handler; memberCommands.ts imports only vscode, Node built-ins and types, so solo activation is still one fs.stat"
    - "the invite bundle is shown once in a modal and reaches the clipboard only on Copy; pasted invites, links and keys use password inputs"
    - "actions offered in a list come from decideTeamAction for this window's member; a window that cannot manage sees the list read-only"
    - "a Push offer never blocks the flow that follows it; the standalone Link command awaits it, the one inside Invite does not"
    - "tests keep each window's own command handlers, because a second window registering the same ids replaces the stub's map"

key-files:
  created:
    - src/services/team/memberCommands.ts
    - src/test/teamMemberCommands.test.ts
  modified:
    - src/services/team/teamCommands.ts
    - package.json
    - src/test/helpers/vscodeStub.ts
    - src/test/teamManifest.test.ts
    - src/test/teamCommands.test.ts
    - src/test/teamSoloParity.test.ts

key-decisions:
  - "The seven-day lifetime is the first quick-pick item (then 24 hours, 3 days, 14 days), because VS Code's quick pick makes the first item the one Enter picks"
  - "Link is checked against the fresh team.json on disk, not the running session's copy, and the session is restarted after a link so key delivery and the status line see the new organization"
  - "A lead invitation in a linked team that is not signed in asks Sign in or Invite without NEAR (closing the modal cancels the invite); the no-NEAR path leaves the NEAR invitation on the cleanup list"
  - "The unfinished-join reset is offered only after a fresh successful sync shows this computer is not on the roster; otherwise the 61-09 message is shown as written"
  - "The confirm sentence 'Their team key has a spend cap of $X set by you' appears only when the team has a NEAR organization and the key was delivered; an unlinked team gets the plain no-organization notice instead"
  - "Remove and Cancel share one finish step that shows RemoveResult.message as written and writes a 'Still to do' list to the channel with the repository reminder last"

patterns-established:
  - "orgForAction: a linked team that is not signed in is asked to sign in, optionally to carry on without NEAR so the function queues a cleanup item"
  - "presentBundle: the one place a bundle is shown, used by Invite and Re-issue"

requirements-completed: []  # TEAM-02 and TEAM-03 are only ticked by the final plan of the phase, as instructed, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "Invite to Team asks name, email, role, allocation (integer nano-USD) and lifetime, offers Link or Skip, and shows the bundle once in a modal with Copy and nowhere else"
    requirement: "TEAM-02"
    verification:
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#tracer: Invite to Team asks its questions, writes member.invited, and shows the bundle once with Copy and nowhere else"
        status: pass
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#parseUsdToNanoUsd turns dollars into integer nano-USD with string arithmetic and refuses everything else"
        status: pass
    human_judgment: false
  - id: D2
    description: "Join Team: masked paste, Clone repository outside the project, join inside it with a session restart, lead sign-in, own key in a masked box without NEAR, and the unfinished-join reset"
    requirement: "TEAM-02"
    verification:
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#Join inside the matching project joins as an observer, says what comes next, and restarts the session with the new device key"
        status: pass
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#Join with no project open offers Clone repository, runs git.clone with the invite address, and writes nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "Link Team to NEAR Organization and Sign Out of NEAR (Team) work per team, commit team.json only, push only when asked, and never touch another team's session"
    requirement: "TEAM-02"
    verification:
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#Link signs in, lists only organizations the lead owns or administers, commits team.json only, and pushes only when asked"
        status: pass
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#Sign out deletes only this team's NEAR session, and with none says there is nothing to sign out of"
        status: pass
    human_judgment: false
  - id: D4
    description: "Manage Team Members: one list and every action (Confirm, Send key, Rotate key, Remove, Cancel, Re-issue, Retry, Mark done), role-filtered, with the key-still-spends warning"
    requirement: "TEAM-03"
    verification:
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#Manage Team Members lists the NEAR line first, then members with their state, invitations and cleanup items"
        status: pass
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#Remove warns that the key can still spend when it could not be capped, and keeps the manual NEAR step in the message"
        status: pass
    human_judgment: false
  - id: D5
    description: "A team without a linked NEAR organization never has UI text that claims spend is capped"
    requirement: "TEAM-02"
    verification:
      - kind: unit
        ref: "src/test/teamMemberCommands.test.ts#Manage Team Members in a team without NEAR starts with the plain no-organization line and never talks about a cap"
        status: pass
    human_judgment: false
  - id: D6
    description: "How the quick picks, modal and toasts look and read in a real VS Code window, and the real browser sign-in and Git: Clone hand-off (the stub replaces both)"
    verification: []
    human_judgment: true
    rationale: "The tests drive the commands through a stub; wording on screen, the browser sign-in and the built-in git.clone dialog are only exercised by a person in a real window"

duration: ~55min
completed: 2026-11-01
---

# Phase 61 Plan 13: Membership commands Summary

**Invite, Join, Manage Team Members, Link to a NEAR organization and Sign Out of NEAR are now command-palette commands that ask plain questions over the vscode-free flows, show an invite bundle exactly once, and never claim a spend cap in a team without a NEAR organization.**

## Performance

- **Duration:** about 55 min (the start time was not recorded; estimated from the first read to the last commit)
- **Completed:** 2026-11-02T03:26Z
- **Tasks:** 3 (one tracer, two auto), all TDD
- **Files modified:** 8 (2 new)

## Accomplishments

- **Invite to Team** asks name, email, role (Developer, Reviewer, Observer, Lead), allocation in US dollars and a lifetime (24 hours, 3 days, 7 days first, 14 days). The allocation becomes integer nano-USD by joining digits as text, never a float; more than two decimals, negatives, exponents and amounts too large for an exact integer are refused. A team with no NEAR link is offered Link a NEAR organization or Skip, and Skip says "No NEAR organization linked: spend is not capped at the provider." once. A lead invitation in a linked team signs the lead in first. An unpushed NEAR link raises a warning with Push. The bundle is shown once in a modal with Copy; it reaches the clipboard only on Copy and is in no message, channel line, input or status text.
- **Join Team** takes the invite in a masked box. Outside the matching project it offers Clone repository, runs `git.clone` with the invite's address and writes nothing. Inside it asks for a display name (default git `user.name`), joins, restarts the session so it signs with the new device key, and says what comes next ("You joined X as an observer. Your lead confirms you and sends your team key."). A lead invitee signs in once and gets the NEAR invitation result; a team without NEAR asks for the member's own key in a masked box. An interrupted earlier join is offered a reset only when a fresh sync shows this computer is not on the team list.
- **Link Team to NEAR Organization** signs in when needed, lists only organizations where the lead is owner or admin, then workspaces, commits team.json only, restarts the session and offers Push; a different existing link needs an explicit Replace link confirmation. **Sign Out of NEAR (Team)** removes this team's session only.
- **Manage Team Members** is one list: the NEAR line, members with state ("waiting for confirmation", "key pending", "key needs rotation"), invitations (pending, expired, used, cancelled) and cleanup items. Actions come from the role of this window: Confirm, Send key, Rotate key, Remove on members; Cancel and Re-issue on invitations; Retry and Mark done (repository access only) on cleanup items. Remove asks first, shows `RemoveResult.message` as written (including the key-still-spends warning) and writes a "Still to do" list ending with the repository reminder. The `{memberId, action}` argument from the session notifications runs the action directly.
- **Enable on a project that already has a team** now says "This project already has a team: X. If your lead sent you an invite, join with it." with a Join Team button.

## Task Commits

1. **Task 1 (tracer): Invite to Team through the vscode stub** - `42d43b3` (test, RED), `0f069d9` (feat, GREEN)
2. **Task 2: Join, Link, Sign Out and the Join offer in Enable** - `346a1cb` (test, RED), `d29203e` (feat, GREEN)
3. **Task 3: Manage Team Members** - `1129ef1` (test, RED), `d4c327b` (feat, GREEN)

**Plan metadata:** the docs commit that adds this file.

## TDD Gate Compliance

All three tasks have a `test(61-13)` commit followed by a `feat(61-13)` commit; no refactor commits were needed.

- **RED semantic assessment:** each RED commit failed on assertions for the planned behavior, not on build or load errors. Task 1: 12 of 22 tests in the three target files failed because the five commands were not registered or contributed and the amount parser returned undefined. Task 2: 15 of 22 failed because Join, Link and Sign out did nothing yet, and the updated Enable test failed on the old "arrives with team invitations" wording. Task 3: 10 of 32 failed because Manage Team Members only checked for a team. The placeholder module in the first RED commit existed so the tests compile; it registered nothing. The `gsd_run check tdd-red-evidence` classifier was not run (TDD gate enforcement is not enabled for this plan type), so RED evidence is this assessment plus the observed failing runs.
- **Tracer gate (auto mode):** after the Task 1 GREEN the verify command was re-run end to end (`npx tsc -p tsconfig.json && node --test` on the three plan files, 36 pass). Logged as "Tracer verified end-to-end, expanding".
- **Mutation checks on the compiled output:** appending the bundle to the output channel makes the tracer fail; letting a window that cannot manage act makes the read-only test fail.

## Files Created/Modified

- `src/services/team/memberCommands.ts` - the five commands, `parseUsdToNanoUsd`, `formatNanoUsd`, `registerMemberCommands`
- `src/services/team/teamCommands.ts` - registers the member commands, adds `restartSession`, the optional test options, the Join offer for an existing team
- `package.json` - five command contributions (seven `nearAi.team` commands in total); dependencies unchanged
- `src/test/teamMemberCommands.test.ts` - 32 tests driving every command through the stub on real git with the fake NEAR
- `src/test/helpers/vscodeStub.ts` - quick picks, clipboard, modal options and detail, external commands, `openExternal`, `asExternalUri`, `uiKind`, `createInputBox`, `password` and `validateInput` recording, and a message responder
- `src/test/teamManifest.test.ts`, `src/test/teamCommands.test.ts`, `src/test/teamSoloParity.test.ts` - updated deliberately for the seven commands, the Join offer and the two command modules

## Decisions Made

See `key-decisions` above. The main one is that the commands read the fresh team.json from disk for "is this team linked" and restart the session after a link or a join, so the running session never acts on a stale team file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] teamSoloParity.test.ts needed two deliberate changes**
- **Found during:** Task 1
- **Issue:** the solo-parity test pinned exactly two registered commands and treated every module under `services/team` other than `teamCommands.js` as "team core". Registering five more commands, and importing `memberCommands.js` statically from `teamCommands.ts` (needed so the commands exist at activation), made both assertions fail. The file is not in the plan's `files_modified`.
- **Fix:** the expected command list names all seven; the loaded-module check also ignores `memberCommands.js`, which imports only `vscode`, Node built-ins and types. The solo proofs (one `fs.stat`, no timer, channel, status item, storage or team core module) are unchanged and still pass.
- **Files modified:** `src/test/teamSoloParity.test.ts`
- **Committed in:** `42d43b3`

**2. [Rule 3 - Blocking] registerTeamMode and MemberCommandDeps gained fields the plan's interface did not list**
- **Found during:** Task 2
- **Issue:** the tests must point the NEAR calls at the fake server and replace the browser sign-in, and the member commands cannot import `SOLO_TEXT` from `teamCommands.ts` (circular import) or create the output channel in a solo project.
- **Fix:** `registerTeamMode(context, options?)` takes optional `nearBaseUrl`, `fetch` and `signIn` (the extension passes nothing); `MemberCommandDeps` also carries `announce` (a message without the channel) and `soloText`.
- **Files modified:** `src/services/team/teamCommands.ts`, `src/services/team/memberCommands.ts`
- **Committed in:** `346a1cb`, `d29203e`

**3. [Rule 1 - Bug] Test teardown raced a sync that a command had nudged**
- **Found during:** Task 1 (intermittent `ENOTEMPTY` removing the fixture, about one run in five)
- **Issue:** a command ends with `session.nudge()`, so a sync could still be writing into the mirror folder while the fixture was removed.
- **Fix:** the test windows wait for a final sync before stopping, and the folder removal retries on `ENOTEMPTY`.
- **Files modified:** `src/test/teamMemberCommands.test.ts`
- **Committed in:** `d29203e`

---

**Total deviations:** 3 auto-fixed (2 blocking, 1 bug). **Impact:** all are test-side or additive; no plan behavior changed and no scope was added.

## Issues Encountered

- The editor tool turned a literal U+2028 inside a regular expression into a real line break, which broke compilation once. The email check now uses `\s`, which already covers those characters.
- Signing out at the fake NEAR rotates the user's tokens, so tests that sign in again after a sign-out must hand back fresh tokens (the fake's `addUser` with the same id does that).

## Known Stubs

None. No placeholder text, empty data flowing to the UI, or unwired component remains in the files created or modified.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: command-exec | src/services/team/memberCommands.ts | Join runs VS Code's `git.clone` with the repository address from a pasted invite. The address was already cleaned by `cleanRepoUrl` (https, ssh and scp-style only, no credentials, query or fragment), it is only used after the person clicks Clone repository, and VS Code's own clone dialog still asks where to put it. It is never logged or shown. |

## Verification

- `npm run lint` (`tsc -p tsconfig.json --noEmit`) exits 0.
- `node --test dist/test/team*.test.js`: 628 tests, 0 failed.
- `node --test dist/test/*.test.js` (once, at the end): 1204 tests, 1196 pass, 0 fail, 8 skipped (the same skips as before this plan).
- Acceptance greps: `grep -c '"command": "nearAi.team.' package.json` is 7; `registerMemberCommands(` in teamCommands.ts; no value import of a team module in memberCommands.ts; no `appendLine(...bundle...)`; no "arrives with team invitations"; `'git.clone'` present; `password: true` three times; `confirmMember(`, `removeMember(` and `retryCleanupItem(` present; no em-dash in memberCommands.ts or the command titles; `^test(` count in teamMemberCommands.test.ts is 32 (at least 12 required).
- package.json dependencies and devDependencies unchanged (teamManifest.test.ts).
- Pre-existing modifications to `.planning/config.json` and `.planning/state.json` left alone. TEAM-02 and TEAM-03 not ticked.

## Next Phase Readiness

61-14 can rely on all five commands being registered and tested. Not covered by tests and worth a look in a real window: the wording of the quick picks, modal and toasts, the real browser sign-in (the tests replace it) and VS Code's Git: Clone hand-off. `rotate-key` is wired through the same path as `deliver-key` but only `deliver-key` has a command-level test; rotation itself is covered in the keyDelivery tests.

## Self-Check: PASSED

- Files present: `src/services/team/memberCommands.ts`, `src/test/teamMemberCommands.test.ts`, `src/test/helpers/vscodeStub.ts`, `package.json`.
- Commits present on this branch: `42d43b3`, `0f069d9`, `346a1cb`, `d29203e`, `1129ef1`, `d4c327b`.
- `commits: 6` is measured with `git rev-list --count` from the persisted plan-start ledger (`plan_head_before`).
