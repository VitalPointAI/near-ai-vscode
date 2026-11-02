---
phase: 61-invitations-joining-removal-near-org-and-key-integration
fixed_at: 2026-11-02T04:47:13Z
review_path: .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-REVIEW.md
iteration: 1
findings_in_scope: 11
fixed: 11
skipped: 0
status: all_fixed
---

# Phase 61: Code Review Fix Report

**Fixed at:** 2026-11-02T04:47:13Z
**Source review:** .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-REVIEW.md, plus T-61-64 from 61-SECURITY.md and issues 1 and 2 from 61-UI-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 11 (CR-01, CR-02, WR-01 to WR-06, T-61-64, UI-REVIEW issues 1 and 2)
- Fixed: 11, one commit each
- Skipped: 0
- Deferred by the orchestrator: IN-01 to IN-05 and UI-REVIEW issues 3 to 10 (listed at the end)

**Verification (ran in the linked worktree `.claude/worktrees/team-mode`, on branch `gsd/phase-61-invitations-joining-removal-near-org-and-key-integration`, not in a nested review-fix worktree, as the orchestrator instructed):**
- After each fix: `npx tsc -p tsconfig.json`, `node --test` on the affected compiled test files, and `npm run lint` (`tsc -p tsconfig.json --noEmit`). All passed before each commit.
- Each new regression test was run against the code before its fix and failed. For CR-01 (delivery side), CR-02 (the Manage Team Members path) and UI issues 1 and 2, this was checked by putting the committed source back in place temporarily, recompiling, running the test, and restoring the fixed source. Nothing from these probes was committed.
- Final `npx tsc -p tsconfig.json && node --test dist/test/team*.test.js`: 651 tests, 649 pass, 0 fail, 0 cancelled, 2 skipped (the opt-in live NEAR test). Before this pass: 634 tests, 632 pass, 2 skipped. The 17 extra tests are the regression tests below.
- Final `npm run check` (lint, compile, full suite): exit 0. 1227 tests, 1217 pass, 0 fail, 0 cancelled, 10 skipped (the same environment skips as before).
- `src/domain/team/*` and `src/team/*` still import nothing from vscode. No package.json or package-lock.json change, and no new runtime dependency. No em-dash or en-dash in any new UI text.
- `.planning/config.json` and `.planning/state.json` were left uncommitted and untouched.

## Fixed Issues

### CR-01: A forged `team.json` `near.workspaceId` makes removal report keys as capped and revoked when they are not

**Files modified:** `src/team/teamFile.ts`, `src/team/cleanupChecklist.ts`, `src/team/remove.ts`, `src/team/keyDelivery.ts`, `src/team/nearLink.ts`, `src/team/join.ts`, `src/team/invite.ts`, `src/services/team/teamSession.ts`, `src/test/teamRemove.test.ts`, `src/test/teamConfirm.test.ts`, `src/test/teamFile.test.ts`, `src/test/teamNearLink.test.ts`, `61-SECURITY.md`
**Commit:** b6f002c
**Status:** fixed: requires human verification (security and money logic)
**Applied fix:**
- (a) A local, non-secret NEAR link pin. `teamFile.ts` `checkNearPin(storageDir, teamFile)` writes `near-pin.json` (team id, organization id, workspace id) beside `trust.json` the first time a linked team.json is seen. After that it throws `NearPinError` when team.json names a different link or drops a pinned one. `NearPinError` is a `TrustPinError`, so every existing pin catch handles it. Only the lead's Link command moves the pin (`pinNearLink`): on a new link, on a replace, and on re-picking the current link from NEAR's lists, which is how a lead confirms a link after a mismatch. The pin is recorded at link, at join, and at session start (a mismatch at session start is written to the channel and does not stop the session, so Link stays usable). It is checked before every NEAR key step: removal, cancel and retry (`remove.ts`), create, rotate and retire, and the member-side install expectation (`keyDelivery.ts`), and lead invitations (`invite.ts`). On a mismatch nothing is sent to NEAR. The step becomes a manual item with the reason, or the action is refused with the reason. **No signed event body changed.**
- (b) "Not found" is never done. `capKey` calls `setSpendLimit` directly (the `findKey` pre-check is gone). A `'missing'` answer, a pin mismatch, or a delivered key with no link this computer trusts becomes a `manual` cleanup item that says to find the key in the NEAR console and set its limit to 0. The KEY_STILL_SPENDS warning is shown, followed by the reason. Revoke and `retireKey` (rotation and abandoned keys) treat `'missing'` the same way.
- 61-SECURITY.md: the reviewer was right about `keyDelivery.ts:358` (`expect: input.teamFile.near`). T-61-32 is now `mitigate` with the evidence, and AR-61-05 is corrected and narrowed to the remaining first-sight risk (trust on first use).
**Regression tests:**
- teamRemove.test.ts 'CR-01: a team.json whose NEAR workspace differs from the one this computer pinned caps and revokes nothing there and warns that the key can still spend'
- teamRemove.test.ts 'CR-01: a key the linked workspace does not list is a manual item for the NEAR console, never a finished cap or revoke'
- teamConfirm.test.ts 'CR-01: a key is never created in, or installed from, a NEAR link that differs from the one this computer pinned'
- teamFile.test.ts 'CR-01: the NEAR link pin is taken on first sight of a linked team.json and refuses a changed or dropped link afterwards'
- teamNearLink.test.ts 'CR-01: linking pins the chosen NEAR link on this computer, replacing moves the pin, and an edited team.json is refused against it'

Two existing tests asserted the behaviour CR-01 removes. They now assert the new behaviour, and each checks more than before:
- teamRemove.test.ts 'retrying the cleanup items ... a key NEAR no longer has is a manual item (CR-01)': a revoke NEAR answers 404 is now `manual` with the NEAR console text, not `done`.
- teamConfirm.test.ts 'an old key NEAR no longer has ...': the rotation also leaves a manual `revoke-key` item for the old key.

### CR-02: Retrying a stale "send NEAR invitation" cleanup item invites a removed or superseded person to the paying NEAR organization as admin

**Files modified:** `src/team/invite.ts`, `src/team/remove.ts`, `src/team/cleanupChecklist.ts`, `src/services/team/memberCommands.ts`, `src/test/teamRemove.test.ts`, `src/test/teamMemberCommands.test.ts`
**Commit:** 7ad4569
**Status:** fixed: requires human verification (authorization logic)
**Applied fix:**
- New core `retryNearInvitation`, used by `memberCommands.ts` `retryItem`. Before any sign-in or NEAR call, the current log must show the person still `invited`, as lead, not removed, and on the same invite event that the local invites.json entry was recorded for. The team must also still be linked (pinned) to the organization the item was queued for. Otherwise the item is closed (`done`, with the reason) and NEAR is never called. The log is read again after the sign-in, so a removal written in the meantime still stops it.
- The queued item now records its `organizationId` (an optional field, validated, in `cleanupChecklist.ts`).
- `removeJoinedMember` and re-issue (the replaced member id) close every open `send-invitation` item through `closeInvitationSends`. Cancel already did this.
**Regression tests:**
- teamMemberCommands.test.ts 'CR-02: Retry of a NEAR invitation for a removed lead closes the item without signing in or inviting them, and Re-issue closes the old one'. It fails on the code before the fix.
- teamRemove.test.ts 'CR-02: removing a lead closes their unsent NEAR invitation, and a stale one is closed on Retry with no sign-in and no NEAR call'
- teamRemove.test.ts 'CR-02: a NEAR invitation is sent on Retry only to a lead still waiting on the same invitation, and never to another organization'

Changed existing test: 'Retry sends a NEAR invitation left on the cleanup list ...'. Its "Zed" item names someone who is not on the team list, so it is now closed instead of answered with the unknown-email text. The unknown-email case is still covered, with a real invited lead (Uma) whose invites.json entry is missing.

Note: following the orchestrator's rule ("still invited"), a lead who has already joined is not sent a NEAR invitation on Retry either. The item is closed with a sentence that says to invite them from the NEAR console.

### WR-01: A lost push answer makes `sendKey` revoke a key whose `member.key-sealed` event has already landed

**Files modified:** `src/team/keyDelivery.ts`, `src/test/teamConfirm.test.ts`
**Commit:** 6e32bc7
**Status:** fixed: requires human verification (new error path in the money flow)
**Applied fix:** Only definite failures abandon (zero, then revoke) the new key: refused, conflict, busy, exists, remote-rejected, paused, or a secret or device-key refusal before the push. An `offline` answer, or any other throw, counts as "maybe written", and `deliveryLanded` syncs the log:
- If the log shows the member's `nearApiKeyId` as this key, the delivery succeeds and the key is kept.
- If the log shows it absent, the key is abandoned as before.
- If the log cannot be read, the key is kept, a `manual` item names the key id, and the lead is told the outcome is unknown and what to check.
**Regression tests:**
- teamConfirm.test.ts 'WR-01: a key whose member.key-sealed landed although the push answer was lost is kept and reported as sent'
- teamConfirm.test.ts 'WR-01: when it cannot be told whether the delivery landed, the key is kept and a manual item names it; a delivery that did not land is revoked'

### WR-02: One unparseable key row in the workspace blocks the cap step of every removal and every rotation

**Files modified:** `src/team/nearOrg.ts`, `src/team/remove.ts`, `src/test/teamNearOrg.test.ts`
**Commit:** 60a8a0b
**Applied fix:**
- `findKey` matches the raw `id` and parses only that row, strictly.
- `removeKeysNamed` matches raw rows by name and revokes them by raw id.
- `listKeys` stays strict, because its callers need every row.
- `listOrganizations` leaves out organizations with a role this version does not know (only owner and admin can be linked anyway).
- `listMembers` keeps such members with role `'unknown'`, so an email match stays ambiguous rather than guessed, and removal never removes an `'unknown'` member automatically.
- The `findKey` pre-check in `capKey` was already removed in CR-01.
**Regression test:** teamNearOrg.test.ts 'WR-02: one unreadable row in a NEAR list never hides the key, organization or member that is wanted' (a console key with a EUR limit, a row with a non-boolean `is_active`, and an unknown role in both lists).

Changed existing test: 'answers that miss a required field are bad-response, not guesses'. An organization without a known role is now left out (asserted as `[]`). A new strict check confirms that a row missing its id is still `bad-response`.

### WR-03: The join trusts a NEAR organization link taken from the unauthenticated invite bundle when `team.json` has none

**Files modified:** `src/team/join.ts`, `src/test/teamJoin.test.ts`
**Commit:** edee234
**Applied fix:** team.json is the only source of the link. The link in the bundle (or one the caller passes as `JoinInput.near`) is only compared with it. When team.json has no link, `prepareJoin` and `joinTeam` refuse before anything is written: "Ask your lead to push the NEAR link (or pull it if they already did), then run Join again. Nothing was changed." A different link is refused as before.
**Regression test:** teamJoin.test.ts 'prepareJoin takes the NEAR link only from team.json, refuses a bundle link team.json does not have (WR-03), and refuses when they disagree'. This replaces the assertion that the bundle's link was used as a fallback, and adds a direct `joinTeam` check that no device or seal key is made.

### WR-04: A failed SecretStorage write after a successful refresh destroys the session

**Files modified:** `src/team/nearSession.ts`, `src/services/team/memberCommands.ts`, `src/test/teamNearSession.test.ts`
**Commit:** 3710bf9
**Status:** fixed: requires human verification (session state handling)
**Applied fix:**
- When the store fails, `NearSession` keeps the rotated session in memory. It retries the store once straight away and again on every later call.
- The kept token is used for the next refresh and for sign-out, and `expired` is reported only when NEAR itself refuses.
- Saves run one after another, so an older session can never land on disk after a newer one.
- The user is told once per failing stretch through a new `onStoreFailure` option. The text is fixed (`STORE_FAILED_MESSAGE`) and holds no token.
- `memberCommands.ts` keeps one `NearSession` per team for the life of the window, so the kept token survives from one command to the next, and it reports the warning.
**Regression test:** teamNearSession.test.ts 'WR-04: a rotated refresh token is kept in memory when the secret store fails, used for the next refresh, saved later, and the user is told'

### WR-05: Spend tagging uses a key scope computed once per cached provider

**Files modified:** `src/services/providerCache.ts`, `src/test/teamKeyScope.test.ts`
**Commit:** a4f8913
**Applied fix:** `activeProvider` reads the key scope on every call and makes it part of the cache key. The read is one `fs.stat`, and nothing at all for a team key profile. Enabling Team Mode or joining a team in a running window therefore gets a correctly tagged provider at once.
**Regression test:** teamKeyScope.test.ts 'WR-05: enabling Team Mode in a running window tags the next personal-key run personal, without waiting for the cache to expire'

### WR-06: `restartSession` can return the stale in-flight session start

**Files modified:** `src/services/team/teamCommands.ts`, `src/test/teamCommands.test.ts`
**Commit:** cdfaac5
**Status:** fixed: requires human verification (concurrency)
**Applied fix:** The window's session and its start in flight now live in an exported `createSessionSlot`:
- `start()` joins a start that is already in flight.
- `restart()` waits for any start in flight, disposes what it produced, then starts fresh.
- Restarts run one after another.

`registerTeamMode` uses the slot for startSession, restartSession, verifyLog, the member commands and the returned handle. The module still imports only vscode, Node built-ins and types, so solo activation is unchanged.
**Regression test:** teamCommands.test.ts 'WR-06: restarting while the first start is still running waits for it, disposes it and ends on a fresh session' (it also covers two restarts at once).

### T-61-64 (61-SECURITY.md): `cleanRepoUrl` passes git remote-helper and dash-host addresses

**Files modified:** `src/team/inviteBundle.ts`, `src/test/teamInviteBundle.test.ts`, `61-SECURITY.md`
**Commit:** f3a2c45
**Applied fix:**
- Any address that matches git's remote-helper rule (`^[A-Za-z][A-Za-z0-9+.-]*::`, as in git's own `is_urlschemechar` check) is refused before any other reading of the text. So is an scp-style path that starts with `:`.
- An ssh or https host, or an scp-style host or user, that starts with `-` is refused.
- `parseInviteBundle` runs the same cleaning, so a hand-made bundle carrying such an address is refused too.
- Refusal reasons never repeat the address.

In 61-SECURITY.md, T-61-64 is now closed with this evidence, advisory A1 is marked resolved, and an audit trail row was added. `threats_open` was recomputed: 0, with no open threats at any severity.
**Regression test:** teamInviteBundle.test.ts 'T-61-64: cleanRepoUrl refuses git remote-helper addresses and ssh or scp hosts that start with a dash, and the parser refuses them in a bundle'. It checks `ext::`, `fd::`, `hg::`, `testgit::`, `https::` and mixed-case forms, plus `ssh://-oProxyCommand=...`, `ssh://git@-host`, `https://-host`, `-host:path` and `git@-host:path`. Plain https, scp and ssh addresses, including an ssh URL with a bracketed IPv6 host, are still accepted.

### UI-REVIEW issue 1: Long NEAR and git flows have no progress and no cancel

**Files modified:** `src/services/team/memberCommands.ts`, `src/team/remove.ts`, `src/team/keyDelivery.ts`, `src/team/invite.ts`, `src/team/join.ts`, `src/test/helpers/vscodeStub.ts`, `src/test/teamMemberCommands.test.ts`, `src/test/teamRemove.test.ts`
**Commit:** 0ad3a81
**Applied fix:** Each of these flows now runs in a `vscode.window.withProgress` notification with a plain title and step messages: Remove, Send key and Rotate key, Confirm, Link Team to NEAR Organization, Invite, Re-issue and Retry. Join gained step messages too. The vscode-free flows report step codes, and the command layer words them with the escaped display name. Cancel is offered only where a flow can stop safely:
- **Removal** honours it in two places. Before anything changes, nothing is done. After the log removal, every key still to revoke is already capped at 0, so the remaining revokes and the organization step go on the cleanup list as pending. It never stops between the limit-0 step and the log write.
- **Reading the NEAR organization lists** in Link can be stopped. The stop takes effect once the lists come back, and nothing is changed.
- **Not cancellable:** key delivery and rotation (a key that was made must be delivered, or zeroed and revoked, and an old key is zeroed before it is revoked), and invite, link writes and retries (single writes).
**Regression tests:**
- teamMemberCommands.test.ts 'UI review issue 1: stopping a removal after the log write leaves the key capped at 0 and the revoke on the cleanup list; nothing is ever left uncapped'
- teamRemove.test.ts 'UI review issue 1: a stop asked for before a removal starts changes nothing and makes no NEAR call'
- Progress title, cancellable flag and step-message assertions were added to the existing Invite tracer, Join, Link, Confirm and Remove tests. Against the code before the fix those five tests fail.

### UI-REVIEW issue 2: Cancel invitation has no confirmation

**Files modified:** `src/services/team/memberCommands.ts`, `src/test/teamMemberCommands.test.ts`
**Commit:** 2f7e20f
**Applied fix:**
- The action is renamed from "Cancel" to "Cancel invitation".
- It now opens a modal warning, "Cancel the invitation for <name>?". The detail says the invite code stops working and how to bring the person in later. For a lead invitation in a linked team it also says the NEAR invitation is cancelled.
- Declining says "The invitation for <name> was not changed."
**Regression test:** the existing test 'Cancel ends a pending invitation and Re-issue replaces it with a new bundle shown once with Copy' now checks the renamed action, the modal (its flag, detail and button), that declining keeps the invitation, and that confirming cancels it.

## Deferred (out of scope for this pass, by the orchestrator)

- IN-01: a second invitation for an address with a pending NEAR invitation is reported as failed.
- IN-02: `deliverMemberKey` and `rotateMemberKey` do not refuse a member with `pendingRole` themselves.
- IN-03: plaintext email retention in invites.json, and orphaned entries.
- IN-04: duplicated helpers (`validEmail`, `errorText`, `TEAM_FILE_PARTS`, the bearer stub, the TTL bounds).
- IN-05: rotation can overspend by what is spent between reading the old key and retiring it.
- UI-REVIEW issues 3 to 10: quick pick hierarchy, the invite bundle in a modal detail, the status bar icon and accessibility, jargon in user text, status copy, casing, notification-only prompts, and minor text.

## Follow-ups noticed while fixing (not done, not in scope)

- Manual NEAR cleanup items, now also used for "key not found in the linked workspace", can only be retried; there is no "Mark done" for them. A lead who checked the key in the NEAR console has no way to close the item. This belongs with the deferred UI-REVIEW work on the cleanup list.
- WR-01's "outcome unknown" item uses the `deliver-key` step. If a later delivery of a new key succeeds, it settles (closes) that item, and the reminder to revoke the kept key in the NEAR console goes with it. The kept key's secret was wiped from memory and never reached the log, so nobody can use it, but it is not revoked.
- CR-01's pin is trust on first use. A computer whose first sight of a linked team.json is already forged pins the forged link. The missing-key-is-manual rule still prevents a false "capped and revoked" report. This is the remaining risk recorded in AR-61-05.

## Deviations

- **No nested worktree.** The orchestrator said to run every command in the linked worktree `.claude/worktrees/team-mode` and not switch branches. So no `gsd-reviewfix/*` worktree, temporary branch or recovery sentinel was created, and the cleanup tail did not apply. The fixes are committed directly on `gsd/phase-61-invitations-joining-removal-near-org-and-key-integration`.
- **Plain `git commit`.** Commits were made with `git add <paths>` and `git commit` with normal hooks (no `--no-verify`) and a Co-Authored-By trailer, matching the Phase 60 fix pass, instead of `gsd-tools query commit`. Only the listed files went into each commit.
- **UI issues 1 and 2 share `memberCommands.ts` and its test file.** Each is still its own commit. Issue 1 was committed first with the cancel confirmation held back, then issue 2 on top.
- This report is not committed; the orchestrator commits it.

---

_Fixed: 2026-11-02T04:47:13Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
