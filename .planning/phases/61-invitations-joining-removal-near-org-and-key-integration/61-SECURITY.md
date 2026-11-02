---
phase: "61"
slug: "invitations-joining-removal-near-org-and-key-integration"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-01"
---

# Phase 61 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Public coordination branch to anyone with read access | Every invite, join and sealed-key body is readable by anyone who can read the repository | Code-derived public keys, countersignatures, sealed key ciphertext (must hold no clear secret) |
| Joiner's client to log | A not-yet-trusted device writes the first event that binds it | Join proof, device and X25519 seal public keys |
| Extension to NEAR AI Cloud | Lead sessions create, cap, revoke keys and manage org membership; members hold a bearer key only (D-21) | Refresh/access tokens, `sk-` key secrets, spend limits |
| NEAR responses to extension | Response and error text is untrusted and may reach the UI | Org, invitation and key metadata, error text |
| Lead device to public log to member device | The member's key travels sealed to one device (D-23) | AES-256-GCM ciphertext, AAD binding team, member, device and key id |
| SecretStorage to process memory | Refresh token, device/seal private keys and the team key are loaded only to make a request, open a delivery or build a profile | Secrets (zero-filled after use) |
| Lead's clipboard to chat or email to invitee | The invite bundle travels over channels the extension does not control | Invite code, team id, cleaned repository URL |
| Pasted bundle to join / git clone | The bundle may be stale, forged or meant for another team; its URL may be passed to VS Code's `git.clone` | Repository URL, team id, ref |
| team.json in the repository to every client | Untrusted input any committer can edit | `near` organization and workspace ids |
| Log and NEAR text to notifications and status bar | Names and labels are attacker-influenced | Display names, labels |
| Log to removed member's client | The client deletes local secrets when it sees its own accepted removal | Team-scoped SecretStorage entries and storage files |
| Test environment to real NEAR | Only the opt-in live test crosses it, with an owner-provided token | Owner token (environment only) |

---

## Threat Register

Extracted from the `<threat_model>` tables of 61-01 to 61-14 (T-61-SC appears in every plan and is listed once), plus T-61-64 found while verifying the 61-13 summary threat flag. Evidence (file:line and covering tests) for every row is in the 2026-11-01 security audit (gsd-security-auditor, ASVS L1); the auditor ran 266 focused compiled tests (all pass; the 2 skips are the opt-in live NEAR test, which was not run).

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-61-01 | Information disclosure | member.invited / member.joined bodies | high | mitigate | Only the HKDF-derived public key and a countersignature are logged (`domain/team/validate.ts`, `team/inviteCode.ts`); remote-wide object scan for the code in three renderings | closed |
| T-61-02 | Spoofing | self-bound join branch | high | mitigate | Proof binds team, member, invite event id, device and seal key; envelope verified against the body key; fingerprint must be new (`domain/team/materialize.ts`) | closed |
| T-61-03 | Tampering | replay of a captured member.joined | high | mitigate | Duplicate event ids rejected; single use is structural (status leaves invited); replay, second-join and racing-join tests | closed |
| T-61-04 | Elevation of privilege | joined role and email hashes | high | mitigate | Role must equal expectedJoinRole; email hashes must match the invite; owner not in INVITABLE_ROLES; member.invite is owner/lead only | closed |
| T-61-05 | Elevation of privilege | stale bundle after expiry | low | accept | Commit-time expiry is hygiene; real controls are code secrecy, cancel and single use (AR-61-01) | closed |
| T-61-06 | Tampering | spend-limit request body | critical | mitigate | Single integer-only camelCase `spendLimitBody`; stored limit asserted after create and set; fake reproduces the null-on-missing trap (`team/nearOrg.ts`) | closed |
| T-61-07 | Information disclosure | NEAR client errors and logs | high | mitigate | `scrubNearText` redacts and bounds NEAR text to 300 chars; no request bodies logged; test asserts no token in errors or fake log | closed |
| T-61-08 | Denial of service | retries | medium | mitigate | Bounded retries honouring Retry-After for idempotent calls only; POST never retried | closed |
| T-61-09 | Tampering | orphan keys after a failed create | medium | mitigate | Failed create lists by unique name and revokes matches; limit mismatch abandons the key | closed |
| T-61-10 | Spoofing | base URL | medium | mitigate | `isSecureEndpoint` enforced in NearOrgClient, checkApiKey and NearSession; loopback http only for the fake | closed |
| T-61-11 | Information disclosure | sealed entry in the log | critical | mitigate | Ephemeral X25519 ECDH, HKDF-SHA256, AES-256-GCM to the target device (`team/keySeal.ts`); other-device-key test | closed |
| T-61-12 | Tampering | sealed entry fields | high | mitigate | AAD binds team, member, device and key id; any tamper returns undefined, never throws | closed |
| T-61-13 | Information disclosure | secret-detector exemption | high | mitigate | Exemptions only by exact shape under exact key names; token-like ciphertext never exempt; private keys still caught; 1000-entry random test | closed |
| T-61-14 | Information disclosure | ciphertext permanence | medium | accept | Every sealed key is capped and revoked on removal and rotated on device change (D-24), so old ciphertext only holds a revoked key (AR-61-02) | closed |
| T-61-15 | Spoofing | refresh token theft or reuse | high | mitigate | Refresh token in SecretStorage only; access token memory-only; rotation single-use; sign out deletes the secret | closed |
| T-61-16 | Denial of service | concurrent refresh | medium | mitigate | Single-flight, persist before use, re-read and retry once; two-window race test | closed |
| T-61-17 | Information disclosure | tokens in errors | high | mitigate | Fixed-text messages; tests assert no token in message or stack | closed |
| T-61-18 | Elevation of privilege | wrong key installed as team key | medium | mitigate | `verifyKey` matches organization, workspace and key id when NEAR-linked; profile selected only after validation | closed |
| T-61-19 | Tampering | personal profile lost on removal | medium | mitigate | Previous profile remembered in join.json and restored; removeTeamKey removes only the team profile | closed |
| T-61-20 | Elevation of privilege | member.key-sealed author | high | mitigate | Matrix row owner/lead only, checked on write and read; owner target denied | closed |
| T-61-21 | Information disclosure | key re-sealed to an extra device | high | mitigate | Sealed devices must equal the member's active seal-capable devices; key ids never repeat | closed |
| T-61-22 | Tampering | sealed entry for another member's device | medium | mitigate | Each sealed device must belong to the target member, be unrevoked and have a seal key; AAD binds member and device | closed |
| T-61-23 | Repudiation | which keys a member ever held | low | mitigate | `retiredNearKeyIds` kept in state and used by removal | closed |
| T-61-24 | Elevation of privilege | removed member's later events | high | mitigate | `boundKey` rejects authors removed before the event (positional); `removedAuthor` reason asserted | closed |
| T-61-25 | Tampering | divergent release between clients | medium | mitigate | Deterministic insertion-order iteration; 20-seed property test replays twice and incrementally | closed |
| T-61-26 | Repudiation | allocation history lost on removal | low | accept | Allocations deleted, not archived, until Phase 66 defines allocation history (AR-61-03) | closed |
| T-61-27 | Information disclosure | repo URL in the bundle | high | mitigate | `cleanRepoUrl` drops userinfo, refuses query, fragment and local paths, then findSecrets; parse requires the cleaned URL; URL never logged (see T-61-64 for a residual gap below threshold) | closed |
| T-61-28 | Information disclosure | invite code at rest | high | mitigate | Code only in memory and the returned bundle; bytes zero-filled in finally; invites.json, cleanup.json and all blobs scanned | closed |
| T-61-29 | Tampering | hostile bundle input | medium | mitigate | Exact prefix, 4096-byte cap, strict base64url, prototype-safe exact-key parse, id and ref patterns, fixed error text | closed |
| T-61-30 | Elevation of privilege | lead invitee becomes NEAR org admin before team confirmation | medium | accept | NEAR sends the admin invitation at invite time (D-22); cancel or remove cancels the invitation or org membership, else a manual item (AR-61-04) | closed |
| T-61-31 | Information disclosure | email sent to NEAR for non-leads | low | mitigate | Only lead invitations call NEAR; tests assert no request for developer, reviewer and observer | closed |
| T-61-32 | Tampering | team.json `near` edited by a committer | high | mitigate | Corrected after code review CR-01: the link also decides where a removal caps and revokes keys and which organization and workspace a delivered key must belong to (`keyDelivery.ts` passed `expect: teamFile.near`). Mitigated by a local NEAR link pin (`teamFile.ts` `checkNearPin`, `near-pin.json` beside `trust.json`, taken at link, join or first read, moved only by the lead's Link command); every key step (`remove.ts`, `keyDelivery.ts`, `invite.ts`) refuses a mismatched link, and a key NEAR does not find in the linked workspace is a manual console item with KEY_STILL_SPENDS_WARNING, never done. Tests: teamRemove.test.ts and teamConfirm.test.ts "CR-01: ...", teamFile.test.ts and teamNearLink.test.ts "CR-01: ...". Residual first-sight risk is AR-61-05 | closed |
| T-61-33 | Tampering | unrelated staged work committed | medium | mitigate | `git commit --only` with the single team.json path, shared with Enable; staged-unrelated-file test | closed |
| T-61-34 | Information disclosure | secrets in team.json | high | mitigate | assertNoSecrets before writeTeamFile; extra keys refused | closed |
| T-61-35 | Elevation of privilege | non-lead member with NEAR org access | high | mitigate | Only lead joins reach acceptAsLead; test asserts zero NEAR requests and no session for non-leads | closed |
| T-61-36 | Spoofing | bundle for another team or repo | medium | mitigate | prepareJoin and joinTeam compare team id, ref and near with team.json; trust pin checked before any write | closed |
| T-61-37 | Tampering | partial join leaves keys behind | medium | mitigate | Rollback removes device and seal keys on any definitive failure; session and profile created only after a successful write; per-failure-kind tests | closed |
| T-61-38 | Information disclosure | bundle kept across windows | medium | mitigate | Bundle only in call arguments; nothing stored; re-paste after clone (D-26) | closed |
| T-61-39 | Spoofing | lead accepts the wrong org's invitation | low | mitigate | Invitations filtered by the team's organization id; already-member checked via currentUser | closed |
| T-61-40 | Elevation of privilege | member raises own cap | high | mitigate | Members are not org members and hold no session (D-21); keys created and capped by the lead's session | closed |
| T-61-41 | Information disclosure | clear key in memory or at rest | high | mitigate | Buffer zero-filled in finally on both lead and member sides; privacy canary scans all stores with positive controls | closed |
| T-61-42 | Tampering | undelivered key left spendable | medium | mitigate | Refused append zeroes then revokes the key; failures queued as zero-limit and revoke-key items | closed |
| T-61-43 | Elevation of privilege | rotation doubles a member's budget | medium | mitigate | New limit = max(0, old limit minus lifetime usage), 0 when unknown | closed |
| T-61-44 | Elevation of privilege | another lead changes any key's limit | low | accept | Leads are trusted with budgets (D-27); Phase 66 reconciliation can flag drift (AR-61-06) | closed |
| T-61-45 | Information disclosure | member extracts the key from SecretStorage | low | accept | Bearer credential bounded by the provider cap (D-27) (AR-61-07) | closed |
| T-61-46 | Elevation of privilege | in-flight overshoot after a cap is reached | low | accept | NEAR checks spend asynchronously; seconds of overshoot (research finding 4, D-27) (AR-61-08) | closed |
| T-61-47 | Elevation of privilege | removed member keeps spending | high | mitigate | Limit 0 first on every current and retired key; revoke only after a successful cap; KEY_STILL_SPENDS_WARNING with Retry | closed |
| T-61-48 | Tampering | wrong org member removed | high | mitigate | Org member matched only by email hash, never a log id; no match, multiple matches, owners and the remover become a manual item. With today's NEAR API (no member emails) lead org removal is always a manual console step; nobody is removed on a guess | closed |
| T-61-49 | Denial of service | NEAR outage blocks removal | medium | mitigate | member.removed always written; NEAR steps queued with Retry | closed |
| T-61-50 | Tampering | removed client deletes unrelated data | high | mitigate | Only this team's named SecretStorage entries and storage files; no git calls; ~/.near-credentials never referenced; tests check other secrets and git state | closed |
| T-61-51 | Information disclosure | repo access outlives removal | medium | transfer | Git remote access is outside the extension (spec 6.2); checklist always ends with "remove repository access" (TR-61-01) | closed |
| T-61-52 | Elevation of privilege | demoted lead keeps NEAR admin | low | accept | No demotion command in this phase; removal of anyone who was or was invited as lead targets the org membership (AR-61-09) | closed |
| T-61-53 | Tampering | hostile member names in UI | medium | mitigate | safeReason / displayText flatten, bound to 60 chars and escape `$(`; `$(zap)` and newline tests | closed |
| T-61-54 | Spoofing | fake removal triggering cleanup | high | mitigate | Cleanup only from an accepted member.removed for this device's member in trusted materialised state; member.remove is owner/lead only on read | closed |
| T-61-55 | Elevation of privilege | removed client keeps writing | medium | mitigate | Removed flag set before any await, scheduler stopped, marker persisted, adoptSigner refuses removed members; no git writes afterwards | closed |
| T-61-56 | Repudiation | spend on a personal key in a team project | low | mitigate | keyScope tag on every provider request; one-time warning with a switch action | closed |
| T-61-57 | Information disclosure | bundle and pasted key in UI | high | mitigate | Bundle in one modal and clipboard on Copy only; password inputs for pasted invite, link and key; tests scan everything shown | closed |
| T-61-58 | Tampering | allocation amount parsing | medium | mitigate | parseUsdToNanoUsd string arithmetic, max 2 decimals, no negatives or exponents, isSafeInteger | closed |
| T-61-59 | Elevation of privilege | actions offered to the wrong role | medium | mitigate | Actions filtered by decideTeamAction; log re-checks on write and read | closed |
| T-61-60 | Repudiation | misleading cap wording | medium | mitigate | Cap wording only when team.json has `near`; unlinked teams show NO_ORG_NOTICE | closed |
| T-61-61 | Information disclosure | secrets persisted by the full flow | critical | mitigate | Privacy canary over the full lifecycle (remote, mirrors, team.json, .planning, storage, output, notifications, status bar, settings, commit text) with positive controls | closed |
| T-61-62 | Information disclosure | live test token | medium | mitigate | Token only from the environment, never printed; key zeroed and revoked in finally; skips without NEAR_LIVE_TEAM=1 | closed |
| T-61-63 | Tampering | regression in solo projects | medium | mitigate | teamSoloParity.test.ts unweakened; teamManifest.test.ts command registration; e2e handler check | closed |
| T-61-SC | Tampering | npm/pip/cargo installs | high | mitigate | No package installs in any plan; dependency sets and package-lock.json identical to the merge base; enforced by teamManifest.test.ts | closed |
| T-61-64 | Tampering | `cleanRepoUrl` scp-style branch passed to `git.clone` (61-13 threat flag) | low | mitigate | Found in audit: git remote-helper pseudo-URLs (`ext::sh`, `fd::3`, `hg::https://x/y`) and `ssh://-oProxyCommand=…/x` pass `cleanRepoUrl` unchanged. Neutralised by git defaults (ext transport not allowed; ssh hostname starting with `-` blocked), reachable only with `protocol.ext.allow`, an old git or an installed helper, a hostile team member and the user clicking Clone. Fix: reject `::` in the scp branch and ssh hosts starting with `-` in `src/team/inviteBundle.ts` | open — below high threshold (non-blocking) |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-61-01 | T-61-05 | Invite expiry uses commit time, which a code holder controls; it is hygiene only. Real controls are code secrecy, cancel and structural single use (research, D-08) | Plan 61-01 threat model | 2026-11-01 |
| AR-61-02 | T-61-14 | A sealed key stays in the public log forever; every key ever sealed is capped and revoked on removal and rotated on device change (D-24), so old ciphertext only ever holds a revoked key | Owner (D-24), plan 61-03 threat model | 2026-11-01 |
| AR-61-03 | T-61-26 | Allocations are deleted rather than archived on removal until Phase 66 defines allocation history (research A6) | Plan 61-06 threat model | 2026-11-01 |
| AR-61-04 | T-61-30 | NEAR sends the admin invitation to a lead invitee at invite time (D-22); leads are trusted with budgets (D-27); cancel or removal cancels the NEAR invitation or removes the org membership, falling back to a manual console item when NEAR gives no email | Owner (D-22, D-27), plan 61-07 threat model | 2026-11-01 |
| AR-61-05 | T-61-32 | Corrected 2026-11-01 after code review CR-01. The earlier text said a forged link could only steer key creation and that members use the link only to choose paste or wait; that was wrong: it also chose the workspace a removal capped and revoked in (a key not found there counted as done) and, through `keyDelivery.ts` `expect: teamFile.near`, the organization and workspace a member's delivered key had to belong to. Those paths are now mitigated (T-61-32). What remains accepted: the pin is trust on first use, so a client whose first sight of a linked team.json is already forged pins the forged link. Even then a removal never reports a key it could not cap in that workspace as capped (it becomes a manual NEAR console item with the can-still-spend warning), keys are only created where NEAR's role checks let the lead create them, and a member's key install fails closed on an organization or workspace mismatch | Plan 61-08 threat model, corrected by code review fix CR-01 | 2026-11-01 |
| AR-61-06 | T-61-44 | Another lead can change any member key's limit; leads are trusted with budgets; Phase 66 reconciliation can flag drift | Owner (D-27) | 2026-11-01 |
| AR-61-07 | T-61-45 | A member who extracts the key from SecretStorage holds a bearer credential, but can spend only up to the provider cap set by the lead | Owner (D-27) | 2026-11-01 |
| AR-61-08 | T-61-46 | NEAR enforces recorded spend asynchronously, so a few seconds of in-flight requests can exceed the cap (research finding 4) | Owner (D-27) | 2026-11-01 |
| AR-61-09 | T-61-52 | No demotion command exists in this phase, so a demoted lead keeping NEAR admin cannot arise; removal of anyone who was or was invited as lead targets the org membership | Plan 61-11 threat model | 2026-11-01 |

**Transferred:**
- TR-61-01 (T-61-51): git remote (repository) access is managed outside the extension (spec 6.2). The removal checklist always ends with a manual "remove repository access" item, ordered last in the UI.

**Known accepted limitation (owner, 61-11):**
- NEAR's `GET /organizations/{org}/members` returns no member emails, so removing a lead (or cancelling a lead invitation the invitee already accepted) always leaves a manual "remove them in the NEAR console" item. This is the fail-safe branch of T-61-48: no organization DELETE is sent without an email-hash match. The code removes the member automatically once NEAR returns member emails.

**Advisories (non-blocking at ASVS L1):**
- A1 (T-61-64, also T-61-27/T-61-29): harden `cleanRepoUrl` against git remote-helper syntax (`<helper>::<address>`) and ssh hosts starting with `-` before relying on it beyond git's defaults.
- A2 (T-61-55): `verifyAll` still performs a read-only fetch after removal; it writes nothing and is informational.
- A3 (T-61-62): the opt-in live test cancels its disposable NEAR invitation only if the pending-list lookup succeeded; opt-in only, not run in this audit.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-01 | 65 (T-61-01..T-61-64 plus T-61-SC counted once) | 64 (53 mitigate, 10 accept or transfer, plus T-61-SC) | 1 (T-61-64, low, below block threshold; 0 blocking) | gsd-security-auditor (ASVS L1, block on high) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-01
