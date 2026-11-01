---
phase: "61"
slug: "invitations-joining-removal-near-org-and-key-integration"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
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

Task IDs are filled in by the planner; rows are per behaviour until then.

| Behaviour | Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-----------|-------------|-----------------|-----------|-------------------|-------------|--------|
| Invite code (160 bit), HKDF proof key vector, bundle encode/parse frozen vector, repo URL credential stripping | TEAM-02 | code never in clear text outside the bundle; URL credentials removed | unit | `node --test dist/test/teamInviteBundle.test.js` | ❌ W0 | ⬜ pending |
| `member.invited` / invite-gated `member.joined` bodies, exact keys, detector exemptions by strict shape, unsupported-type pin updated | TEAM-02 | unknown keys rejected; only strict shapes exempt | unit | `node --test dist/test/teamValidate.test.js` | ✅ update | ⬜ pending |
| Materializer: invited status, self-binding join with proof, replay/wrong device/wrong role/expiry/cancel/re-issue, confirm via role-changed, X25519 public key recorded, Phase 60 snapshot hash unchanged, determinism | TEAM-02 | join valid only with matching unexpired unused invite | unit/property | `node --test dist/test/teamInvite.test.js` | ❌ W0 | ⬜ pending |
| Sealed key event: seal/open round trip, AAD binding (wrong team/member/device/key id fails), only the target device opens it, no clear `sk-` in the event, tamper rejected, re-seal rules (D-24) | TEAM-02 | key reaches only the target device | unit | `node --test dist/test/teamSealedKey.test.js` | ❌ W0 | ⬜ pending |
| `nearOrg.ts` against the fake server: endpoints and casing, mis-cased spend-limit trap guarded by the typed method, error shapes, retry rules, redaction | TEAM-02 | `spendLimit` always sent typed; secrets redacted from errors | integration | `node --test dist/test/teamNearOrg.test.js` | ❌ W0 | ⬜ pending |
| `nearSession.ts`: refresh rotation persisted before use, single-flight, expiry, logout deletes even on failure | TEAM-02 | refresh token only in SecretStorage | integration | `node --test dist/test/teamNearSession.test.js` | ❌ W0 | ⬜ pending |
| End to end on two real clones plus fake NEAR: link org, invite developer (no NEAR invite) and lead (admin invite), join (no NEAR sign-in for non-leads), confirm (role-changed, key created with allocation limit, sealed delivery, profile active), degraded no-org paste path, re-paste after clone | TEAM-02 | non-lead never an org member; limit set at create | integration | `node --test dist/test/teamJoin.test.js` | ❌ W0 | ⬜ pending |
| Release on removal on fixture state; later events from removed devices rejected | TEAM-03 | positional rejection | unit | `node --test dist/test/teamInvite.test.js` | ❌ W0 | ⬜ pending |
| Removal flow: limit 0, log, revoke key (lead: org remove); failures queue the checklist and never block the log; no revoke after failed step 1; repo-access reminder | TEAM-03 | spend cut before revoke | integration | `node --test dist/test/teamRemove.test.js` | ❌ W0 | ⬜ pending |
| Removed client: wipes device keys (Ed25519 and X25519), team key profile, session; restores personal profile; no retries | TEAM-03 | team secrets discarded | integration | `node --test dist/test/teamRemove.test.js` | ❌ W0 | ⬜ pending |
| Commands through the vscode stub: invite, join, manage members, link org, sign out; pending count; no em-dashes or secrets in messages | TEAM-02/03 | — | unit | `node --test dist/test/teamCommands.test.js` | ✅ extend | ⬜ pending |
| Privacy canary over the full flow: API key, access and refresh tokens, clear-text code, device private keys absent from coordination blobs, `team.json`, settings, audit, transcripts, output channel, storage files | SEC-01 / criterion 4 | no clear-text secret persisted | integration | `node --test dist/test/teamInvitePrivacy.test.js` | ❌ W0 | ⬜ pending |
| Opt-in live test: org/workspace listing, key create with limit, `check_api_key` 402 at 0, raise then 200, revoke | criterion 3 | — | live (opt-in) | `NEAR_LIVE_TEAM=1 ... node --test dist/test/teamNearLive.test.js` | ❌ W0 (skips without env) | ⬜ pending |
| Solo parity | criterion 5 | — | regression | `npm run check` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/test/helpers/fakeNear.ts`: org/workspace/member/invitation/key model, session refresh rotation, role enforcement, real-server quirks (camelCase `spendLimit` only, absent field removes the cap, 402 at `usage >= limit`, key secret only in the create response, invite-by-email without invitation id), activation delay, fault injection, a request log that never stores token values
- [ ] Test files: `teamInviteBundle`, `teamInvite`, `teamSealedKey`, `teamNearOrg`, `teamNearSession`, `teamJoin`, `teamRemove`, `teamInvitePrivacy`, `teamNearLive`
- [ ] Extend `src/test/helpers/teamHarness.ts` / `teamEvents.ts` (invited-member builder, injectable commit time) and `teamCanary.ts` (invite code, access token, X25519 private key canaries)
- [ ] No framework install needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Invite, join, confirm and remove against a real NEAR organization | criterion 3 | needs a real org, a lead account and a second person or disposable account | Run the opt-in live test first, then in two windows: link org, invite a developer, join, confirm, run one request on the member's key, raise nothing, remove, and confirm the key returns 402 then 401 |
| Lead invitee accepts the NEAR org invitation | TEAM-02 | needs a real email inbox and login | Invite a disposable address as lead; accept in the extension; check org role is admin |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
