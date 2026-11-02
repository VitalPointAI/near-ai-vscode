---
phase: 61-invitations-joining-removal-near-org-and-key-integration
reviewed: 2026-11-01T00:00:00Z
depth: standard
files_reviewed: 69
files_reviewed_list:
  - package.json
  - src/domain/auth.ts
  - src/domain/team/invite.ts
  - src/domain/team/materialize.ts
  - src/domain/team/permissions.ts
  - src/domain/team/secrets.ts
  - src/domain/team/types.ts
  - src/domain/team/validate.ts
  - src/services/nearAiClient.ts
  - src/services/nearSignIn.ts
  - src/services/providerCache.ts
  - src/services/providerFactory.ts
  - src/services/spendLedger.ts
  - src/services/spendTracking.ts
  - src/services/team/memberCommands.ts
  - src/services/team/teamCommands.ts
  - src/services/team/teamSession.ts
  - src/services/team/teamStatusBar.ts
  - src/team/auditMirror.ts
  - src/team/cleanupChecklist.ts
  - src/team/enable.ts
  - src/team/eventLog.ts
  - src/team/gitTransport.ts
  - src/team/identity.ts
  - src/team/inviteBundle.ts
  - src/team/inviteCode.ts
  - src/team/invite.ts
  - src/team/join.ts
  - src/team/keyDelivery.ts
  - src/team/keySeal.ts
  - src/team/nearLink.ts
  - src/team/nearOrg.ts
  - src/team/nearSession.ts
  - src/team/removedClient.ts
  - src/team/remove.ts
  - src/team/teamKeyProfile.ts
  - src/test/helpers/fakeNear.ts
  - src/test/helpers/teamCanary.ts
  - src/test/helpers/teamFlowRig.ts
  - src/test/helpers/teamPhase60Fixture.ts
  - src/test/helpers/vscodeStub.ts
  - src/test/nearSignIn.test.ts
  - src/test/teamAudit.test.ts
  - src/test/teamCommands.test.ts
  - src/test/teamConfirm.test.ts
  - src/test/teamEnable.test.ts
  - src/test/teamFlow.test.ts
  - src/test/teamInviteBundle.test.ts
  - src/test/teamInviteFlow.test.ts
  - src/test/teamInvitePrivacy.test.ts
  - src/test/teamInvite.test.ts
  - src/test/teamJoin.test.ts
  - src/test/teamKeyProfile.test.ts
  - src/test/teamKeyScope.test.ts
  - src/test/teamKeySealedEvent.test.ts
  - src/test/teamManifest.test.ts
  - src/test/teamMemberCommands.test.ts
  - src/test/teamNearLink.test.ts
  - src/test/teamNearLive.test.ts
  - src/test/teamNearOrg.test.ts
  - src/test/teamNearSession.test.ts
  - src/test/teamPermissions.test.ts
  - src/test/teamRelease.test.ts
  - src/test/teamRemove.test.ts
  - src/test/teamSealedKey.test.ts
  - src/test/teamSecrets.test.ts
  - src/test/teamSessionMembers.test.ts
  - src/test/teamSoloParity.test.ts
  - src/test/teamValidate.test.ts
findings:
  critical: 2
  warning: 6
  info: 5
  total: 13
status: issues_found
---

# Phase 61: Code Review Report

**Reviewed:** 2026-11-01
**Depth:** standard
**Files Reviewed:** 69
**Status:** issues_found

## Summary

Reviewed the Phase 61 source (commits after 767ba47, merge aab035e excluded) with the most attention on the crypto and money paths. `tsc --noEmit` is clean. No structural (fallow) findings and no external reviewer evidence were supplied, so this report has only the narrative section.

The cryptographic core holds up. In `keySeal.ts` the AAD binds team, member, device and key id, the HKDF salt binds both public keys, the nonce is fresh per entry, and a failed open returns a verdict. `inviteCode.ts` and `domain/team/invite.ts` bind the countersignature to team, member, invite event, device and seal key. The nano-USD arithmetic is integer-only: `parseUsdToNanoUsd`, `priceToNano` and `spendLimitBody` all reject unsafe values. `createKey` checks that the stored limit matches what was sent. The refresh rotation in `nearSession.ts` stores the new token before it hands out the access token.

The defects are at the seams between the signed log and the unauthenticated, local, or ambiguous inputs around it:

- Two BLOCKERs. The removal cut-off can be defeated by an edited `team.json`, and a stale cleanup item can send a NEAR admin invitation to a person who has already been removed.
- Six WARNINGs. They cover an ambiguous-offline key revocation, one malformed row blocking the cap step, a trusted-from-the-bundle NEAR link, a lost refresh token, a stale spend tag, and a session-restart race.

Cross-references, not re-raised:

- T-61-64 in 61-SECURITY.md (`cleanRepoUrl` and `ext::`/`fd::`/`-host`) is already tracked.
- The UI findings are in 61-UI-REVIEW.md.
- Commit-time invite expiry is AR-61-01, accepted.

## Critical Issues

### CR-01: A forged `team.json` `near.workspaceId` makes removal report keys as capped and revoked when they are not

**File:** `src/team/remove.ts:69-77` and `:80-87` (with `src/team/nearOrg.ts:313-325`; `src/team/teamFile.ts:210-221` for the pin contents)

**Issue:**
- The key ids to cut off come from the signed log (`deliveredKeys`, `remove.ts:60`). The workspace they are looked up in comes from `teamFile.near.workspaceId`, which is read from the working tree and is not authenticated. `checkTrustPin` pins only team id, genesis event id and owner fingerprint, not `near`.
- `capKey` calls `findKey(workspace, keyId)`. If the key is not in the (forged) workspace it returns `undefined`, and `capKey` returns `DONE` ("a key NEAR no longer lists is already gone").
- `revokeKey` does the same: `NearOrgClient.revokeKey` returns `'missing'` on 404 and `remove.ts` returns `DONE` unconditionally.
- A member who is about to be removed, and who can commit to a branch the lead pulls, edits `near.workspaceId` to another real workspace of the same organization (or any other workspace the lead can read). The lead then removes them. `keyStillSpends` is false, the lead is told "Their NEAR key is capped at 0 and revoked", and the member's real key is still live with its full allocation. This is the exact adversary the removal flow exists for.
- The accepted risk AR-61-05 argues only that a forged link cannot create keys outside an organization where the lead is owner or admin. It does not cover this. It also says members only use the link to choose paste or wait, but `keyDelivery.ts:358` passes `expect: input.teamFile.near` to `installTeamKey`, so a forged link also decides which organization and workspace a delivered key must belong to.

**Fix:**
- Authenticate the workspace for key operations. Preferred: record `workspaceId` (and `organizationId`) in the signed `member.key-sealed` body, or in a signed link event, and have `capKey`, `revokeKey` and `rotateMemberKey` use that value. At minimum, TOFU-pin `near` in `trust.json` at link time, so a later change of `near` in team.json pauses Team Mode just as a changed owner key does.
- Never treat "not found in the configured workspace" as done. Return `manual` ("the key was not found in the linked workspace; check the NEAR console") unless the key's absence is confirmed by the pinned workspace.
- Drop the pre-listing in `capKey` and call `setSpendLimit` directly. It already returns `'missing'`.
- Correct the AR-61-05 text in 61-SECURITY.md.

### CR-02: Retrying a stale "send NEAR invitation" cleanup item invites a removed or superseded person to the paying NEAR organization as admin

**File:** `src/services/team/memberCommands.ts:795-821` (open items left by `src/team/remove.ts:199-258` and `src/team/invite.ts:175-183`)

**Issue:**
- `inviteToNear` queues a `send-invitation` item (status pending or failed) when a lead's NEAR invitation could not be sent. Nothing closes that item when the invitee joins, when the joined member is removed (`removeJoinedMember` only touches zero-limit, revoke-key, remove-org-member and repo-access), or when the invitation is re-issued (the old member id's item stays open).
- `retryItem` for `send-invitation` never looks at the member's current state. It reads the plaintext email from the local `invites.json` and calls `inviteByEmail(orgId, entry.email, 'admin')`.
- A lead who removes a joined invitee and later clicks Retry on the still-listed "NEAR cleanup: Send the NEAR invitation for X" gives an organization-admin invitation (which can mint keys) to a person who was just removed. `cancelInvitationFor` closes `neverSent` items but the joined-member path does not.

**Fix:**
- In `retryItem`, load `ctx.session.state().members.get(item.memberId)` before calling NEAR. If the member is missing, has `removedEvent`, or is no longer `invited` and no longer lead or pending-lead, mark the item `done` with a note and do not call NEAR.
- In `removeJoinedMember` (and `reissueInvite`'s old-id path), close every open `send-invitation` item for that member, the same way `cancelInvitationFor` does with `neverSent`.
- Make the item self-describing: store the role and organization id at queue time and re-validate them on retry.

## Warnings

### WR-01: A lost push answer makes `sendKey` revoke a key whose `member.key-sealed` event has already landed

**File:** `src/team/keyDelivery.ts:203-216`

**Issue:**
- `AppendResult.kind === 'offline'` is documented as ambiguous: `gitTransport.ts:115` says an exit without a ref line "is offline and may still have landed". `join.ts` handles that case with `didJoinLand`.
- `sendKey` treats every `!appended.ok` (and every thrown error) as "not written" and calls `abandon`, which zeroes and revokes the new key. If the event did land, the log now names a revoked key as the member's current key (`nearApiKeyId`).
- The member's `installDeliveredKey` fails forever ("NEAR AI did not accept this team key").
- The lead's attention list shows nothing: `deliver-key` needs `nearApiKeyId === undefined`, and `rotate-key` needs a device mismatch. `deliverMemberKey` refuses with "already has a key".
- The only recovery is to remove and re-invite.

**Fix:**
- For `appended.kind === 'offline'` (and for a throw after the push started), call `log.sync()` and check `state.members.get(member.id)?.nearApiKeyId === keyId`.
- If it landed, return success and keep the key.
- If the sync also fails, do not revoke. Put a `manual` checklist item with the key id and tell the lead the outcome is unknown.
- Only abandon on definite failures (`refused`, `conflict`, `remote-rejected`, `exists`).

### WR-02: One unparseable key row in the workspace blocks the cap step of every removal and every rotation

**File:** `src/team/nearOrg.ts:165-179`, `:146-163`, `:302-310`; callers `src/team/remove.ts:71`, `src/team/keyDelivery.ts:247`

**Issue:**
- `listKeys` maps every row through `parseKey`. `parseKey` throws `bad-response` on a non-boolean `is_active`, and `priceToNano` throws on a non-USD currency, a non-integer or unsafe amount, or a scale over 18.
- The workspace is shared with keys created in the NEAR console. One such key makes `findKey` (and `removeKeysNamed`) throw.
- `capKey` then returns `failed` and the removed member's key stays uncapped. `rotateMemberKey` aborts. The error text gives no hint that an unrelated row is the cause.
- `listOrganizations` and `listMembers` have the same all-or-nothing `requireRole` (an unknown role throws), which would break linking and org-member removal.

**Fix:**
- Make `findKey` match on the raw `id` first and parse only that row. Parse the other rows leniently (skip the row that fails and keep a count). Keep `listKeys` strict only where every row is needed.
- Remove the `findKey` pre-check in `capKey`, as in CR-01.

### WR-03: The join trusts a NEAR organization link taken from the unauthenticated invite bundle when `team.json` has none

**File:** `src/team/join.ts:67-71` and `:292`, consumed at `:401-405` and `:208-247`

**Issue:**
- `prepareJoin` and `joinTeam` use `teamFile.near ?? bundle.near`. The bundle is plain base64url JSON with no MAC. Anyone who handles it in transit can change `near` without breaking the invite code.
- If the checked-out `team.json` has no link, a tampered bundle makes a lead invitee's client sign in to NEAR and accept (or look for) an invitation to an organization the attacker names (`acceptAsLead`, `org.acceptInvitation(found.id)`). The invitee ends up in an attacker-controlled organization.
- The same fallback also suppresses the "paste your own key" path for non-leads on a team that has no link.

**Fix:** Treat `team.json` as the only source of the link. When `teamFile.near === undefined`, ignore `bundle.near`, or refuse with "ask your lead to push the NEAR link and send a new invite". Keep the mismatch check for the case where both exist.

### WR-04: A failed SecretStorage write after a successful refresh destroys the session

**File:** `src/team/nearSession.ts:200-208`

**Issue:**
- The refresh token is single use, so NEAR has already burned the stored one when the new pair arrives. If `secrets.store(next)` throws (a locked or failing keychain), the new refresh token is dropped and the old stored one is dead.
- The next refresh is refused and the lead gets "Your NEAR sign-in expired" and has to sign in again. A transient storage error becomes a forced re-login, and in the middle of a removal it can leave a cap step pending.

**Fix:** Keep the new pair in memory (`this.pending = next`) and retry the store once, and again on the next call. Use the in-memory pair for the next refresh if the store still fails, and only report `expired` when NEAR itself refuses.

### WR-05: Spend tagging uses a key scope computed once per cached provider, so Enable Team Mode in a running window leaves personal-key runs untagged

**File:** `src/services/providerCache.ts:56-61`

**Issue:**
- `keyScopeFor` runs only when the cache entry is first created (`previous?.provider === undefined`). The entry is then reused for the life of the window; the cache key is root, profile id and `updatedAt`, and TTL refreshes keep the provider.
- If a project is solo when a provider is first created and then runs "Enable Team Mode" (team.json appears), the cached personal provider keeps `keyScope: undefined`. Its spend entries are not marked `personal` (and nothing clears the cache on enable).
- Phase 66 reconciliation depends on those tags.

**Fix:** Compute `keyScope` on every `activeProvider` call and include it in the cache key (cheap `fs.stat`), or call `clearProviderCache()` from enable, join and restartSession.

### WR-06: `restartSession` can return the stale in-flight session start

**File:** `src/services/team/teamCommands.ts:97-124` and `:139-144`

**Issue:**
- `startSession` returns the existing `starting` promise if one is in flight. `restartSession` sets `session = undefined`, disposes the old one (undefined if the first start has not finished), then calls `startSession`.
- If Join, or a NEAR link, runs while the first session start is still doing its first sync (a network round trip), `restartSession` joins that older start. When it resolves, `session` is the session built from the pre-join `team.json` and device identity, not a fresh one.
- After a join, the session then runs read-only (no signer), and it does not install the delivered key until the window is reloaded. The caller assumes a restart.

**Fix:** In `restartSession`, `await starting` first (ignore its result), dispose whatever it produced, then start fresh. Or track a generation counter and have `startSession` discard a start that began before the latest restart.

## Info

### IN-01: A second invitation for an email that still has a pending NEAR invitation is reported as a failure and stays on the cleanup list forever

**File:** `src/team/nearOrg.ts:371-382`, `src/team/invite.ts:193-195`

**Issue:** `inviteByEmail` maps "already a member" to success but "already pending" (the wording the fake server uses) to `{ok:false}`. `inviteToNear` handles the pending case only on the re-issue path. A fresh invitation for an address whose earlier NEAR invitation was never cancelled leaves a `failed` item that can never succeed.

**Fix:** Treat `/already pending/i` as success (`alreadyInvited`), or check `listInvitations('pending')` on every lead invite as the re-issue path does.

### IN-02: `deliverMemberKey` and `rotateMemberKey` do not enforce "the key follows the confirmation" themselves

**File:** `src/team/keyDelivery.ts:156-174` and `:225-230`

**Issue:** D-25 says a member with `pendingRole` gets a key only after confirmation. `memberAttention` hides the action, but `checkTarget` does not refuse `member.pendingRole !== undefined`, and `keyDeliveryProblem` in the materialiser allows it. The command `nearAi.team.manageMembers` accepts `{memberId, action:'deliver-key'}` as an argument (`memberCommands.ts:947-957`), so the invariant rests on the UI list alone.

**Fix:** Refuse in `checkTarget` when `member.pendingRole !== undefined` (and consider a matching rule in `keyDeliveryProblem`).

### IN-03: Local plaintext email retention and orphaned items

**File:** `src/team/invite.ts:112-121`

**Issue:** `invites.json` keeps the invitee's plaintext email for the life of the storage folder, including used, cancelled and re-issued invitations. The log keeps only salted hashes, and the UI text says so. Entries for superseded member ids (re-issue) are never removed, and their cleanup items are never closed (see CR-02).

**Fix:** Delete or archive the entry when the invitation becomes used or cancelled (on the lead's next sync), and remove the old id's entry and items on re-issue.

### IN-04: Duplicated helpers that can drift

**File:** `src/team/invite.ts:61` and `src/services/team/memberCommands.ts:104`; `errorText` in `remove.ts:46`, `keyDelivery.ts:76`, `invite.ts:165`; `TEAM_FILE_PARTS` in `teamCommands.ts:19`, `memberCommands.ts:43`, `providerCache.ts:22`; the no-refresh bearer stub in `join.ts:186` and `memberCommands.ts:251`; TTL bounds in `domain/team/validate.ts:95-96` and `team/invite.ts:29-30`

**Issue:** The two `validEmail` copies are written with different character classes and can drift. The TTL limits are declared twice and must match for an invitation to be accepted.

**Fix:** Export one copy of each from a shared module (the TTL limits from `domain/team/invite.ts`).

### IN-05: Rotation can overspend by the spend made between reading the old key and retiring it

**File:** `src/team/keyDelivery.ts:244-260`

**Issue:** The new key's cap is `limit - usage` read before the new key is created, sealed and appended. The old key keeps spending until `retireKey` runs after the append. The window is seconds to tens of seconds, similar in kind to AR-61-08 but not covered by it, and the member's per-allocation total can exceed the allocation by that spend.

**Fix:** After `retireKey` zeroes the old key, re-read its usage and, if it grew, lower the new key's limit with `setSpendLimit` by the difference. Or state the overshoot in the notice.

---

_Reviewed: 2026-11-01_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
