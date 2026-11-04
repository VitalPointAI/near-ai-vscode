---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 29
subsystem: auth
tags: [team-mode, join-request, members, automatic-confirm, key-delivery, gap-closure, G-61-9]

requires:
  - phase: 61-28
    provides: "joinRequest.ts: createJoinRequest, readPendingRequest, cancelJoinRequest, parseJoinRequest, requestCheckCode, acceptJoinRequest, completeJoinRequest, wasAcceptedHere; catchUpCopy without a team id"
  - phase: 61-26
    provides: "Members with Invite someone as its first row"
provides:
  - "nearAi.team.askToJoin (Ask to Join a Team): create the request, show it again, cancel it, and with { complete: true } join by itself"
  - "Members: Accept a request, right after Invite someone, with the check code reminder and the invite's role, allowance and lifetime"
  - "Manage Team Members { memberId, action: 'confirm', auto: true }: no sign-in prompt, key only with a kept NEAR AI sign-in"
  - "TeamSession: automatic completion on the requester's computer, automatic confirm on the accepting computer, onKeyInstalled"
  - "TeamModeHandle.joinRequestPending() for the sidebar (61-30)"
affects: [61-30, 61-31, 61-uat-retest]

actuals:
  tokens: 18309
  tasks: 3
  commits: 6
plan_head_before: 6151112aee06ff8e01ed24e0208278d3a6633514
plan_head_after: 8eb0816c0871ae4269409be4c4bd3958ad56e289

tech-stack:
  added: []
  patterns:
    - "A session's automatic step runs a command and waits for it, but only once start() has finished; a step seen in the first sync is deferred and start() nudges one more sync, so a command that needs (or restarts) the session never waits on the start that is running it"
    - "A command that returns a value to the session (Ask to Join returns what the completion did) is registered with its own try/catch instead of guarded()"
    - "Two or three windows on the vscode stub: each keeps its own handlers and is brought to the front (folder and handlers) before it acts, so its session's executeCommand reaches its own commands"

key-files:
  created:
    - src/test/teamAskToJoin.test.ts
  modified:
    - src/services/team/memberCommands.ts
    - src/services/team/teamSession.ts
    - src/services/team/teamCommands.ts
    - package.json
    - src/test/teamManifest.test.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamMemberCommands.test.ts
    - src/test/teamSectionHost.test.ts

key-decisions:
  - "The requester's session completes when it has no device key and the stored request's member id has an invitedEvent in the state. Expired, cancelled and used are remembered in notified.json (join-request:<member>:<invitedEvent>:<removedEvent>), so they are reported once. Any other failure is tried again on a sync at least five minutes later."
  - "The accepting computer confirms by itself only when accepted-requests.json names the member. This is checked in the session and again in the command. It happens once per member.joined (the same confirm:<joinedEvent> key as the waiting notice), and the deliver-key notice for that join is marked as shown, so the person gets one notice."
  - "Auto confirm never prompts. In a linked team it uses a NEAR AI sign-in this computer already keeps; without one it confirms and says 'Choose Send key in Members when you are ready.'"
  - "Ask to Join run while the request was already accepted joins right away. This is the manual path if the automatic step failed."
  - "A copy without team.json is brought up to date from origin (catchUpCopy, no team id). It gets Join's sentences and Get a fresh copy. The address goes to git.clone only when cleanRepoUrl accepts it."
  - "joinRequestPending reads only secure storage while a session runs. Without one, it does the team.json stat that Team Mode already does. A stored request that cannot be read counts as waiting, so the person can still see it and cancel it."

patterns-established:
  - "teamManifest.test.ts pins memberCommands' ASK_TO_JOIN_COMMAND to the copy in teamSession.ts, like JOIN_COMMAND and MANAGE_MEMBERS_COMMAND"

requirements-completed: [TEAM-02]

coverage:
  - id: D1
    description: "Ask in one window (name filled in, optional email, one modal with Copy request, check code and the instruction paragraph), Accept a request in Members in the owner's window (check-code question, role, allowance, lifetime, email only when missing), and the first window joins by itself on its next sync, says 'You are on <team> now.' and runs no second completion"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#tracer: a person asks in one window, the owner accepts in Members, and the first window joins by itself on its next sync"
        status: pass
    human_judgment: false
  - id: D2
    description: "The accepting computer confirms by itself in the role it chose and sends the capped key when signed in; without a sign-in it asks none and leaves Send key with one notice; another lead's computer shows the usual waiting notice; expired and cancelled requests are reported once with Ask again and leave no key; onKeyInstalled fires once"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#the computer that accepted a request confirms that person by itself when their join arrives, in the role it chose, and says so once"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#in a linked team with the owner signed in, the automatic confirm creates the key capped at the allowance and the person installs it once"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#in a linked team with the owner not signed in, the automatic confirm asks no sign-in, confirms, and leaves Send key with one notice"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#another lead's computer that did not accept the request shows the usual waiting notice with Confirm; the accepting computer confirms"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#an accepted request whose invitation ran out is reported once with Ask again, and this computer keeps no team key"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#a request whose invitation the owner cancelled is reported once with Ask again, and Ask again makes a new request"
        status: pass
    human_judgment: false
  - id: D3
    description: "Show again (Copy request, Cancel my request), cancel asks once, a new request after; joinRequestPending true while stored and false otherwise; a behind copy is caught up; no folder, no team online and local changes said plainly; the contribution and the solo list; the stored code nowhere"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#asking again shows the same request with Copy request and Cancel my request; cancelling asks once; the handle says whether a request waits"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#joinRequestPending is false with no folder open and in a project with no team"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#a copy without the team setup is brought up to date first, then asks; the session starts so it can join by itself"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#with no folder open, with no team online, and with changes not online yet, Ask to Join says so plainly and asks nothing"
        status: pass
      - kind: integration
        ref: "src/test/teamAskToJoin.test.ts#privacy: the stored code appears in no message, prompt, channel line, setting or file of either window, from asking to confirmed"
        status: pass
      - kind: unit
        ref: "src/test/teamManifest.test.ts#package.json contributes the six membership commands under the NEAR AI category with plain titles"
        status: pass
      - kind: unit
        ref: "src/test/teamSoloParity.test.ts#the eleven Team Mode commands are registered and nothing else"
        status: pass
    human_judgment: false

duration: 21min
completed: 2026-11-04
status: complete
---

# Phase 61 Plan 29: Ask to join commands Summary

**Ask to join now works end to end across two windows:**

1. A person runs "Ask to Join a Team" and copies a signed request.
2. The owner pastes it into Members and chooses "Accept a request", checking the code with the person first.
3. The person's computer joins by itself on its next sync.
4. The computer that accepted confirms them by itself in the role it chose. It sends their capped team key when it already keeps a NEAR AI sign-in. Without one, it leaves Send key with one plain notice and never shows a sign-in prompt.

## Performance

- **Duration:** about 21 min
- **Started:** 2026-11-04T21:14:30Z
- **Completed:** 2026-11-04T21:35:00Z
- **Tasks:** 3
- **Files modified:** 9 (1 created)

## Accomplishments

- `memberCommands.ts`
  - `ASK_TO_JOIN_COMMAND`. It asks the name (filled in from git) and an optional email, then shows the request once in a modal. The modal has Copy request, the check code and one plain paragraph.
  - Asking again shows the same request with Copy request and Cancel my request. Cancel asks once.
  - A copy without team.json is brought up to date first. With no team online, no folder open, or local changes, it says so plainly. The local-changes case offers Get a fresh copy.
  - With `{ complete: true }` it runs `completeJoinRequest`, restarts the session and says "You are on <team> now." with the next step. An expired or cancelled request gets a non-blocking warning with Ask again.
- Members gains "Accept a request" after "Invite someone".
  - It refuses a request for another team or one already accepted, with nothing written.
  - It shows "Accept <name>'s request to join <team>?" with the email, the check code and the reminder.
  - It then asks for the email (only when the request has none), the role, the allowance and the lifetime, using the same helpers as Invite.
  - It accepts through `acceptJoinRequest`.
- The confirm action takes `auto: true`. It checks `wasAcceptedHere` again, never prompts, uses only a kept NEAR AI session, and says one sentence.
- `teamSession.ts`
  - Automatic completion on a computer with no device key.
  - Automatic confirm on the accepting computer, once per join.
  - `onKeyInstalled`.
  - A `started` guard, so an automatic command never waits on the start that is running it.
- `teamCommands.ts`
  - `TeamModeHandle.joinRequestPending()`.
  - A test-only `now` option.
  - The session now gets the same NEAR AI address and fetch as the commands.
- `package.json` contributes `nearAi.team.askToJoin` "Ask to Join a Team" (NEAR AI, `$(comment-discussion)`).

## Task Commits

1. **Task 1 (tracer) RED:** `09a8e46` test(61-29): a person asks in one window, the owner accepts in Members, the first window joins by itself (RED)
2. **Task 1 GREEN:** `d796826` feat(61-29): ask to join, accept a request in Members, and join by itself on the next sync (GREEN)
3. **Task 2 RED:** `984e31c` test(61-29): the accepting computer confirms by itself and sends the key when it can; expired and cancelled requests (RED)
4. **Task 2 GREEN:** `60cb85a` feat(61-29): the accepting computer confirms by itself and sends the team key when it can (GREEN)
5. **Task 3 RED:** `27b358c` test(61-29): show or cancel a waiting request, the waiting flag, a behind copy, the contribution and privacy (RED)
6. **Task 3 GREEN:** `8eb0816` feat(61-29): Ask to Join a Team in the command list and a waiting flag for the sidebar (GREEN)

No REFACTOR commits were needed.

## TDD Gate Compliance

**Task 1 RED**
- Run: `node --test --test-reporter=tap --test-name-pattern=^tracer dist/test/teamAskToJoin.test.js`, exit 1.
- The target tracer test failed on "nearAi.team.askToJoin is registered" (expected true, actual false).
- Classifier: RED_EVIDENCE_OK (target_test_failed).
- Semantic assessment: the test compiled and ran. It failed on the planned behaviour (the command did not exist yet), not on a load or fixture fault.

**Tracer gate (auto mode)**
- The Task 1 verify was re-run end to end, together with teamMemberCommands and teamSessionMembers: 74 tests, 74 pass.
- Expansion continued.

**Task 2 RED**
- Target: "the computer that accepted a request confirms that person by itself...". It failed with "timed out waiting for the confirmation" (pendingRole stayed developer).
- Classifier: RED_EVIDENCE_OK.
- The tests for the signed-in key, the not-signed-in notice and the accepting-computer half of the third-computer test also failed on their planned assertions. The third-computer test's waiting notice on Lee's computer already passed.
- The expired and cancelled tests passed at RED. Task 1's completion already handled them, so they are kept as regression guards.
- `onKeyInstalled` was declared but did not fire at RED.

**Task 3 RED**
- Target: "asking again shows the same request...". It failed on "a request waits" (false !== true), because `joinRequestPending` was declared on the handle but always returned false.
- Classifier: RED_EVIDENCE_OK.
- The manifest tests failed on the missing contribution.
- These tests passed at RED, because Task 1 had already built them: show again, cancel, the behind-copy catch-up, no folder, no team online, local changes and privacy.

## Verification

- Task 1 verify (`tsc`, teamAskToJoin, teamJoinRequest), plus teamMemberCommands and teamSessionMembers: exit 0, 74 tests, 74 pass.
- Task 2 verify (teamAskToJoin, teamSessionMembers, teamConfirm, teamMemberCommands), plus teamSession: exit 0, 115 tests, 115 pass.
- Task 3 verify (teamAskToJoin, teamManifest, teamSoloParity, teamPlainLanguage, teamCommands), plus teamPrompts and teamSectionHost: exit 0, 95 tests, 95 pass.
- Full `npm test`, run with MemoryMax=6G and choom, with nothing else running and 7 GB free: exit 0. 2022 tests: 2011 pass, 0 fail, 11 skipped (the existing skips). The load-sensitive turnEfficiency test passed in this run.
- Acceptance greps all match:
  - `nearAi.team.askToJoin` in memberCommands.ts and in package.json.
  - `Accept a request` in memberCommands.ts (count 3).
  - `onKeyInstalled` in teamSession.ts.
  - `joinRequestPending` in teamCommands.ts.

## Decisions Made

See key-decisions.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The session did not get the window's NEAR AI address**
- **Found during:** Task 2
- **Issue:** `registerTeamMode`'s `nearBaseUrl` and `fetch` reached the commands but not `createVscodeTeamSession`. The session checked a delivered key against the public NEAR AI address, so the install failed with "NEAR AI did not accept this team key".
- **Fix:** The slot passes `nearBaseUrl` and `fetch` as session overrides, and the overrides type now allows them. Production passes neither, so behaviour there is unchanged.
- **Files modified:** src/services/team/teamCommands.ts, src/services/team/teamSession.ts
- **Commit:** 60cb85a

**2. [Rule 1 - Correctness] An automatic step must not wait on the start that runs it**
- **Found during:** Task 1 design
- **Issue:** `TeamSession.start` waits for its first sync, and the slot's start waits for `TeamSession.start`. An automatic command run inside that first sync needs the session, and the completion also restarts it. That would deadlock on the slot's start in flight.
- **Fix:** A `started` flag. During the first sync an automatic step is only noted, nothing is marked as shown, and start() nudges one sync afterwards.
- **Commit:** d796826

**3. [Rule 3 - Blocking] Tests that pin the Members rows and the handle shape**
- `teamMemberCommands.test.ts` now expects "Accept a request" after "Invite someone". This is the intended change, and the read-only check was made stricter: no Accept row for a non-manager.
- `teamSectionHost.test.ts`'s fake handles gain `joinRequestPending`.
- **Commits:** d796826, 27b358c

**4. [Rule 2 - Security] Auto confirm is checked twice**
- The command checks `wasAcceptedHere` again, and still requires the manager permission, before it confirms (T-61-115).
- A call with `auto` that fails either check only writes a line to the channel.
- **Commit:** 60cb85a

---

**Total deviations:** 4 auto-fixed (2 blocking, 1 correctness, 1 security)
**Impact on plan:** All of them are in the plan's files or their direct tests. None adds new surface.

## Issues Encountered

- One test setup (the no-team-online and local-changes test) first set up its team on a clone that had a local-path remote, so the core share refused it. That was a test setup error, fixed by giving that clone the public-looking address that the other tests use.

## Known Limitations

- A 'failed' completion, such as a conflict or a key mismatch, is tried again and reported at most every five minutes while the window is open. Running Ask to Join by hand runs the completion at once.
- On a freshly opened window whose request was already accepted, the join runs on the sync that start() nudges right after the first one, not inside the first sync.

## User Setup Required

None.

## Next Phase Readiness

61-30 can use `handle.joinRequestPending()` for Ask to join and Show my request, and `session.onKeyInstalled()` to refresh the profile. It can run `nearAi.team.askToJoin` from the Connect screen and the Team section.

## Self-Check: PASSED

- FOUND: src/test/teamAskToJoin.test.ts, src/services/team/memberCommands.ts, src/services/team/teamSession.ts, src/services/team/teamCommands.ts, package.json
- FOUND commits: 09a8e46, d796826, 984e31c, 60cb85a, 27b358c, 8eb0816 (all ancestors of HEAD)
