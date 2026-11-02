---
phase: 61-invitations-joining-removal-near-org-and-key-integration
verified: 2026-11-02T05:00:00Z
status: human_needed
score: 6/7 must-haves verified
covered_files:
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-01-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-01-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-02-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-02-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-03-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-03-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-04-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-04-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-05-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-05-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-06-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-06-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-07-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-07-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-08-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-08-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-09-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-09-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-10-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-10-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-11-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-11-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-12-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-12-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-13-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-13-SUMMARY.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-14-PLAN.md
  - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-14-SUMMARY.md
  - src/domain/team/invite.ts
  - src/domain/team/materialize.ts
  - src/services/team/memberCommands.ts
  - src/services/team/teamCommands.ts
  - src/services/team/teamSession.ts
  - src/team/invite.ts
  - src/team/inviteBundle.ts
  - src/team/join.ts
  - src/team/keyDelivery.ts
  - src/team/keySeal.ts
  - src/team/nearOrg.ts
  - src/team/nearSession.ts
  - src/team/remove.ts
  - src/team/removedClient.ts
  - src/team/teamFile.ts
  - src/team/teamKeyProfile.ts
  - src/test/teamFlow.test.ts
  - src/test/teamInvitePrivacy.test.ts
  - src/test/teamNearLive.test.ts
covered_digest: "v4:sha256:bfb2cc54e8f55162a113b3db489b63be8246fffdc9ce979cfd23d1a3733bc7c7"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Manual check against a real NEAR organization (success criterion 3, last part): link the team to a real organization and workspace, invite a developer, join, confirm, make one request on the member's key, remove the member, then check the key."
    expected: "The key answers 200 after confirm and one request works; after removal the key answers 402 (limit 0) and then 401 (revoked); the NEAR console shows the key revoked; the removed member's later events are rejected."
    why_human: "Needs a real NEAR organization and the owner's account. The fake NEAR server reproduces the documented quirks, but only a live organization can show that the real API matches them (camelCase spendLimit, 402 at limit 0, up-to-10-second key activation, refresh rotation)."
  - test: "Run the opt-in live NEAR tests: NEAR_LIVE_TEAM=1 plus the access token, organization id and workspace id variables (see src/test/teamNearLive.test.ts), and optionally NEAR_LIVE_TEAM_INVITE_EMAIL."
    expected: "A key created with limit 0 answers 402, answers 200 within the polling window after the limit is raised, and answers 401 after it is set to 0 and revoked. The invitation test shows the disposable address pending and cancellable."
    why_human: "Both tests are skipped without the environment (2 skips in the suite). They have never been run against the real service."
  - test: "Prohibition review (5 flagged, judgment tier, authored without wired checks): 61-09 (no NEAR org membership or session for non-leads), 61-11 a (no deletion of branches, working tree or NEAR keys), 61-11 b (no removal reported complete while a NEAR step failed), 61-13 (no 'capped' wording in a team with no NEAR organization), 61-14 (no clear-text secret or plain email outside SecretStorage and invites.json)."
    expected: "The owner agrees with the verdicts below, which are the verifier's own reading of the code and tests."
    why_human: "These items carry no automated enforcement of their own. The verdicts are NON-AUTHORITATIVE. Every one was found satisfied (see Prohibitions below), but they are recorded as unverified-prohibition, human review recommended."
  - test: "Decision on the accepted deviation from success criterion 2: removing a lead from the NEAR organization is a manual NEAR-console step, because NEAR's member list returns no emails."
    expected: "The owner confirms this is acceptable for the phase, or asks for a follow-up. If accepted, add an override for the clause '(and, for a lead, the organization member removed)'."
    why_human: "The roadmap text promises the organization member is removed. The code does it automatically only when NEAR returns an email for the member, which the real server does not (61-SECURITY.md notes after T-61-48 and AR-61-04). Every lead removal therefore leaves a manual 'remove them in the NEAR console' item, shown to the lead."
---

# Phase 61: Invitations, joining, removal, NEAR org and key integration Verification Report

**Phase Goal:** A lead can bring people into the team and remove them cleanly: invite by email with a role and allocation, the invitee joins with a single-use code and gets their own NEAR access and API key, and removal releases everything the member held and makes their keys worthless.
**Verified:** 2026-11-02T05:00:00Z
**Status:** human_needed
**Re-verification:** No, initial verification (done after the review fix pass: CR-01, CR-02, WR-01 to WR-06, T-61-64 and UI items 1 and 2)

The goal is achieved in the code and in tests that run on real git clones with a fake NEAR server. Nothing was found that blocks the goal. The status is `human_needed` because the manual check against a real NEAR organization and the opt-in live tests have not been done, and because five authored prohibitions have no wired check of their own.

## Goal Achievement

### Observable Truths

Roadmap success criteria are the contract (criteria 1 and 2 as amended for D-21 to D-28).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: A lead invites by email with role and allocation and gets a copyable bundle holding no secret beyond the code; the invitee joins only with a code that matches an unexpired, unused invite and stays observer until confirmed; on confirm in a NEAR-linked team the lead's client creates the member's key with the allocation as its spend limit and seals it to the member's device, stored only in project-scoped SecretStorage; a lead invitee accepts a NEAR org invitation as admin (TEAM-02) | VERIFIED | `src/domain/team/materialize.ts` lines 98-136 (self-bound join, `inviteProblem`: unused, code proof, email hashes, role, commit-time expiry; `applyJoiner` ends `invited` status so the code is single use). `src/team/invite.ts` calls `inviteByEmail(..., 'admin')` only when role is `lead` (line 197, guard at line 168). `src/team/keyDelivery.ts` `sendKey`: `createKey(workspaceId, name, limit)` with the cap in the create call, `sealTo` per device, `wipe(created.secret)`, `member.key-sealed` append. `src/team/nearOrg.ts` `spendLimitBody` is the only way to build a limit; create response is checked to carry the same amount. `src/team/teamKeyProfile.ts` `installTeamKey` stores through `ProfileStore` and `AuthService` (SecretStorage), `check_api_key` with bounded retry. Tests: teamInvite (15 tests incl. wrong code, replay, cancelled, email, role, expiry, race), teamConfirm, teamJoin, teamFlow tracer (developer join makes zero NEAR requests; lead accepts the invitation as admin; keys created with 5 and 20 GIGA limits; installed keys answer 200). All pass in my run. |
| 2 | SC2: A lead removes a member: claims, leases and allocations are released with branches preserved, devices revoked, every client rejects later events from their keys, the NEAR key's limit is set to 0 before the key is revoked (and, for a lead, the organization member removed), and a checklist reminds the lead to remove repository access (TEAM-03) | VERIFIED (with accepted deviation, see Human Verification 4) | `materialize.ts` `releaseHeldWork` (claims in active/in-review/integrating become `released` with branch kept, items back to `ready`, leases dropped, allocations removed, integration queue cleaned) and `boundKey` rejecting any later event from a removed author (`R.removedAuthor`). `src/team/remove.ts` `removeJoinedMember`: cap every delivered key at 0, then `member.removed`, then revoke only keys whose cap is `done`; failures become cleanup items and a `KEY_STILL_SPENDS` warning; `repo-access` item always last. Tests: teamRelease (fixture state, determinism for 20 seeds, snapshot compatibility), teamRemove, teamFlow (PATCH spend-limit precedes DELETE key; exactly one event pushed between cap and revoke; developer key 401 after; developer's next write refused as removed; developer's computer cleans itself). Lead org removal is automatic only when NEAR returns member emails, which it does not (deviation, flagged). |
| 3 | SC3a: Invite, join and remove complete end to end in tests against a fake NEAR API server covering organization, invitation, workspace key, spend-limit and usage endpoints | VERIFIED | `src/test/helpers/fakeNear.ts` (real quirks) with `teamNearOrg.test.ts` (endpoints, casing, retry, redaction), `teamFlow.test.ts` (linked and unlinked lifecycles). Full team suite re-run by the verifier: 651 tests, 649 pass, 0 fail, 2 skipped (the two opt-in live tests). |
| 4 | SC3b: One opt-in live test behind an environment flag, and a manual check against a real NEAR organization | UNCERTAIN (human) | The live tests exist (`src/test/teamNearLive.test.ts`, behind `NEAR_LIVE_TEAM=1`) and skip cleanly without the environment. They have not been run, and the manual check has not been done. See Human Verification 1 and 2. |
| 5 | SC4: After the full invite, join and remove flow a privacy canary finds no secret (API key, session token, clear-text invite code) in the coordination branch, `team.json`, settings, audit or transcripts | VERIFIED | `src/test/teamInvitePrivacy.test.ts` runs the whole lifecycle with run-time canaries, scans every blob on the remote and each mirror, `team.json`, settings written, audit store, output channel, notifications, status bar and every file under extension storage, for the code in grouped, hex and base64url forms, API key, access and refresh tokens, both private keys in stored and re-encoded forms, and the remote URL password; controls show the scanner sees planted values and sees the real ones in SecretStorage and `invites.json`. Passes. |
| 6 | SC5: Solo projects behave as 0.4.8; the existing suite is green; `npm run lint` and `npm test` pass | VERIFIED | `teamSoloParity.test.ts` passes in my team run. Lint (`tsc --noEmit`) exit 0 by me. The orchestrator's `npm run check` (1227 tests, 1217 pass, 0 fail, 10 skipped) is accepted as the full-suite result. I also re-ran `npm run verify:release` (exit 0, 243 files, release content verified) and the Electron e2e suite after the fix pass (`DISPLAY=:0 node dist/test/e2e/run.js`, exit 0; `xvfb-run` is not installed here). |
| 7 | Review fix pass is in the code: CR-01, CR-02, WR-01 to WR-06, T-61-64, UI items 1 and 2 | VERIFIED | CR-01: `teamFile.ts` `checkNearPin`/`pinNearLink`/`NearPinError`, used in `remove.ts`, `keyDelivery.ts`, `invite.ts`, `join.ts`, `nearLink.ts`, `teamSession.ts`; a key NEAR does not find is a `manual` item, never `done` (`capKey`, `revokeKey`, `retireKey`). CR-02: `invite.ts` `retryNearInvitation` and `closeInvitationSends`, called from `removeJoinedMember`, re-issue and Retry. WR-01: `keyDelivery.ts` `deliveryLanded` after an offline append. WR-02: `nearOrg.ts` role `'unknown'` kept, `findKey` strict only on the wanted row. WR-03: `join.ts` takes the link from team.json only. WR-04: `nearSession.ts` `onStoreFailure`, `STORE_FAILED_MESSAGE`; `memberCommands.ts` passes `storeFailure`. WR-05: `providerCache.ts` key scope read per call and part of the cache key. WR-06: `teamCommands.ts` `createSessionSlot`. T-61-64: `inviteBundle.ts` `REMOTE_HELPER` refusal and leading-colon scp path. UI 1: `withProgress` with step texts in `memberCommands.ts`; stop honoured only before the cap or after the log removal. UI 2: modal "Cancel the invitation for ..." at `memberCommands.ts:815`. Each has a named regression test and all pass. |

**Score:** 6/7 truths verified; truth 4 (live test and real-organization check) needs the owner. 0 present-but-behavior-unverified.

### Deferred Items

None are needed to close this phase. Items the review pass deferred on purpose and that do not bear on a must-have: IN-01 to IN-05 (duplicate-invite wording, `pendingRole` guard in the delivery functions, plaintext email retention in `invites.json` which the 61-14 prohibition explicitly allows, duplicated helpers, rotation overspend between reading and retiring the old key) and UI-REVIEW issues 3 to 10 (copy, quick pick layout, status bar icon and accessibility information). The follow-up noticed during the fix pass (manual cleanup items can only be retried, no "Mark done") is noted but not blocking. Later phases (62 to 67) do not claim these items; they are phase 61 polish.

### Required Artifacts

`gsd-tools verify.artifacts` and `verify.key-links` were run on all 14 plans: every declared artifact exists and is substantive, and every declared key link is found (artifacts 3/3, 4/4, 2/2 and so on, no failures; key links all verified). I then read the code behind the central ones.

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/domain/team/invite.ts`, `materialize.ts` | Pure invite rules, invite-gated join, removal release | VERIFIED | Read in full for the paths above |
| `src/team/nearOrg.ts` | Typed NEAR client, limit only via `spendLimitBody` | VERIFIED | `createKey`, `setSpendLimit` check the stored amount and throw `limit-mismatch` |
| `src/team/keySeal.ts`, `identity.ts` | X25519 seal and open, seal key in SecretStorage | VERIFIED | Sealed ciphertext checks and wipe in `sealTo`; tests teamSealedKey |
| `src/team/invite.ts`, `inviteBundle.ts`, `inviteCode.ts` | Bundle, cleaning, single-use code | VERIFIED | Code proof by derived key, URL cleaning with remote-helper refusal |
| `src/team/join.ts` | Join, lead-only NEAR accept, rollback | VERIFIED | `acceptAsLead` is reached only when the invited role is `lead` (line 418) |
| `src/team/keyDelivery.ts` | Confirm, deliver, rotate, install | VERIFIED | Read `sendKey`, `rotateMemberKey`, `retireKey` |
| `src/team/remove.ts`, `removedClient.ts`, `cleanupChecklist.ts` | Ordered removal, own-removal cleanup | VERIFIED | Read in full; no git branch/reset/clean/stash call and no file deletion outside the team's own storage and SecretStorage entries |
| `src/team/nearSession.ts`, `teamKeyProfile.ts`, `src/services/nearSignIn.ts` | Kept session, team key profile, shared sign-in | VERIFIED | Wiring seen in `memberCommands.ts` and `teamSession.ts` |
| `src/services/team/memberCommands.ts`, `teamSession.ts`, `teamStatusBar.ts`, `package.json` | Five commands, lifecycle reactions, status | VERIFIED | Five `nearAi.team.*` commands contributed and registered by `registerMemberCommands` from `teamCommands.ts` |
| `src/test/teamFlow.test.ts`, `teamInvitePrivacy.test.ts`, `teamNearLive.test.ts` | End to end, canary, live | VERIFIED (live test skipped without env) | |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `materialize.ts` | `invite.ts` | `joinProofBytes`, `expectedJoinRole`, `inviteExpired` | WIRED | Lines 6, 131-135 |
| `remove.ts` | `nearOrg.ts` | `setSpendLimit(0)` before `revokeKey` | WIRED | `capKey`, `revokeKey` guarded by `cap.status === 'done'` |
| `keyDelivery.ts` | `keySeal.ts` / `nearOrg.ts` | `sealTo`, `wipe`, `createKey` | WIRED | `sendKey` |
| `teamSession.ts` | `keyDelivery.ts`, `removedClient.ts`, `invite.ts` | `installDeliveredKey`, `handleOwnRemoval`, `memberAttention` | WIRED | Lines 550, 569, 588 |
| `teamCommands.ts` | `memberCommands.ts` | `registerMemberCommands` | WIRED | Line 297 |
| `providerCache.ts` | `providerFactory.ts` | `keyScope` | WIRED | Lines 58-63 |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|----------|------|--------|-----------|--------|
| Member's installed key | clear `sk-` key | NEAR create response, sealed in `member.key-sealed`, opened by the member's X25519 key | Yes (teamFlow: installed key answers 200 at the fake) | FLOWING |
| Remove warning | `keyStillSpends` | per-key cap result from `setSpendLimit` | Yes | FLOWING |
| Status bar pending count | `memberAttention(state, linked)` | materialised log state | Yes | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase 61 and Phase 60 team suites | `node --test dist/test/team*.test.js` (after `tsc`) | 651 tests, 649 pass, 0 fail, 0 cancelled, 2 skipped | PASS |
| Lint | `npm run lint` | exit 0 | PASS |
| Release content | `npm run verify:release` | exit 0, 243 entries, 44 required assets | PASS |
| Electron e2e | `DISPLAY=:0 env -u ELECTRON_RUN_AS_NODE node dist/test/e2e/run.js` | exit 0 | PASS |
| Order of NEAR calls on removal | teamFlow assertions (PATCH before DELETE, one event between) | pass | PASS |

The full suite was not re-run by me; the orchestrator's `npm run check` result is relied on.

### Probe Execution

No probes declared by any plan; none found for this phase. SKIPPED.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|--------------|-------------|--------|----------|
| TEAM-02 | 61-01, 02, 03, 04, 05, 07, 08, 09, 10, 12, 13, 14 | Invite by email with role and allocation; single-use code; invitee gets own NEAR access and key | SATISFIED in code and fake-server tests; real-service check pending | Truths 1, 3, 5. "Own NEAR access" is implemented per D-21: a member gets a lead-created key capped at their allocation; only a lead gets NEAR org membership. |
| TEAM-03 | 61-02, 05, 06, 11, 12, 13, 14 | Remove a member; claims, leases and allocations released; later events from their keys rejected | SATISFIED | Truth 2. Lead org removal is manual (accepted deviation). |

Every ID in the plans' `requirements` fields (TEAM-02, TEAM-03) is present in REQUIREMENTS.md, where both are marked Complete and mapped to Phase 61. REQUIREMENTS.md maps no other ID to Phase 61, so there are no orphaned requirements. The traceability status "Complete" was set before this verification; it should be read as complete pending the human items above.

### Prohibitions (judgment tier, NON-AUTHORITATIVE, flagged `unverified-prohibition: human review recommended`)

None of the five has a wired enforcement check. Verifier verdicts from code and tests:

| Plan | Prohibition | Verdict | Evidence |
|------|-------------|---------|----------|
| 61-09 | No NEAR org membership or session for developer, reviewer, observer | Not violated | NEAR invitation only for role `lead` (`invite.ts` lines 168 and 398 use `'admin'` and are lead-gated); `join.ts` calls `acceptAsLead` only when `invitedRole === 'lead'`; teamFlow asserts zero NEAR requests during the developer's join and that the only pending invitation is the lead's, at `admin`. Members never sign in to NEAR. |
| 61-11 a | No deletion or rewrite of the member's branches, commits or working tree; no touching of NEAR key files or secrets outside the team's own entries | Not violated | `remove.ts`, `removedClient.ts`, `cleanupChecklist.ts` contain no git branch, reset, checkout, clean or stash call. `handleOwnRemoval` deletes only this team's device key, seal key, NEAR session and team profile secrets plus two small files in the team's own storage folder. teamRemove test 822 checks branches, stash and working tree are identical after cleanup and that the member's personal key is untouched. The code has no reference to the NEAR key directory. |
| 61-11 b | No removal reported complete while a NEAR step failed; a key that may still spend is called out | Not violated | `removeMember` returns `keyStillSpends` and a message starting with the warning when any cap is not `done`; unfinished revoke and org steps are named in the message and kept on the cleanup list. The text says "was removed from the team" (the log fact) and never "complete". |
| 61-13 | No "capped" or "limited at the provider" wording in a team without a NEAR organization | Not violated | `memberCommands.ts` shows `NO_ORG_NOTICE` when `teamFile.near === undefined` (lines 544, 746, 917); "spend cap" sentences are reachable only after a key was delivered, which needs a link. The remove dialog uses different text when unlinked (line 776). Status bar tooltip uses the notice. |
| 61-14 | No clear-text key, token, invite code or plain email persisted except SecretStorage (secrets) and the lead's `invites.json` (email only) | Not violated | Truth 5 (canary over every persisted place, with controls). Residual, allowed by the prohibition: `invites.json` keeps plain emails and may keep orphaned entries (IN-03, deferred). |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (changed files in this phase) | | TBD, FIXME, XXX markers | None found in `src/team`, `src/services/team`, `src/domain/team` scan of the central files | |
| `src/services/team/memberCommands.ts`, `src/team/*` | | em-dash or en-dash in user text | None found | |

No stubs, empty handlers or hardcoded empty data were found in the phase's core paths. The deliberate scan covered the files listed in `covered_files`.

### Human Verification Required

#### 1. Manual check against a real NEAR organization

**Test:** Link a real organization and workspace, invite a developer, join from a second clone, confirm, make one request with the member's key, remove the member, then check the key twice.
**Expected:** Works after confirm (allow up to about 10 seconds of key activation); 402 right after removal, then 401 once revoked; the NEAR console shows the key revoked; the removed member's computer shows "You were removed".
**Why human:** Needs the owner's real NEAR account and organization.

#### 2. Opt-in live tests

**Test:** Run `NEAR_LIVE_TEAM=1` with the variables named in `src/test/teamNearLive.test.ts` (and `NEAR_LIVE_TEAM_INVITE_EMAIL` for the invitation test).
**Expected:** 402 at limit 0, 200 after the limit is raised, 401 after zero plus revoke; the disposable-address invitation is listed pending and can be cancelled.
**Why human:** Real credentials and a real workspace; skipped in the default suite.

#### 3. Judgment review of the five flagged prohibitions

**Test:** Read the verdicts above and confirm them.
**Expected:** Agreement, or a request for wired checks.
**Why human:** `unverified-prohibition`; the verdicts are not authoritative.

#### 4. Accepted deviation on lead removal from the NEAR organization

**Test:** Decide whether "manual NEAR-console step, shown on the cleanup list" meets the clause "and, for a lead, the organization member removed".
**Expected:** Accept it. The matching override, if accepted:

```yaml
overrides:
  - must_have: "for a lead, the organization member removed"
    reason: "NEAR's organization member list returns no emails, so nobody can be matched safely; the step is a manual console item on the cleanup list and removal never guesses (61-SECURITY.md T-61-48, AR-61-04)"
    accepted_by: "owner"
    accepted_at: "<ISO timestamp>"
```

**Why human:** It is a scope decision, not something a check can settle.

### Gaps Summary

No gaps. Every automated truth was verified against the code and by running the tests, including the review fix pass. The phase cannot be called fully verified until the owner has run the real-organization check and the live tests, and has seen the flagged prohibition verdicts and the lead-removal deviation. Weakness worth knowing (not a gap): the NEAR link pin is trust on first use (AR-61-05), so a computer whose first sight of a team.json is already forged pins the forged link; removal still never reports an uncapped key as capped.

---

_Verified: 2026-11-02T05:00:00Z_
_Verifier: Claude (gsd-verifier)_
