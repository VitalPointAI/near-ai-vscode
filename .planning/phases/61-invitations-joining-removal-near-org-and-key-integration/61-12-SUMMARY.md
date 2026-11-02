---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 12
subsystem: team-session
tags: [team-session, status-bar, notifications, key-install, own-removal, join-offer, key-scope, spend-ledger, tdd]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-04 NearSession and the team key profile; 61-05 memberAttention; 61-09 NO_ORG_NOTICE; 61-10 installDeliveredKey; 61-11 handleOwnRemoval, readRemovedMarker, removedText"
provides:
  - src/services/team/teamSession.ts - member lifecycle reactions after each trusted sync (lead notices, key install, own removal, Join offer, personal-key warning), JOIN_COMMAND, MANAGE_MEMBERS_COMMAND, NOTIFIED_FILE, the new deps and the accessors currentLog, memberId, isRemoved, storageDir, state
  - src/services/team/teamStatusBar.ts - REMOVED_TEXT, TeamStatusExtras, displayText (flat, bounded, escaped), pending count, NEAR tooltip line
  - keyScope ('team' | 'personal') on SpendTag, the ledger record, the NearAiClient spend tag, createNearAiProvider and activeProvider
affects: [61-13, 61-14, 66]

plan_head_before: 4d6c035
plan_head_after: 2cb7510b5b048326db668d8083f435c46ec81d3b
actuals:
  tokens: 14573
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "reactions run after the existing sync steps, only on a log that was read and is not refused, and never throw out of syncOnce"
    - "a message is remembered by the event that caused it (ids only, notified.json) so it is shown once across syncs and reloads"
    - "the removed flag is set before any await and the scheduler is stopped first, so nothing re-enters; removed.json makes a reload start stopped"
    - "an optional tag with no default: solo ledger lines carry no new field"

key-files:
  created:
    - src/test/teamSessionMembers.test.ts
    - src/test/teamKeyScope.test.ts
  modified:
    - src/services/team/teamSession.ts
    - src/services/team/teamStatusBar.ts
    - src/services/spendLedger.ts
    - src/services/providerFactory.ts
    - src/services/providerCache.ts
    - src/services/nearAiClient.ts

key-decisions:
  - "The notification buttons call deps.runCommand(MANAGE_MEMBERS_COMMAND, {memberId, action}) with action 'confirm' | 'remove' | 'deliver-key' | 'rotate-key' (the memberAttention kinds plus remove); 61-13 registers the command and reads those names"
  - "notified.json keys are confirm:<joinEvent>, deliver-key:<member>:<keyEvent or joinEvent>, rotate-key:<member>:<keyEvent or joinEvent> and join-offer; it holds ids only, no names or emails"
  - "The Join offer is made only when deps.runCommand is supplied (the real editor always supplies it), so existing sessions built without it behave exactly as before"
  - "After a failed key install the same key is not tried again for 5 minutes, so a wrong organization cannot stall every poll with the activation retries"
  - "keyScope is decided when a provider entry is built, not on every call: a team.json created later is noticed after the profile or key next changes"
  - "A removed window keeps the clean-up in memory even if it threw: removed.json is only written by handleOwnRemoval, so a reload retries the clean-up"

requirements-completed: []  # TEAM-02 and TEAM-03 are ticked by the final plan of the phase, as instructed

coverage:
  - id: D1
    description: "A sync that brings in a member waiting for confirmation shows '<name> joined <team> and is waiting for confirmation' with Confirm and Remove on the owner's or lead's window, once per join event across syncs and reloads; Send key and Rotate key work the same way"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamSessionMembers.test.js#tracer: a developer joins from another clone...; #the same join is announced once...; #a confirmed member with no key yet is announced once with Send key..."
        status: pass
    human_judgment: false
  - id: D2
    description: "The status bar shows 'Team: Alpha (N pending)' and a tooltip line 'NEAR: signed in as <account>' or the no-organization notice; a developer's own window shows neither a count nor a confirmation notice"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamSessionMembers.test.js#status text...; #the NEAR line of the tooltip...; #a developer own window shows no pending count..."
        status: pass
    human_judgment: false
  - id: D3
    description: "A member window installs a delivered key as the project's team key and says so once; a key that cannot be opened is reported once with its reason in the channel and as a warning"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamSessionMembers.test.js#after the owner confirms and delivers...; #a key that cannot be opened is reported once..."
        status: pass
    human_judgment: false
  - id: D4
    description: "The removed member's own window runs the clean-up once, stops the scheduler, shows 'You were removed from <team>' and a removed state, makes no git call afterwards, and stays that way after a reload"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamSessionMembers.test.js#the removed member window cleans up once...; #after a reload the removed marker keeps the window in the removed state..."
        status: pass
    human_judgment: false
  - id: D5
    description: "A clone with no device key for the team is offered Join once per storage folder; the button runs the Join command"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamSessionMembers.test.js#a clone with no device key for the team is offered Join once...; #a window that has its device key is not offered Join"
        status: pass
    human_judgment: false
  - id: D6
    description: "Requests with a team key profile are tagged keyScope team, requests in a team project with another profile are tagged personal, solo projects get no tag and no new field on disk; a member on a personal key is warned once with a Use team key button"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamKeyScope.test.js (3 tests); dist/test/teamSessionMembers.test.js#a member on a personal key in a team project is warned once...; #a window with no installed team key, and the owner window, get no personal-key warning"
        status: pass
      - kind: regression
        ref: "dist/test/spendLedger.test.js, dist/test/teamSoloParity.test.js, dist/test/teamSession.test.js unchanged and passing"
        status: pass
    human_judgment: false
---

# Phase 61 Plan 12: The running session reacts to membership Summary

**TeamSession now tells leads who is waiting (once, with buttons and a pending count), installs the key a member was sent, stops and cleans up when its own member is removed, offers Join on a clone that is not in the team, and tags every run as team-key or personal-key with a one-time warning.**

## Performance

- **Duration:** about 40 min (start time was not recorded)
- **Completed:** 2026-11-02T02:56:00Z (approx.)
- **Tasks:** 3 (one tracer, two TDD tasks)
- **Files modified:** 8 (2 created)

## Accomplishments

- Tracer: a developer joins from another clone; the owner's window shows "Dana Developer joined Alpha and is waiting for confirmation" with Confirm and Remove, choosing Confirm runs `nearAi.team.manageMembers` with `{memberId, action: 'confirm'}`, and the status bar reads "Team: Alpha (1 pending)". A second sync and a brand new session on the same storage stay quiet; `notified.json` holds the join event id and no name or email. Tracer gate: the verify command was re-run end to end and passed before any expansion.
- Confirmed members with no key get "Send key", members whose devices changed get "Rotate key" (NEAR-linked teams only), each once per key event.
- `statusText` takes extras: `(N pending)`, `REMOVED_TEXT` with the `removedText` tooltip, and a tooltip line "NEAR: signed in as <label>" or the no-organization notice. `displayText` flattens, bounds (60 characters) and escapes `$(` for every member name, team name and NEAR label shown.
- Member window: `installDeliveredKey` runs after each trusted sync; success says "Your team key for Alpha is ready. NEAR AI uses it for this project now." once; a failure is one output line and one warning with the reason, not retried for 5 minutes.
- Own removal: the session finds its device in `deviceIndex`, sees the member's `removedEvent`, stops the scheduler, runs `handleOwnRemoval` once, warns "You were removed from <team>..." and shows "Team: removed". Afterwards `sync()`, `nudge()` and focus changes make no git call and arm no timer (asserted by a counting git runner). A reload with `removed.json` starts in that state without a pin check, timer or git call.
- Join offer: a session with no device key (and no unreadable-key problem) offers "Join Team" once per storage folder.
- keyScope: `SpendTag.keyScope`, a compact `ks` field in the ledger line (written only when set), the client's spend tag, `createNearAiProvider({keyScope})` and the decision in `activeProvider`. A member whose team key is installed but who has another profile selected is warned once per session with "Use team key", which selects the team profile.

## Task Commits

1. **Task 1 (tracer): lead notice and pending count** - `6c6e3a4` (test, RED), `24fe8d5` (feat, GREEN)
2. **Task 2: key install, own removal, removed state, Join offer** - `ef265b3` (test, RED), `029c1b2` (feat, GREEN)
3. **Task 3: key scope tagging and personal-key warning** - `b7b1d30` (test, RED), `2cb7510` (feat, GREEN)

**Plan metadata:** committed with this SUMMARY (docs: complete plan).

## TDD Gate Compliance

Every task has a `test(61-12)` commit followed by a `feat(61-12)` commit. Each RED commit also carries compile-clean placeholders (exports, optional fields, accessors) so the tests failed on their planned assertions and not on the build.

RED evidence (semantic assessment): Task 1 failed 6 of 7 tests on the missing notification, missing "(N pending)" text and missing NEAR tooltip line (the seventh, the developer-window negative, correctly passes already). Task 2 failed 5 tests on the missing "key is ready" message, the missing warning for an unopenable key, the team profile not installed (the precondition of the removal tests), and the missing Join offer. Task 3 failed the "team" tag and the personal-key warning assertions (`actual: undefined`); the solo-parity test passes before and after by design. The `gsd_run check tdd-red-evidence` classifier was NOT run; the assessment above is from reading the node:test failure output, so treat the RED evidence as semantic only.

## Files Created/Modified

- `src/services/team/teamSession.ts` - reactions, notified store, install, removal, Join offer, personal-key warning, accessors, real-editor `runCommand`
- `src/services/team/teamStatusBar.ts` - extras, `displayText`, removed state and tooltip
- `src/services/spendLedger.ts` - `KeyScope`, `SpendTag.keyScope`, `ks` record field
- `src/services/providerFactory.ts`, `src/services/providerCache.ts`, `src/services/nearAiClient.ts` - the tag carried from the profile decision to the client
- `src/test/teamSessionMembers.test.ts` - 15 tests on real git, the fake NEAR server and the vscode stub
- `src/test/teamKeyScope.test.ts` - 3 tests on the ledger and providers

## Decisions Made

See `key-decisions` above.

## Deviations from Plan

### Interpretations of the plan text

- **Newline in a member name:** the log validator refuses control characters in names, so a name with a real newline can never reach the window. The end-to-end test uses a name with `$(zap)` (accepted by the log); the newline and length cases are covered on `statusText` and its NEAR label, which is also untrusted text. `displayText` flattens both anyway.
- **Fixture:** the join in the tracer is built with the same low-level log appends as the 61-10/61-11 tests (`member.invited`, `appendJoin`) instead of `inviteMember`/`joinTeam`, because they give the same log with less setup.
- **Where tests live:** the personal-key warning test (a TeamSession behaviour) is in `teamSessionMembers.test.ts`, which already has the session rig; `teamKeyScope.test.ts` holds the tagging and solo-parity tests.
- **Pending count:** counts members waiting for confirmation only (`kind: 'confirm'`); Send key and Rotate key have their own notifications.
- **Phase 60 teams:** a team whose `team.json` has no `near` now shows "No NEAR organization linked: spend is not capped at the provider." in the status bar tooltip (the plan's wording of D-04); existing Phase 60 tooltip assertions in `teamSession.test.ts` still pass unchanged.

### Auto-fixed Issues

None - plan executed as written, apart from the interpretations above. One test assertion of mine (the escaped `$(` check) was wrong in the first draft and was corrected in the same task before its GREEN commit.

## Issues Encountered

None that blocked work. A full run of all compiled tests (`dist/test/*.test.js`) gave 1169 tests, 1161 pass, 0 fail (the rest are skipped live tests), run because `providerCache`, `spendLedger` and the client are shared with solo mode.

## Authentication Gates

None.

## Known Stubs

None.

## Threat Flags

None. The one new local file, `notified.json`, sits in the team's own storage folder and holds event and member ids only. T-61-53 (names flattened, bounded, `$(` escaped), T-61-54 (cleanup only from an accepted `member.removed` for this device's member, read from the materialised state of a non-refused log), T-61-55 (scheduler stopped, marker persisted, no git call afterwards, asserted) and T-61-56 (keyScope tag plus the one-time warning) are covered by tests.

## Verification

- `npm run lint` exits 0.
- `node --test dist/test/team*.test.js dist/test/spendLedger.test.js`: 603 tests, 0 failed.
- All `dist/test/*.test.js`: 1169 tests, 0 failed.
- Acceptance greps: `is waiting for confirmation`, `memberAttention(`, `handleOwnRemoval(`, `installDeliveredKey(`, `readRemovedMarker(` and `personal NEAR key` in `teamSession.ts`; `pending)` in `teamStatusBar.ts`; `keyScope` in `spendLedger.ts`, `providerFactory.ts` and `providerCache.ts`; no em-dash in the changed files.
- `teamSession.test.ts`, `teamSoloParity.test.ts` and `spendLedger.test.ts` are unchanged and pass. No package installs; `package.json` unchanged. `.planning/config.json` and `.planning/state.json` pre-existing modifications left alone. TEAM-02 and TEAM-03 not ticked.

## Next Phase Readiness

61-13 registers `nearAi.team.manageMembers` and reads the argument `{memberId, action}` with action `confirm`, `remove`, `deliver-key` or `rotate-key` (from the notification buttons); `nearAi.team.join` is run with no argument from the Join offer. `createVscodeTeamSession` already passes `runCommand` as `vscode.commands.executeCommand`. The session exposes `currentLog()`, `memberId()`, `isRemoved()`, `storageDir()` and `state()` for the command handlers. Items of kind send-invitation, deliver-key and rotate-key from `retryCleanupItem` still need routing to `invite.ts` and `keyDelivery.ts` there, and `RemoveResult.message` should be shown as written.

## Self-Check: PASSED

- Files: `src/test/teamSessionMembers.test.ts`, `src/test/teamKeyScope.test.ts` present; modified source files present.
- Commits `6c6e3a4`, `24fe8d5`, `ef265b3`, `029c1b2`, `b7b1d30`, `2cb7510` are ancestors of HEAD.
