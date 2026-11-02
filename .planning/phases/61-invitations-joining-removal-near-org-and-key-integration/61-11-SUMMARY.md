---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 11
subsystem: team-core
tags: [removal, cancel-invitation, spend-limit, cleanup-checklist, near-org, secret-storage, tdd]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-02 NearOrgClient and the fake NEAR server; 61-04 NEAR session and removeTeamKey; 61-05 Member.nearApiKeyId and retiredNearKeyIds; 61-06 member.removed release; 61-07 CleanupChecklist; 61-10 keys delivered by the log"
provides:
  - src/team/remove.ts - removeMember (removal and invitation cancel) and retryCleanupItem, with the ordered NEAR steps, KEY_STILL_SPENDS_WARNING and the closing repository-access reminder
  - src/team/removedClient.ts - handleOwnRemoval, readRemovedMarker, removedText, REMOVED_FILE (the removed member's own machine)
  - TeamLog.signerMemberId() so callers can ask the permission question before any NEAR call
affects: [61-12, 61-13, 61-14, 66]

plan_head_before: e15c7ae8ede6a5fda434e6d2176e6874f4ca164b
plan_head_after: a065e3808c24ec96e4a03ec6ea9a769b8110a3ae
actuals:
  tokens: 19250
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "permission question asked before any irreversible-looking outside call (cap a key), not only at the log append"
    - "a step list that keeps finished and unfinished steps when anything is left, and only the closing reminder when everything finished"
    - "a NEAR match by email hash only; no email from NEAR means a manual item, never a guess"
    - "fail-closed marker read: a damaged removed.json still means removed"

key-files:
  created:
    - src/team/remove.ts
    - src/team/removedClient.ts
    - src/test/teamRemove.test.ts
  modified:
    - src/team/eventLog.ts

key-decisions:
  - "removeMember asks decideTeamAction for member.remove (and refuses self-removal) before the first NEAR call, so a caller who may not remove anyone can never cap a key through this flow"
  - "Finished NEAR steps are written to cleanup.json as done items only when some step is unfinished; a fully successful removal leaves just the repo-access reminder, a partly failed one keeps the whole story"
  - "A race loser records zero-limit done for the keys it capped and queues nothing else; the winner owns the revoke"
  - "Cancelling a lead invitation whose NEAR send is still on the list (never sent) makes no NEAR call and settles that send item; with no pending NEAR invitation found it falls back to the organization-member match (the invitee may have accepted) and otherwise leaves a manual item"
  - "handleOwnRemoval never stops at one failed step; it reports failed steps by name and still writes removed.json last"

requirements-completed: []  # TEAM-03 is only partly delivered here; Manage Team Members wiring (61-12/13) and the owner-visible flows finish it, so REQUIREMENTS.md was left unticked as instructed

coverage:
  - id: D1
    description: "Removal caps every delivered key at 0 first, writes member.removed, then revokes; the removed member's clone can no longer write; the only list item is the repository-access reminder, last"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamRemove.test.js#tracer: the owner removes a confirmed developer; NEAR sees limit 0, then the log removal, then the revoke"
        status: pass
    human_judgment: false
  - id: D2
    description: "A key that cannot be capped is never revoked, the log removal still lands, the lead gets the plain warning, and zero-limit/revoke-key items are queued with Retry; with no NEAR session the same items are pending"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamRemove.test.js#a key that cannot be capped still lets the log removal through...; #a NEAR-linked team with no NEAR session..."
        status: pass
    human_judgment: false
  - id: D3
    description: "Retry caps before it revokes, refuses a revoke while the cap is open, treats a key NEAR no longer has as done; current and retired keys are all capped and revoked; an interrupted removal keeps finished and unfinished steps"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamRemove.test.js#retrying the cleanup items caps first...; #a member whose key was replaced by a rotation..."
        status: pass
    human_judgment: false
  - id: D4
    description: "A lead leaves the NEAR organization, matched by email hash, never an owner or the remover; with no email from NEAR (the real server) a manual item names the lead and says to use the NEAR console; a refused call is a failed item that retry finishes"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamRemove.test.js#removing a confirmed lead...; #a lead who was invited as lead...; #the organization member is never an owner or the remover...; #NEAR does not return member emails...; #a refused organization removal..."
        status: pass
    human_judgment: false
  - id: D5
    description: "Cancelling an invitation writes member.removed for the invited id, cancels a lead's pending NEAR invitation by email hash, and queues pending or manual items when it cannot"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamRemove.test.js#cancelling an invitation writes member.removed...; #cancelling a lead invitation without a NEAR session..."
        status: pass
    human_judgment: false
  - id: D6
    description: "A repeated removal is refused locally with no NEAR call; a caller who may not remove (developer, owner target, self) caps nothing; two leads removing at once leave exactly one member.removed and the key capped and revoked"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamRemove.test.js#removing someone who was already removed...; #nothing is capped when the caller may not remove...; #two leads removing the same member at once..."
        status: pass
    human_judgment: false
  - id: D7
    description: "The removed member's machine deletes only this team's device key, seal key, NEAR session and team key profile, reselects the personal profile, writes removed.json, and leaves HEAD, branches, stash, working tree and other secrets untouched"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamRemove.test.js#a removed member machine forgets exactly this team secrets...; #the NEAR session is signed out...; #running the removal twice is harmless...; #the removal code makes no git call..."
        status: pass
    human_judgment: false
---

# Phase 61 Plan 11: Removal, Cancel and the Removed Member's Cleanup Summary

**Removing a member caps every NEAR key they were ever given at 0, writes member.removed, then revokes, queues anything NEAR could not do on a retryable cleanup list ending with the repository-access reminder, and cleans only this team's secrets from the removed member's own machine.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-11-02T02:28:00Z (approx.)
- **Completed:** 2026-11-02T02:41:00Z (approx.)
- **Tasks:** 3 (one tracer, two TDD tasks)
- **Files modified:** 4 (3 created, `src/team/eventLog.ts` modified)

## Accomplishments

- `removeMember` runs the order the owner asked for: permission check, cap every delivered key (current and retired) at 0, `member.removed`, revoke each capped key, a lead leaves the NEAR organization, then the repository-access reminder as the last list item. The tracer proves the order two ways: a fetch spy stamps each NEAR call with whether the lead's own log already shows the removal, and the fake's request log shows the spend-limit PATCH before the key DELETE.
- A failure never blocks the log removal and never revokes an uncapped key. When a cap fails the result says `keyStillSpends` and the message carries the plain warning (`KEY_STILL_SPENDS_WARNING`); zero-limit and revoke-key items are queued (failed and pending, or both pending with no NEAR session).
- `retryCleanupItem` dispatches on zero-limit, revoke-key, remove-org-member and cancel-invitation, refuses a revoke while the cap for that key is open, treats a key NEAR no longer has as done, never finishes the repository reminder, and answers send-invitation, deliver-key and rotate-key unchanged with a `Manage Team Members` pointer.
- Cancelling an invitation writes `member.removed` for the invited id; a lead invitee's pending NEAR invitation is found by email hash and cancelled.
- Two leads removing the same member at once: exactly one `member.removed` is in the log, the other gets a conflict or `referenced member was removed`, and the key still ends capped and revoked.
- `handleOwnRemoval` deletes only this team's device key, seal key, NEAR session (signed out at NEAR when possible, deleted either way) and team key profile, reselects the personal profile, and writes `removed.json` (member id and removal event only). A test compares HEAD, branches, stash, `git status` and file contents before and after.

## Task Commits

1. **Task 1: Tracer, the owner removes a confirmed developer** - `3c3a475` (test, RED), `bdfab88` (feat, GREEN)
2. **Task 2: Failures, retries, lead org removal, cancel, idempotency, races** - `36ab4f2` (test, RED), `616975a` (feat, GREEN)
3. **Task 3: The removed member's own machine** - `263b9b4` (test, RED), `a065e38` (feat, GREEN)

**Plan metadata:** committed with this SUMMARY (docs: complete plan).

RED evidence: each test commit failed on its planned assertions against a compile-clean placeholder (`not implemented` for Task 1, the Task 1 implementation for Task 2, an empty `handleOwnRemoval` for Task 3), not on build or setup faults. Tests were also mutation-checked on the compiled output (owner guard removed, cap-before-revoke guard removed); both made tests fail.

## Files Created/Modified

- `src/team/remove.ts` - `removeMember`, `retryCleanupItem`, `RemoveResult`, `KEY_STILL_SPENDS_WARNING` (with a `keyStillSpendsWarning(name)` helper)
- `src/team/removedClient.ts` - `handleOwnRemoval`, `readRemovedMarker`, `removedText`, `REMOVED_FILE`
- `src/test/teamRemove.test.ts` - 20 tests over real git and the fake NEAR server
- `src/team/eventLog.ts` - one added method, `TeamLog.signerMemberId()`

## Decisions Made

See `key-decisions` above. Additional notes for the owner:

- A cancelled invitation gets no repository-access reminder (the reminder's wording is about a client that has seen the removal, which a never-joined invitee does not have). If you want one for invitees who were already given repository access to clone, it is a one-line addition.
- `handleOwnRemoval`'s result gained an optional `failed` list (step names only). The plan's two fields are unchanged.
- A damaged `removed.json` reads as removed with placeholder values (`unreadable`), so a caller that only tests for `undefined` fails closed.

## Deviations from Plan

### Known issue from 61-02: NEAR returns no member email (handled as the owner instructed)

NEAR's `GET /organizations/{org}/members` returns no email for members. I checked the real shapes before implementing step 4: `NearOrgClient.listMembers` reads an email only from `member.user.email` or `member.email` when the server supplies one, and the research NEAR contract table lists only `user.id` and `role` for members; `GET /users/me` returns the caller's own email only. No other NEAR route exposes another member's email.

- **Outcome:** the lead's organization member is matched by `emailHash(teamId, email)` against the member's `emailHashes` when NEAR gives an email, and never by a NEAR user id from the log. When no email is available (the real server's behaviour, tested with `membersIncludeEmail` off) nobody is removed, no organization DELETE is sent, and a `remove-org-member` item with status `manual` is added whose text names the lead and says to remove them in the NEAR console (for example: "Remove Lena Lead from the NEAR organization in the NEAR console. Their email address could not be matched to an organization member here."). The removal message repeats it. A match that is an organization owner or the remover is also never removed and becomes the same kind of manual item; more than one match is manual too.
- **Owner-visible consequence:** with today's NEAR API, removing a lead will always leave one manual "remove them in the NEAR console" step. The code removes the member automatically the moment NEAR starts returning member emails. Same applies to cancelling a lead's invitation after they already accepted it.
- **Tests:** `NEAR does not return member emails (the real server)...` (membersIncludeEmail off), plus the email-present, owner, remover and 403 cases.

### Auto-fixed / added issues

**1. [Rule 2 - Missing critical functionality] Permission question before any NEAR call**
- **Found during:** Task 1
- **Issue:** The plan caps keys first and only then appends `member.removed`. A caller who may not remove anyone (a developer, or any caller targeting the owner) would have their request refused at the append, but only after keys were already capped.
- **Fix:** `removeMember` asks `decideTeamAction(member.remove)` first, refuses removing yourself, and refuses when there is no device key. This needed the signer's member id, so `TeamLog.signerMemberId()` was added (not in the plan's `files_modified`).
- **Files modified:** `src/team/remove.ts`, `src/team/eventLog.ts`
- **Verification:** `nothing is capped when the caller may not remove the person` asserts no NEAR request for a developer caller, the owner as target, and self-removal.
- **Committed in:** `bdfab88`

**2. [Rule 2 - Missing critical functionality] Cancel settles a never-sent NEAR invitation and falls back to the member match**
- **Found during:** Task 2
- **Issue:** Cancelling a lead invitation whose NEAR send was still on the checklist would have left that send item open (and retryable, which would invite a cancelled person), or reported a missing NEAR invitation as a problem. If the invitee had already accepted, only the pending-invitation lookup would have missed them.
- **Fix:** A lead cancel with an open `send-invitation` item makes no NEAR call and marks that item done; with no pending NEAR invitation it tries the organization match (same safe rules) before leaving a manual `cancel-invitation` item.
- **Files modified:** `src/team/remove.ts`
- **Committed in:** `616975a`

### Interpretations of the plan text

- "An interrupted removal keeps every finished and unfinished step in cleanup.json": implemented as the whole step list (finished as `done`, unfinished as `failed`/`pending`/`manual`) being saved whenever any step is unfinished. When every NEAR step finished, only the repo-access reminder is saved (the plan's tracer requires exactly one item).
- "The loser's checklist records what it did": the race loser records `zero-limit` done for the keys it capped and queues nothing else; its message is the log's `referenced member was removed` reason.

---

**Total deviations:** 2 auto-added (Rule 2), 1 known-issue outcome recorded, 2 interpretations.
**Impact on plan:** Both Rule 2 additions are safety checks; no scope creep. No architectural change.

## Issues Encountered

- The first shell attempt to write the Task 3 test failed the near-key guard hook because the command text contained the test's assertion about the NEAR key folder alongside delete words. Nothing ran. I wrote the files with the Write and Edit tools instead and did not touch the hook or any key.
- The Task 1 RED commit message has a typo ("member.member.removed"); history was left as committed.

## Authentication Gates

None.

## Known Stubs

None. (The placeholder `remove.ts` and `removedClient.ts` used for the RED commits were replaced in the matching GREEN commits.)

## Threat Flags

None. No new network endpoint, auth path or trust-boundary file access beyond the plan's threat model. T-61-47 (cap first, warning, Retry), T-61-48 (email-hash match, owners and remover protected, manual fallback), T-61-49 (log removal always written, NEAR steps queued), T-61-50 (only named SecretStorage entries and team storage, no git calls, tests compare git state and other secrets) are covered by tests.

## Verification

- `npm run lint` exits 0.
- `node --test dist/test/teamRemove.test.js dist/test/teamRelease.test.js dist/test/teamKeySealedEvent.test.js`: 36 tests, 0 failed.
- All `dist/test/team*.test.js`: 575 tests, 0 failed (run because `eventLog.ts` gained a method).
- Acceptance greps: `setSpendLimit(` and `revokeKey(` in remove.ts, `emailHash(` in remove.ts, no `nearUserId` in remove.ts, no `vscode` import, no `runGit|GitRunner|'git'` in removedClient.ts, zero code lines naming the NEAR key folder, `removeTeamKey(` and `forgetDeviceIdentity(` in removedClient.ts, `^test(` count 20 (at least 9).
- No package installs; `package.json` unchanged. `.planning/config.json` and `.planning/state.json` pre-existing modifications left alone. TEAM-02 and TEAM-03 not ticked.

## Next Phase Readiness

61-12 can dispatch Manage Team Members to `removeMember` and `retryCleanupItem` (send-invitation, deliver-key and rotate-key items come back unchanged with a lastError pointing at Manage Team Members, so 61-12 must route those to `invite.ts` and `keyDelivery.ts`). 61-13 should call `handleOwnRemoval` when a client sees its own `member.removed` (pass `removedEvent` from the event id and `nearBaseUrl` when known), stop the scheduler, show `removedText(team name)` and use `readRemovedMarker` to short-circuit later activations. Show `RemoveResult.message` as written: it already carries the key-still-spends warning and the NEAR console instruction.

## Self-Check: PASSED

- Files: `src/team/remove.ts`, `src/team/removedClient.ts`, `src/test/teamRemove.test.ts` present.
- Commits `3c3a475`, `bdfab88`, `36ab4f2`, `616975a`, `263b9b4`, `a065e38` are ancestors of HEAD.
