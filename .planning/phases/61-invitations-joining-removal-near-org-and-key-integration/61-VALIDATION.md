---
phase: "61"
slug: "invitations-joining-removal-near-org-and-key-integration"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-11-01"
---

# Phase 61 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Source: 61-RESEARCH.md "Validation Architecture", amended for the owner's revised decisions D-21 to D-28 in 61-CONTEXT.md (lead-owned keys, key sealed to the member's device, members are not NEAR org members).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node built-in `node:test` with `node:assert/strict`, compiled to `dist/test/*.test.js` |
| **Config file** | none; `package.json` scripts `lint`, `test`, `check`, `test:e2e` |
| **Quick run command** | `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` |
| **Full suite command** | `npm run check` (lint plus full `npm test`) |
| **Estimated runtime** | quick ~10-60 s; team family ~2-4 min; full suite several minutes |

---

## Sampling Rate

- **After every task commit:** `npm run lint` plus the changed test file(s)
- **After every plan wave:** `npx tsc -p tsconfig.json && node --test dist/test/team*.test.js`
- **Before `/gsd-verify-work`:** `npm run check` green, `npm run test:e2e` once, `npm run verify:release` once, the opt-in live test, then the manual check against a real NEAR organization
- **Max feedback latency:** 60 s per task
- Signatures, invite proof, permission, forgery, sealed-key and canary checks are blocking at every wave. Never delete, skip or weaken a failing test to get green.

---

## Per-Task Verification Map

Task IDs are plan-task (61-NN-TT). Every automated command below ran as part of the single full `npm run check` at the phase boundary (1210 tests, 0 failures, 10 skipped for missing external tools or keys), and the plan-14 gate ran e2e and `npm run verify:release` once each. The live NEAR check and the real-organization check remain manual (below).

| Task | Requirement | Behaviour | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|------|-------------|-----------|-----------------|-----------|-------------------|-------------|--------|
| 61-01-01 | TEAM-02 | Decision: signed invite and join formats confirmed before the first is written | Formats recorded in the plan before any event was signed | checkpoint | (decision recorded in 61-01-PLAN.md; auto-confirmed) | ✅ | ✅ green |
| 61-01-02 | TEAM-02 | Tracer: invite then join from a second clone over real git, accepted identically on both clones | Join valid only with a matching unexpired unused invite | integration | `node --test dist/test/teamInvite.test.js dist/test/teamValidate.test.js dist/test/teamAudit.test.js dist/test/teamMaterialize.test.js dist/test/teamLog.test.js` | ✅ | ✅ green |
| 61-01-03 | TEAM-02/03 | Every join rule, commit-time expiry on read and write, cancel and re-issue; removed devices rejected positionally | Replay, wrong device, wrong role, expiry and cancel all rejected | unit/property | `node --test dist/test/teamInvite.test.js dist/test/teamGitTransport.test.js dist/test/teamForgery.test.js` | ✅ | ✅ green |
| 61-02-01 | TEAM-02 | Tracer: create a key with a spend limit, lower it and revoke it against the fake NEAR | spendLimit always sent camelCase and typed | integration | `node --test dist/test/teamNearOrg.test.js` | ✅ | ✅ green |
| 61-02-02 | TEAM-02 | Rest of the NEAR surface, real-server traps, retry rules, redaction | Secrets redacted from every error | integration | `node --test dist/test/teamNearOrg.test.js` | ✅ | ✅ green |
| 61-03-01 | TEAM-02 | Tracer: seal a key to a device's X25519 key, open it, pass the write-side secret check | Key reaches only the target device | unit | `node --test dist/test/teamSealedKey.test.js dist/test/teamIdentity.test.js dist/test/teamSecrets.test.js` | ✅ | ✅ green |
| 61-03-02 | TEAM-02 | Binding, tamper and detector tests, 1000 random sealed entries | Wrong team, member, device or key id fails to open | unit/property | `node --test dist/test/teamSealedKey.test.js dist/test/teamSecrets.test.js` | ✅ | ✅ green |
| 61-04-01 | TEAM-02 | Tracer: keep a per-team NEAR session, refresh through rotation, sign out | Refresh token only in SecretStorage | integration | `node --test dist/test/teamNearSession.test.js` | ✅ | ✅ green |
| 61-04-02 | TEAM-02 | Racing refreshes, expiry, project-scoped team key profile | Rotated token stored before use | integration | `node --test dist/test/teamNearSession.test.js dist/test/teamKeyProfile.test.js dist/test/profileStore.test.js` | ✅ | ✅ green |
| 61-04-03 | TEAM-02 | Browser sign-in with paste fallback extracted into a shared module | No token in any message | unit | `node --test dist/test/reportingTokenEntry.test.js dist/test/reportingSignIn.test.js` | ✅ | ✅ green |
| 61-05-01 | TEAM-02 | Decision: sealed-key event body and rotation rule confirmed | Body and binding recorded before the first is signed | checkpoint | (decision recorded in 61-05-PLAN.md; auto-confirmed) | ✅ | ✅ green |
| 61-05-02 | TEAM-02 | Tracer: a lead appends member.key-sealed over real git and the member's clone opens its key | No clear sk- in the event | integration | `node --test dist/test/teamKeySealedEvent.test.js dist/test/teamValidate.test.js dist/test/teamPermissions.test.js dist/test/teamAudit.test.js dist/test/teamMaterialize.test.js` | ✅ | ✅ green |
| 61-05-03 | TEAM-02 | Delivery rules, device changes, the lead's attention list | Re-seal only by the rules of D-24 | unit | `node --test dist/test/teamKeySealedEvent.test.js dist/test/teamInvite.test.js dist/test/teamMaterialize.test.js` | ✅ | ✅ green |
| 61-06-01 | TEAM-03 | Tracer: a lead removes a member holding claims, leases and allocations; every client releases them identically | Positional rejection of later events from removed devices | unit | `node --test dist/test/teamRelease.test.js dist/test/teamMaterialize.test.js` | ✅ | ✅ green |
| 61-06-02 | TEAM-02/03 | Snapshot compatibility for every new member field; seeded determinism across invite, join, key and removal | Phase 60 snapshot hash unchanged | property | `node --test dist/test/teamRelease.test.js` | ✅ | ✅ green |
| 61-07-01 | TEAM-02 | Tracer: a lead invites a developer over real git and gets a bundle whose code matches the log | Code never in clear text outside the bundle | integration | `node --test dist/test/teamInviteFlow.test.js` | ✅ | ✅ green |
| 61-07-02 | TEAM-02 | Bundle parser hardening, URL cleaning matrix, frozen vector | Remote URL credentials removed | unit | `node --test dist/test/teamInviteBundle.test.js` | ✅ | ✅ green |
| 61-07-03 | TEAM-02 | Lead invitations through NEAR, re-issue, cleanup checklist | A NEAR failure never blocks the team invitation | integration | `node --test dist/test/teamInviteFlow.test.js dist/test/teamInviteBundle.test.js` | ✅ | ✅ green |
| 61-08-01 | TEAM-02 | Tracer: link a team to a NEAR organization and workspace and commit only team.json | Only team.json is committed | integration | `node --test dist/test/teamNearLink.test.js dist/test/teamEnable.test.js` | ✅ | ✅ green |
| 61-08-02 | TEAM-02 | Existing links, refusals, unpushed team.json check | A different link is refused unless replaced | integration | `node --test dist/test/teamNearLink.test.js` | ✅ | ✅ green |
| 61-09-01 | TEAM-02 | Tracer: a developer joins a NEAR-linked team from a second clone with no NEAR request | Non-lead never an org member | integration | `node --test dist/test/teamJoin.test.js` | ✅ | ✅ green |
| 61-09-02 | TEAM-02 | Lead invitee acceptance, no-organization paste path, rollback on failure | A failed join leaves no keys behind | integration | `node --test dist/test/teamJoin.test.js dist/test/teamInvite.test.js` | ✅ | ✅ green |
| 61-10-01 | TEAM-02 | Tracer: the owner confirms a developer; key created with the allocation as its cap, sealed, installed | Limit set in the create call | integration | `node --test dist/test/teamConfirm.test.js` | ✅ | ✅ green |
| 61-10-02 | TEAM-02 | Failure paths: no session, NEAR errors, lost log write, members who need a key without confirmation | A just-made key is zeroed and revoked on failure | integration | `node --test dist/test/teamConfirm.test.js` | ✅ | ✅ green |
| 61-10-03 | TEAM-02 | Rotation on device change with the remaining cap carried over | Rotation cannot give a second budget | integration | `node --test dist/test/teamConfirm.test.js dist/test/teamKeySealedEvent.test.js` | ✅ | ✅ green |
| 61-11-01 | TEAM-03 | Tracer: the owner removes a confirmed developer; limit 0, then the log removal, then the revoke | Spend cut before revoke | integration | `node --test dist/test/teamRemove.test.js` | ✅ | ✅ green |
| 61-11-02 | TEAM-03 | Failures, retries, lead org removal, cancel, idempotency, racing removals | NEAR failure never blocks the log removal; no revoke after a failed cap | integration | `node --test dist/test/teamRemove.test.js dist/test/teamRelease.test.js` | ✅ | ✅ green |
| 61-11-03 | TEAM-03 | The removed member's own machine cleans this team's secrets and keeps everything else | Team secrets discarded; personal profile restored | integration | `node --test dist/test/teamRemove.test.js` | ✅ | ✅ green |
| 61-12-01 | TEAM-02 | Tracer: a developer joins from another clone; the owner's window shows the notification and pending count | Announced once per join event | integration | `node --test dist/test/teamSessionMembers.test.js dist/test/teamSession.test.js` | ✅ | ✅ green |
| 61-12-02 | TEAM-02/03 | Member side: install a delivered key, react to own removal, keep a removed state, offer Join | A removed computer stays stopped | integration | `node --test dist/test/teamSessionMembers.test.js dist/test/teamSession.test.js dist/test/teamSoloParity.test.js` | ✅ | ✅ green |
| 61-12-03 | TEAM-02 | Tag runs by key scope, warn once when a team project uses a non-team key | Personal-key runs are marked | unit | `node --test dist/test/teamKeyScope.test.js dist/test/spendLedger.test.js dist/test/teamSoloParity.test.js` | ✅ | ✅ green |
| 61-13-01 | TEAM-02 | Tracer: Invite to Team through the vscode stub shows the bundle once with Copy and writes member.invited | Bundle shown once, not stored | unit | `node --test dist/test/teamMemberCommands.test.js dist/test/teamManifest.test.js dist/test/teamCommands.test.js` | ✅ | ✅ green |
| 61-13-02 | TEAM-02 | Join Team, Link Team, Sign Out of NEAR (Team), and the Join offer in Enable | No secret in any message | unit | `node --test dist/test/teamMemberCommands.test.js dist/test/teamCommands.test.js dist/test/teamSoloParity.test.js` | ✅ | ✅ green |
| 61-13-03 | TEAM-02/03 | Manage Team Members: members, invitations, cleanup items and every action | Each action asks before it removes | unit | `node --test dist/test/teamMemberCommands.test.js` | ✅ | ✅ green |
| 61-14-01 | TEAM-02/03 | Tracer: the whole lifecycle on three clones and the fake NEAR, linked and unlinked | Limit 0 before the push before the revoke; zero NEAR calls from a developer's join; none at all from an unlinked team | integration | `node --test dist/test/teamFlow.test.js` | ✅ | ✅ green |
| 61-14-02 | TEAM-02 / SEC-01 | Privacy canary over the full flow; opt-in live test file (skips without NEAR_LIVE_TEAM) | No clear-text secret, code, private key or plain email persisted anywhere but SecretStorage and invites.json | integration | `node --test dist/test/teamInvitePrivacy.test.js dist/test/teamNearLive.test.js` | ✅ | ✅ green |
| 61-14-03 | TEAM-02/03 | Phase gate: full suite, e2e (DISPLAY=:0), release check | Solo projects behave as 0.4.8 | regression | `npm run check; DISPLAY=:0 env -u ELECTRON_RUN_AS_NODE node dist/test/e2e/run.js; npm run verify:release` | ✅ | ✅ green |
| 61-14-02 (live) | criterion 3 | Opt-in live test against a real organization | A key at limit 0 answers 402, 200 once raised, then not at all once revoked | live (opt-in) | `NEAR_LIVE_TEAM=1 NEAR_LIVE_TEAM_ACCESS_TOKEN=... NEAR_LIVE_TEAM_ORG_ID=... NEAR_LIVE_TEAM_WORKSPACE_ID=... node --test dist/test/teamNearLive.test.js` | ✅ | ⬜ pending (owner runs it; skipped without the environment) |
| 61-15-01 | TEAM-02 | Tracer: the no-organization notice in the new words, from the core flow to what the commands and status show (G-61-6) | No behaviour change, text only | unit/integration | `node --test dist/test/teamJoin.test.js dist/test/teamMemberCommands.test.js dist/test/teamSessionMembers.test.js` | ✅ | ✅ green |
| 61-15-02 | TEAM-02 | Join, invite, link and team-file sentences say "your organization" | Same refusals, new words only | unit | `node --test dist/test/teamJoin.test.js dist/test/teamFile.test.js dist/test/teamMemberCommands.test.js` | ✅ | ✅ green |
| 61-15-03 | TEAM-02/03 | Remove, key delivery and client manual steps renamed; nothing but text changed | Event, bundle and crypto modules unchanged | unit/integration | `node --test dist/test/teamRemove.test.js dist/test/teamConfirm.test.js` | ✅ | ✅ green |
| 61-16-01 | TEAM-02 | Tracer: checkOnlineHome and teamSetupShared on a real clone, from local commit to shared (G-61-2, G-61-3) | Address read from git config only; local paths never shareable | integration | `node --test dist/test/teamProjectHome.test.js` | ✅ | ✅ green |
| 61-16-02 | TEAM-02 | planShare and shareTeamSetup: fast-forward, setup-only commit and first upload | The person's work is never touched; only team.json is shared | integration | `node --test dist/test/teamProjectHome.test.js` | ✅ | ✅ green |
| 61-16-03 | TEAM-02 | Lost race retried, protected main refused, redaction | No URL or secret in any detail | integration | `node --test dist/test/teamProjectHome.test.js` | ✅ | ✅ green |
| 61-17-01 | TEAM-02 | Tracer: the Team section model for no team and for a lead, drawn as buttons that post team-action (G-61-5) | The page posts only a fixed action id | unit | `node --test dist/test/teamSectionModel.test.js dist/test/teamSectionPage.test.js` | ✅ | ✅ green |
| 61-17-02 | TEAM-02 | Every state, the waiting badge, the board slot and the setup steps | One primary next action per state | unit | `node --test dist/test/teamSectionModel.test.js` | ✅ | ✅ green |
| 61-17-03 | TEAM-02 | Page accessibility, badge and board rendering, e2e probe responder, styles, release list | textContent only; probe answers only under the e2e seam | unit | `node --test dist/test/teamSectionPage.test.js` | ✅ | ✅ green |
| 61-18-01 | TEAM-02 | Tracer: a behind copy of the same project is brought up to date and prepareJoin answers ready (G-61-4) | Fast-forward only | integration | `node --test dist/test/teamJoinCatchUp.test.js` | ✅ | ✅ green |
| 61-18-02 | TEAM-02 | Local changes, unshared work, other version, not shared, offline: the copy is left untouched | Nothing in the copy changes on a refusal | integration | `node --test dist/test/teamJoinCatchUp.test.js` | ✅ | ✅ green |
| 61-18-03 | TEAM-02 | prepareJoin keeps its old answers and catches up for a missing organization link | Same refusals as before | integration | `node --test dist/test/teamJoinCatchUp.test.js dist/test/teamJoin.test.js` | ✅ | ✅ green |
| 61-19-01 | TEAM-01/02 | Tracer: the prompts module, and Enable connecting NEAR AI in place (G-61-1) | Script read only under NEAR_AI_E2E=1 | unit | `node --test dist/test/teamPrompts.test.js dist/test/teamCommands.test.js` | ✅ | ✅ green |
| 61-19-02 | TEAM-02 | The online home is checked before the Enable questions; the handle reports changes (G-61-2) | No question before the warning | unit | `node --test dist/test/teamCommands.test.js dist/test/teamSoloParity.test.js` | ✅ | ✅ green |
| 61-19-03 | TEAM-02 | Share Team Setup: one confirmation, exactly the team setup (G-61-3) | Nothing shared without the confirmation | unit/integration | `node --test dist/test/teamShareFlow.test.js dist/test/teamManifest.test.js` | ✅ | ✅ green |
| 61-20-01 | TEAM-02 | Tracer: Invite shares the team setup first with one confirmation, then asks, then shows the invite | The invite is only in the modal | integration | `node --test dist/test/teamInviteShare.test.js dist/test/teamMemberCommands.test.js` | ✅ | ✅ green |
| 61-20-02 | TEAM-02 | Join brings an existing copy up to date, or says plainly why not with Get a fresh copy (G-61-4) | Pasted invite held only for the command | unit | `node --test dist/test/teamJoinCommand.test.js` | ✅ | ✅ green |
| 61-21-01 | TEAM-02 | Tracer: the sidebar shows the Team section for a project with no team; Turn on Team Mode runs Enable (G-61-5) | Only a known action runs its mapped command | unit | `node --test dist/test/teamSectionHost.test.js dist/test/sidebarChat.test.js` | ✅ | ✅ green |
| 61-21-02 | TEAM-02 | Team states from the running session, the throttled online check, refresh triggers, board slot | Online check at most once a minute while visible | unit | `node --test dist/test/teamSectionHost.test.js dist/test/teamSectionModel.test.js` | ✅ | ✅ green |
| 61-21-03 | TEAM-02 | The e2e probe only under the extension-host tests; solo parity for the sidebar | One stat in a solo project | unit | `node --test dist/test/teamSectionHost.test.js dist/test/teamSoloParity.test.js` | ✅ | ✅ green |
| 61-22-01 | TEAM-01/02 | Tracer, real window: the lead turns Team Mode on, shares and invites from the sidebar; the invite is shown once with Copy invite and main online holds team.json | Online home reached only through a test-only insteadOf rule; no production check changed | e2e | `npm run compile && xvfb-run -a node dist/test/e2e/run.js` (team-lead) | ✅ | ✅ green |
| 61-22-02 | TEAM-02 | Real windows: the invitee joins from a behind copy in a second window, the lead confirms them from Members in the lead's window | Invite text removed from disk after the run; the lead's key never leaves its window (VS Code keeps SecretStorage in memory during extension tests) | e2e | `npm run compile && xvfb-run -a node dist/test/e2e/run.js` (team-join, team-confirm) | ✅ | ✅ green |
| 61-22-03 | TEAM-01/02/03 | Fix-pass gate: full suite, e2e, release check, invariants | No vscode import in the team core; event, bundle and crypto modules unchanged since a7fcba5 | regression | `npm run check; npm run compile && xvfb-run -a node dist/test/e2e/run.js; npm run verify:release` | ✅ | ✅ green |
| 61-23-01 | TEAM-02 | Tracer: the invite modal with Copy invite, how to send it, and a second chance before it is lost (G-61-5) | Clipboard written only on Copy invite | unit/integration | `node --test dist/test/teamMemberCommands.test.js dist/test/teamInviteShare.test.js` | ✅ | ✅ green |
| 61-23-02 | TEAM-02 | Link Your Organization shares what it changed with one confirmation; the push helpers are gone (G-61-3) | Only team.json is shared | unit | `node --test dist/test/teamMemberCommands.test.js dist/test/teamSectionHost.test.js` | ✅ | ✅ green |
| 61-24-01 | TEAM-02 | Tracer: shared plain-words helper, the organization terms in the scan, renamed command titles (G-61-6) | Banned terms scanned in every literal a person reads | unit | `node --test dist/test/teamPlainLanguage.test.js dist/test/teamManifest.test.js` | ✅ | ✅ green |
| 61-24-02 | TEAM-02/03 | Command and session text renamed | Text only | unit | `node --test dist/test/teamMemberCommands.test.js dist/test/teamSessionMembers.test.js dist/test/teamBoardLive.test.js dist/test/nearSignIn.test.js` | ✅ | ✅ green |
| 61-24-03 | TEAM-02 | One-line explanation with Link now or Not now; both scans green | No "NEAR organization" anywhere a person reads | unit | `node --test dist/test/teamPlainLanguage.test.js dist/test/teamMemberCommands.test.js` | ✅ | ✅ green |

Fix pass 61-15 to 61-24 (2026-11-03): every row above from 61-15-01 ran inside the single `npm run check` of the 61-22 gate (1765 tests, 1755 pass, 0 fail, 10 skipped for missing external tools or keys), the e2e ran with all 30 real-window tests green (project, plain, team, team-lead, team-join, team-confirm), and `npm run verify:release` passed (268 entries).

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `src/test/helpers/fakeNear.ts`: org/workspace/member/invitation/key model, session refresh rotation, role enforcement, real-server quirks (camelCase `spendLimit` only, absent field removes the cap, 402 at `usage >= limit`, key secret only in the create response, invite-by-email without invitation id), activation delay, fault injection, a request log that never stores token values
- [x] Test files: `teamInviteBundle`, `teamInvite`, `teamSealedKey`, `teamNearOrg`, `teamNearSession`, `teamJoin`, `teamRemove`, `teamInvitePrivacy`, `teamNearLive`
- [x] Extend `src/test/helpers/teamHarness.ts` / `teamEvents.ts` (invited-member builder, injectable commit time) and `teamCanary.ts` (invite code, access token, X25519 private key canaries)
- [x] No framework install needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Invite, join, confirm and remove against a real NEAR organization | criterion 3 | needs a real org, a lead account and a second person or disposable account | Run the opt-in live test first, then in two windows: link org, invite a developer, join, confirm, run one request on the member's key, raise nothing, remove, and confirm the key returns 402 then 401 |
| Lead invitee accepts the NEAR org invitation | TEAM-02 | needs a real email inbox and login | Invite a disposable address as lead; accept in the extension; check org role is admin |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-11-01 (Nyquist audit: 576 tests across the 37 mapped test files, 574 pass, 0 fail, 2 skipped = the opt-in live NEAR tests, which stay manual-only)

## Validation Audit 2026-11-02

| Metric | Count |
|---|---|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |
