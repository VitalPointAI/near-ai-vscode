# Phase 61: Invitations, joining, removal, NEAR org and key integration - Research

**Researched:** 2026-11-01
**Domain:** Signed-event-log membership lifecycle (invite, self-bound join, cancel, remove) plus a `vscode`-free NEAR AI Cloud org/key client, kept NEAR session, and project-scoped team key profile
**Confidence:** HIGH for the NEAR API contract and the crypto design (both verified this session against the live OpenAPI document, the provider's source and `node:crypto`); MEDIUM for provider behaviours that only a live test can confirm (propagation delay, plain-member tamper rights, wallet-user emails)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
D-01 The NEAR session is kept, not discarded. The OAuth sign-in from `src/services/reportingSignIn.ts` is reused, but instead of signing out at once, the session's refresh token is stored in SecretStorage and access tokens are refreshed as needed. Status shows "NEAR: signed in as <account>" and a `NEAR AI: Sign Out of NEAR (Team)` command revokes the session (`POST /v1/auth/logout`) and deletes it. One sign-in serves invite and remove now and Phase 66's grant-time limit raises and usage reconciliation. The existing `rpt-` reporting-token flow is unchanged.
D-02 The session is scoped per team: SecretStorage key `nearAi.team.nearSession.<teamId>`. Signing out of one team leaves others alone. An invitee signs in only to accept the org invite and create their key, and is signed out after join.
D-03 Linking a NEAR organization: the first invite on a team without `team.json` `near` offers "Link a NEAR organization" (sign in, pick organization and workspace from lists, or skip). A standalone `NEAR AI: Link Team to NEAR Organization` command does the same. Linking writes `near: { organizationId, workspaceId }` into `team.json` and commits only that file on the current branch, the same way Enable does (`git add -f`, `git commit --only`, offer Push, never push automatically).
D-04 Teams without a NEAR organization can still invite and join, visibly degraded: log-only flow, the member supplies their own key, no provider spend cap, and the roster says so plainly ("No NEAR organization linked: spend is not capped at the provider").
D-05 The bundle is one pasteable string, `near-ai-invite-v1.<base64url of canonical JSON>`, holding repo URL, team ID, coordination ref and the single-use code. `NEAR AI: Join Team` accepts it. Shown once in a dialog with Copy; the code is never logged, stored in clear text, or shown again. Only a hash or derived public value is stored; a lost bundle means Re-issue. Same in desktop VS Code and code-server. Reversibility: costly (a v2 format must keep accepting v1).
D-06 The repo URL in the bundle has any credentials (userinfo, tokens) removed. If it cannot be cleaned, the invite refuses with the reason. The URL is never logged.
D-07 If Join runs outside a repo whose `team.json` matches the bundle's team ID, it offers VS Code's built-in Git: Clone with the bundle's URL, then resumes Join once the matching `team.json` is found. Opening a repo that has `team.json` but no local membership also offers Join.
D-08 Invite expiry defaults to 7 days; the lead can choose 24 hours, 3 days, 7 days or 14 days. Expiry is evaluated without wall-clock ordering. Research decides the exact rule.
D-09 The single-use code must prove possession without appearing in the log. Suggested: derive an Ed25519 key pair from the code; `member.invited` records the derived public key; `member.joined` is countersigned by the derived key over the joiner's device public key. Not replayable. At least 128 bits of entropy. Reversibility: one-way.
D-10 `member.invited` creates a member record in an `invited` status carrying the email hash, role, allocation (integer nano-USD), expiry and the code proof value. No new event type for cancel: cancelling writes `member.removed` for the invited member's id. Re-issue cancels the old invite and writes a new `member.invited` with a new code. Reversibility: one-way.
D-11 `NEAR AI: Manage Team Members` lists members and invitations (pending, expired, used) with Cancel and Re-issue on invitations and Confirm and Remove on members.
D-12 At join, after the invitee signs in and accepts the org invitation, the default creates a new API key in the team workspace named after team, member and device, and stores it directly in project-scoped SecretStorage. Alternative: paste an existing key, validated against the team's organization and workspace through `/v1/check_api_key`. Only the key ID is recorded in the log. Without a linked NEAR organization only paste is offered and there is no workspace check.
D-13 A new key starts with a spend limit of 0. When the lead confirms (D-15), the lead's client sets the key's limit to the invite's allocation. Phase 66 raises it per grant. Who may set limits and create keys is a research question; if the invitee cannot, research says which party does it.
D-14 After join, the team key becomes the project's active credential as a new project-scoped profile. The member's personal profile is kept. Team runs that use a non-team key are tagged and warned about.
D-15 Confirmation writes `member.role-changed` from `observer` to the invited role; no new event type. Then the lead's client sets the key's spend limit. Invited role `observer`: confirmed on join. With `requireLeadConfirmation: false`, `member.joined` takes the invited role directly. Reversibility: one-way.
D-16 A sync that brings in a `member.joined` awaiting confirmation shows "<name> joined <team> and is waiting for confirmation" with Confirm and Remove in the lead's or owner's window; the Team status bar shows a pending count; Manage Team Members covers it.
D-17 Removal order: (1) set the key's spend limit to 0; (2) write `member.removed` (with device revocation); (3) revoke the NEAR key; (4) remove the member from the NEAR organization. The key is never revoked before step 1 succeeds.
D-18 A failed NEAR step never blocks the log removal. Failed or skipped steps go into a local "NEAR cleanup pending" checklist with Retry, persisted locally with no secrets, shown in Manage Team Members. If step 1 fails, warn prominently that the key can still spend. The checklist ends with the reminder to remove repository access.
D-19 On removal the materialiser releases the member's claims to `ready` (branches preserved), releases their leases and revokes their allocations (unspent returns to the pool), proven on fixture state in this phase.
D-20 When the removed member's own client syncs its `member.removed`, it stops team sync and shows "You were removed from <team>". It deletes this team's device key, team API key profile and NEAR session from SecretStorage, and reactivates the personal profile if one exists. Local code and branches are untouched. Team Mode for that project shows a removed or read-only state rather than retrying.

### Claude's Discretion
- Exact event body field names, beyond the constraints above, and the bundle's JSON shape.
- Code alphabet and length (subject to at least 128 bits, D-09), and how the code is shown.
- Key naming format (D-12), wording of notifications and checklist items (plain language, no em-dashes), and where the cleanup checklist is persisted.
- Module split for the commands (`src/services/team/*`) and `nearOrg.ts` internals; retry and backoff on NEAR HTTP errors.

### Deferred Ideas (OUT OF SCOPE)
- Re-joining after removal, adding a second device for an existing member through an invite-like flow, and per-role limits on who a lead may invite (planner applies spec 6.1 to 6.3 defaults).
- A `vscode://` deep link for the bundle.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEAM-02 | A lead can invite a person by email with role and allocation; the invitee joins with a single-use code and gets their own NEAR access and key. | Sections "Invite and join protocol", "NEAR AI Cloud contract", "Project-scoped key storage", "Lead session" |
| TEAM-03 | A lead can remove a member; their claims, leases and allocations are released and later events from their keys are rejected. | Sections "Materializer changes" (release on removal, positional rejection already present), "Removal flow and cleanup checklist" |
</phase_requirements>

## Summary

The NEAR side is fully specified by the provider's own OpenAPI document (`https://cloud-api.near.ai/api-docs/openapi.json`, 453 KB, fetched and parsed this session) and its open-source server (`github.com/nearai/cloud-api`, read at commit `72d98902`). Every endpoint the spec appendix listed exists with a session (JWT) bearer. The docs' open question is answered by the server source: **`spendLimit` is the request casing and `spend_limit` the response casing; a key's limit is lifetime and cumulative, not per period** (usage is summed over all time and the check is `spent >= limit`, so a limit of `0` blocks the key immediately). **Any organization member, including role `member`, can create workspace keys and can set, raise or remove the limit of any key in the workspace.** So the invitee can create their own key with `spendLimit: 0` (good, matches D-12/D-13), but the provider cap is a guard against honest mistakes and overruns, not against a member who calls the API with their own session. That residual risk must be stated to the owner and is the main open question.

The membership protocol fits the Phase 60 pipeline with three contained changes: (1) `member.invited` becomes an implemented type; (2) a non-genesis `member.joined` is **self-bound** (signed by the not-yet-bound device, verified against the public key inside its own body, and gated by an Ed25519 countersignature from a key derived from the code), which needs a branch before step 3 of the pipeline; (3) `member.removed` gains release-on-removal and doubles as cancel for `invited` members. Everything new on `Member` is an **optional field**, so Phase 60 snapshots and state hashes stay byte-identical. The code-derived key was verified with `node:crypto` (PKCS#8 prefix `302e020100300506032b657004220420` + 32-byte HKDF seed gives a working, deterministic Ed25519 key). Invite expiry cannot use wall-clock ordering; the deterministic rule is a **commit-time delta carried by the transport** (`join.commitTime - invite.commitTime <= ttlSeconds + 300`), which is hygiene for stale bundles, not a defence against a code holder (a code holder controls their own commit date).

The kept NEAR session rotates its refresh token on every refresh (`POST /v1/users/me/access-tokens` returns a new `refresh_token`; reusing the old one is a 401), so token handling needs a single-flight refresh, immediate persistence of the new token, and a re-read-and-retry for two windows racing. The two `main`-only commits (`d637578` paste-to-finish sign-in, `403c06e` 404-usage-summary) should be **merged into this branch before Phase 61 starts** (a dry-run merge conflicts only in four `.planning/*` files, never in `src/`), and the private `browserSignIn` helper in `spendTracking.ts` should be extracted to a shared module with a parameterised prompt, because its paste-box text says the session "is signed out as soon as the token is made", which is false for a kept session.

**Primary recommendation:** Build the pure protocol first as a tracer slice (types, validators, materializer, bundle/code/proof crypto, release-on-removal, all on fixtures), then the `nearOrg.ts` client with a fake NEAR server that reproduces the real server's casing, rotation and limit semantics, then the invite/join/remove flows over real git, and only then the VS Code adapters. Send `spendLimit` only through a typed integer-nano-USD method that can never serialise a missing field (a missing or mis-cased field silently removes the cap on the real server).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Invite/join/remove event validity, roles, expiry, release-on-removal | `src/domain/team/*` (pure) | `src/team/eventLog.ts` write-side | Single decision point used when writing and reading (Phase 60 D-09/D-12); must be deterministic and `vscode`-free |
| Code, derived key, join proof, bundle encode/parse, URL cleaning | `src/team/inviteBundle.ts` + `inviteCode.ts` (Node, no vscode) | `src/domain/team` for the verify half | Crypto and parsing on untrusted input; unit-testable with fixed vectors |
| NEAR org/invitation/key/limit/usage HTTP | `src/team/nearOrg.ts` (injected `fetch`) | fake server in tests | Same pattern as `reportingSignIn.ts`; no `vscode` |
| Kept lead session, refresh rotation | `src/team/nearSession.ts` over `SecretStorageLike` | `src/services/team/nearSignIn.ts` (vscode: browser, paste box) | Token logic is testable; the browser dance is the only editor-specific part |
| Invite, join, confirm, remove, link orchestration | `src/team/{invite,join,remove,nearLink}.ts` (vscode-free, like `enable.ts`) | `src/services/team/teamCommands.ts` adapters | Real-git testability; adapters only ask questions and show results |
| Team key profile and activation | `ProfileStore` + `AuthService` (existing, vscode-free) | adapter picks `workspaceRoot` and `context.secrets` | Reuse of `ProjectCredentialScope` (D-14) |
| Pending-confirmation count, removed state, notifications | `src/services/team/teamSession.ts`, `teamStatusBar.ts` | local files under `<globalStorage>/team/<teamId>/` | Editor surface; derived from `TeamState` |
| Provider spend cap | NEAR AI Cloud (server-side) | lead client sets it | The only hard cap; client checks are advisory |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | Node built-in (host 24.22.2; extension floor is Node 22 via VS Code) | HKDF, Ed25519 key from seed, sign/verify, `randomBytes` | Already used for device keys; no dependency allowed (PROJECT.md) |
| `node:http` | built-in | Fake NEAR API server in tests | Pattern already used by `reportingSignIn.ts` tests |
| `node:test` + `node:assert/strict` | built-in | Test runner | Existing suite |
| global `fetch` via injected `FetchLike` | built-in | NEAR HTTP | Same injection as `reportingSignIn.ts` (`FetchLike`) |

### Supporting (existing in-repo modules to reuse, not packages)
| Module | Purpose | When to Use |
|--------|---------|-------------|
| `src/domain/team/canonical.ts` (`canonicalize`, `canonicalBytes`, `verifySignature`, `isStrictBase64url`) | Canonical bytes for the join proof and the bundle JSON | Every signed or hashed structure |
| `src/team/identity.ts` (`createDeviceIdentity`, `loadDeviceIdentity`, `forgetDeviceIdentity`, `newMemberId`, `emailHash`, `newEventId`) | Device key, ids, email hash | Join and invite |
| `src/team/eventLog.ts` (`TeamLog`, `prepareEvents`) | Write side | Extend for `member.invited` and invite-gated `member.joined` |
| `src/team/enable.ts` commit pattern (`git add -f`, `git commit --only`) | Link NEAR organization commit | Extract the commit step into a shared helper, do not copy |
| `src/services/profileStore.ts` + `src/services/auth.ts` | Team key profile | D-12, D-14, D-20 |
| `src/services/reportingSignIn.ts` (`loginUrl`, `parseCallback`, `startLoopbackSignIn`, `firstSession`, `signOut`, `FetchLike`, `SignInError`) | Browser sign-in and logout | Lead session and invitee sign-in |
| `src/services/nearAiClient.ts` `checkApiKey()` | Paste path validation | D-12 alternative |
| `src/test/helpers/teamHarness.ts`, `teamCanary.ts`, `teamEvents.ts`, `vscodeStub.ts` | Two-clone fixtures, canaries, signed-event builders, vscode stub | All new tests |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| HKDF-SHA256 seed (no stretching) | `scrypt` stretching of the code | Not needed: the code is 160 random bits; stretching only helps low-entropy secrets and adds cost. Verified `scryptSync` takes ~75 ms, so it is cheap but pointless here |
| Commit-time expiry | Absolute `expiresAt` in the body | Author clock is forgeable and "never used for ordering"; a duration measured between two transport-carried commit times is deterministic across clients |
| Dedicated `/spend-limit` PATCH | General `PATCH /api-keys/{id}` with `spendLimit` | The general endpoint cannot send `null`; the dedicated one removes the limit when the field is absent. Prefer the dedicated one behind a typed method (see Pitfall 1) |

**Installation:** none. No new runtime or dev dependency (PROJECT.md constraint; SBOM unchanged).

**Version verification:** not applicable, no packages. Node on this host is `v24.22.2` and `git version 2.53.0`; `@types/node` is `^22.10.0` in `package.json`, so only Node 22-compatible APIs may be used (`hkdfSync`, `createPrivateKey` DER, `generateKeyPairSync` are all available in 22).

## Package Legitimacy Audit

No external package is installed or recommended by this phase. Step 1 to 3 of the legitimacy gate are not applicable.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none) | n/a | n/a | n/a | n/a | n/a | n/a |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## NEAR AI Cloud contract (research flags 1 and 2)

**Sources.** `[VERIFIED: https://cloud-api.near.ai/api-docs/openapi.json, fetched and parsed this session]` is the provider's own served OpenAPI document, the machine-readable form of the pages linked from `https://docs.near.ai/llms.txt`. `[CITED: github.com/nearai/cloud-api @ 72d98902a0e7a471eaceeed6cc7b5ba29d0eebff]` is the provider's open-source server, read where the docs are silent. Base URL is `https://cloud-api.near.ai/v1` (`DEFAULT_BASE_URL`, `src/domain/config.ts:17`), so the paths below are written relative to `/v1`.

All calls below use `Authorization: Bearer <access token JWT>` ("session_token") unless marked otherwise. Errors are `{"error":{"message":string,"type":string,"code"?:string|null,"param"?:string|null}}`; the OAuth-side routes (`/auth/*`) answer `{"error":string,"error_description":string}`. The existing `errorText()` in `reportingSignIn.ts` already handles both shapes.

| Purpose | Method and path | Request (exact casing) | Response (exact casing) | Who may call |
|---------|-----------------|------------------------|-------------------------|--------------|
| List my organizations | `GET /organizations?limit&offset` | none | `{organizations:[{id,name,description?,is_active,owner_id,role:'owner'\|'admin'\|'member',created_at,updated_at,settings}],total,limit,offset}` | any user |
| List workspaces | `GET /organizations/{org_id}/workspaces?limit&offset` | none | `{workspaces:[{id,name,description?,organization_id,is_active,created_by_user_id,...}],total,limit,offset}` | any org member |
| Invite by email | `POST /organizations/{org_id}/members/invite-by-email` | `{"invitations":[{"email":string,"role":"owner"\|"admin"\|"member"}]}` | HTTP 200 even on partial failure: `{results:[{email,success,email_sent,error?,email_error?,member:null}],total,successful,failed}` | org `owner`/`admin` only; `admin` may invite `admin`/`member`; inviting `owner` is always refused (`OWNER_INVITATION_DISABLED`) |
| List invitations | `GET /organizations/{org_id}/members/invitations?status=pending\|accepted\|declined\|expired` | none | array of `{id,organization_id,email,role,status,invited_by_user_id,created_at,expires_at,responded_at?,email_status,...}` | `owner`/`admin` |
| Cancel invitation | `DELETE /organizations/{org_id}/members/invitations/{invitation_id}` (alias `DELETE /organizations/{org_id}/invitations/{invitation_id}`) | none | `204`; `400` if not pending | `owner`/`admin` |
| My pending invitations (invitee) | `GET /users/me/invitations` | none | array of invitation plus `organization_name`, `invited_by_display_name?` | the invited user (matched by login email) |
| Accept invitation (invitee) | `POST /users/me/invitations/{invitation_id}/accept` | none | `{message, organization_member:{id,organization_id,user_id,role,joined_at,invited_by?}}`; `409` already a member | the invited user |
| Accept by emailed token | `POST /invitations/{token}/accept` | none | same | the invited user; needs the token from the email link (fallback only) |
| Remove org member | `DELETE /organizations/{org_id}/members/{user_id}` | none | `204`; last owner cannot be removed | `owner`/`admin` (or the member themself) |
| Create workspace key | `POST /workspaces/{workspace_id}/api-keys` | `{"name":string,"expires_at"?:iso\|null,"spendLimit"?:{"amount":int64 nano-USD,"currency":"USD"}\|null}` | `201` `{id,key,key_prefix,name,workspace_id,created_by_user_id,created_at,expires_at,is_active,last_used_at,deleted_at,spend_limit:{amount,scale:9,currency}\|null,usage:{...}\|null}`; **`key` (the `sk-` secret) is returned here** | any org member |
| List workspace keys | `GET /workspaces/{workspace_id}/api-keys?limit&offset&order_by=created_at\|usage&order_direction` (default limit 20) | none | `{api_keys:[ApiKeyResponse],total,limit,offset}` with `usage` (lifetime) filled | any org member |
| Set spend limit | `PATCH /workspaces/{workspace_id}/api-keys/{key_id}/spend-limit` | `{"spendLimit":{"amount":int64>=0,"currency":"USD"}}` or `{"spendLimit":null}` to remove | `200` `ApiKeyResponse` | any org member |
| General key update | `PATCH /workspaces/{workspace_id}/api-keys/{key_id}` | `{name?,expires_at?,is_active?,spendLimit?}` (all optional; absent = unchanged) | `200` `ApiKeyResponse` | any org member |
| Revoke key | `DELETE /workspaces/{workspace_id}/api-keys/{key_id}` | none | `204` | any org member |
| Per-key usage history | `GET /workspaces/{workspace_id}/api-keys/{api_key_id}/usage/history?limit&offset&credit_type` | none | `{data:[{id,api_key_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_cost:int64,total_cost_display,created_at,...}],total,limit,offset}` | any org member |
| Current user | `GET /users/me` | none | `{id,username,display_name?,email,contact_email?,auth_provider,organizations:[{id,name,role,...}],workspaces:[...],...}` | the user |
| **Refresh** | `POST /users/me/access-tokens` with `Authorization: Bearer rt_...` (note the hyphen; the prose in the spec says `access_tokens`) | none | `{access_token,refresh_token,refresh_token_expiration}` | refresh token |
| **Logout** | `POST /auth/logout` with `Authorization: Bearer rt_...` | none | `200 {"message":"Logged out successfully"}` | refresh token |
| Validate pasted key | `POST /check_api_key` with `Bearer sk-...` | none | `200 {api_key_id,organization_id,workspace_id,valid}`; `402` when credits or the key's limit are exhausted | the key |

**Findings with evidence**

1. **Casing (flag 1).** Requests use camel case `spendLimit` on create, general update and the dedicated endpoint; responses use snake case `spend_limit` and `usage` with `{amount,currency,scale}`. The docs prose says `spend_limit`; the OpenAPI request schemas and the server structs both say `spendLimit` (`#[serde(rename = "spendLimit")]` on `CreateApiKeyRequest`, `UpdateApiKeyRequest`, `UpdateApiKeySpendLimitRequest`). `[VERIFIED: openapi.json components.schemas.UpdateApiKeySpendLimitRequest.properties.spendLimit]` `[CITED: cloud-api crates/api/src/models.rs]`. There is no `alias`, so `spend_limit` in a request is an unknown, ignored field. On the dedicated endpoint the field then deserialises as `None`, which the handler treats as "remove the limit" (`request.spend_limit.map(|limit| limit.amount)` into `update_spend_limit(.., None)`), so **a mis-cased body removes the cap and returns 200**. Amount validation is `amount < 0` is refused, so `0` is accepted `[CITED: models.rs DecimalPriceRequest::validate]`.
2. **Lifetime, not per period (owner decision 1).** `list_workspace_api_keys` computes `usage` with `with_usage_rows('-infinity','infinity')` summed per key, and the request gate is `if api_key_spend >= api_key_limit { 402 'API key spend limit exceeded', type 'api_key_limit_exceeded' }` `[CITED: cloud-api crates/database/src/repositories/api_key.rs; crates/api/src/middleware/usage.rs]`. So the cap is the cumulative lifetime spend of the key, which matches the addendum's "cumulative grants" design and means **Phase 66 does not need to map `budgetPeriod` to the provider**; it raises the limit by each grant. A limit of `0` means `0 >= 0`, so the key is blocked on its first request; it does not mean unlimited.
3. **Who may do what (owner decision 1).** Inviting, listing and cancelling invitations, and removing org members need org `owner` or `admin` (`invite_members`: "Only owners and admins can invite members"; `can_invite_as`: `Admin` may invite `Admin` or `Member`; `Owner` invitations are disabled) `[CITED: crates/services/src/organization/mod.rs, ports.rs]`. Creating keys, listing keys, setting a limit, revoking and reading usage need only **org membership of any role**: `check_workspace_permission` returns `Unauthorized` only when `get_user_role` is `None`, and `update_api_key_spend_limit` never checks that the caller created the key `[CITED: crates/services/src/workspace/mod.rs]`. Therefore: (a) the invitee, as org role `member`, **can** create their own key and **can** create it with `spendLimit: {amount:0}` in the same call; (b) the lead (owner/admin) can set and raise limits on anyone's key; (c) **the invitee can also raise or remove their own limit**.
4. **Operational limits.** A new key "may take up to 10 seconds to become active" (create-key docs `[VERIFIED: openapi.json create_workspace_api_key.description]`). A `check_api_key` verdict is cached up to `CP_CHECK_API_KEY_TTL_SECS` (default 60) with only a 401 uncached `[CITED: crates/database/src/cp_client/check_api_key.rs, config.rs]`; the real limit gate reads spend that is "recorded" asynchronously (the provider's own test sleeps 500 ms, and notes the first request after setting a tiny limit "might succeed"). `[ASSUMED]` propagation of a limit change to a running key is seconds, not instant: expect overshoot by in-flight requests; the zero-first removal order (D-17) is correct for that reason.
5. **Invitations have no id in the invite response.** `invite-by-email` returns `member: null` for new invitees and no invitation id, so the client must `GET .../members/invitations?status=pending` and match by case-insensitive email to find the id for cancel. A pending invitation is matched to the invitee by **login email**; a wallet user's login email is a placeholder `{account_id}@near` with a separate `contact_email` (`GET /users/me` schema description), so a wallet-only invitee will see no invitation `[ASSUMED: matching uses the login email]`.
6. **Refresh rotates.** The handler logs "Creating access token & rotating refresh token", calls `rotate_session`, and a rotated-away token answers 401 "Invalid or expired refresh token"; access tokens live 1 hour and refresh tokens 7 days from the last rotation `[CITED: crates/api/src/routes/users.rs create_access_token]`. Logout (`POST /auth/logout`, refresh-token auth) revokes **only the current session** and is idempotent; the documented-but-heavier alternative `DELETE /users/me/tokens` revokes every session the user has (including the web console) and must not be used `[CITED: crates/api/src/lib.rs, routes/auth.rs]`. `/auth/logout` is not in the OpenAPI document but is what 0.4.8 already ships (`signOut()`), so D-01's `POST /v1/auth/logout` is confirmed.
7. **No single-key GET.** To read one key (its `created_by_user_id`, `spend_limit`, `usage`) page through `GET .../api-keys` and match `id`. The list returns `key: null` for existing keys in practice; the secret is available only from the create response `[ASSUMED]` (not stated in the schema, which marks `key` nullable); never rely on it.

## Invite and join protocol (research flag 3)

### Code, derived key and bundle

- **Code.** 20 bytes from `crypto.randomBytes` (160 bits, comfortably over D-09's 128), rendered as 32 Crockford base32 characters (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, the alphabet `identity.ts` already uses for ULIDs), shown grouped `XXXX-XXXX-...` and normalised on parse (strip `-` and spaces, uppercase, map `I`/`L` to `1`, `O` to `0`). Because the code is uniformly random and long, the derived public key is not brute-forceable and no key stretching is needed.
- **Key derivation (verified).** `seed = hkdfSync('sha256', codeBytes, Buffer.from(teamId), Buffer.from('near-ai/team-invite/v1|' + memberId), 32)`; the private key is `createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'), seed]), format:'der', type:'pkcs8' })`; the public key is `createPublicKey(priv).export({format:'jwk'}).x` (43 base64url chars). Run this session on Node 24.22.2: same inputs give the same public key, a different `memberId` gives a different one, `sign(null, msg, priv)` is deterministic (64 bytes) and verifies against `SPKI prefix 302a300506032b6570032100 + pub` exactly the way `canonical.ts verifySignature` does. `[VERIFIED: node run in scratchpad this session]` The 12-byte SPKI prefix is the same constant already in `canonical.ts:12` `[VERIFIED: src/domain/team/canonical.ts:12]`. Salt = `teamId` and info = `memberId` keep one code from ever deriving the same key in two teams or for two invitations.
- **Bundle (D-05).** `near-ai-invite-v1.` + base64url (no padding) of `canonicalize({ v:1, repo, team, ref, member, code })`, optionally with `near:{organizationId,workspaceId}` (non-secret redundancy, see Pitfall 11). The parser: exact prefix, strict base64url, size cap 4 KB, `JSON.parse`, then field checks with the existing patterns (`team` against `TEAM_ID_PATTERN`, `member` against `MEMBER_ID_PATTERN`, `ref` against `COORDINATION_REF_PATTERN` plus `isGitRefName`), required known keys, **unknown keys ignored** (so a v1 reader accepts a later v1.x and a v2 writer can keep a v1 shape). `repo` is re-checked at parse time and any userinfo is refused. Add a frozen test vector for the bundle string (the format is "costly" to change).
- **Repo URL cleaning (D-06).** Read with `git remote get-url <remote>` at invite time (never stored or logged). `http(s)://`: drop all userinfo, refuse if a query string or fragment is present. `ssh://`: drop any password, keep a plain user name only if it matches `^[a-z_][a-z0-9_-]{0,31}$` (for example `git`). scp-style `user@host:path`: keep a plain user, refuse anything with `:` in the user part. `file://` and bare paths: refuse ("a local path cannot be shared"). After cleaning, run `findSecrets` on the result and refuse on a match; return a reason string, never the URL. The Phase 60 canary URL `https://canaryuser:<pw>@example.invalid/team.git` must come out as `https://example.invalid/team.git`.

### `member.invited` (new, signed permanently)

Exact-key body (the same `checkKeys` discipline as the other bodies):

```text
member.invited body = {
  memberId: mbr-<hex16>,          // fresh; this is also the invitation id
  name: string (1..80),           // validateName; the lead's label for the person
  emailHashes: [sha256 hex] (exactly 1),   // emailHash(teamId, email)
  role: Role  (not 'owner'),
  allocationNanoUsd: safe integer >= 0,    // intent only; no Allocation is created (that is Phase 66)
  ttlSeconds: safe integer 3600..2592000,  // UI offers 86400, 259200, 604800 (default), 1209600
  invite: { publicKey: base64url(32) }     // derived key; key name 'publicKey' is exempt from the token detectors
}
```

Rules in the materializer (reference and permission steps): author must pass `decideTeamAction(state, author, {kind:'member.invite'})` (matrix row `MANAGERS` already exists, `permissions.ts`), `role !== 'owner'` (checked in the materializer body logic so `TeamAction` and its Phase 60 tests stay unchanged), `memberId` must not exist, and no non-removed member (active or invited) may already carry the same email hash (reason: already a member or already invited). Add `'member.invited'` to `IMPLEMENTED_EVENT_TYPES`, `ImplementedEventBodies`, `BODY_VALIDATORS`, `actionForEvent` (`{kind:'member.invite'}`), `ROSTER_AUDIT_TYPES`.

### `member.joined` for a joiner (non-genesis, invite-gated)

Extend the existing body with two **optional** keys (genesis owner joins keep their exact current shape):

```text
member.joined body = {
  memberId, name, emailHashes, role, device: {fingerprint, publicKey},   // unchanged
  invite?: { sig: base64url(64) },       // required for a non-genesis join; key name 'sig' is exempt from the token detectors
  nearApiKeyId?: string                  // /^[A-Za-z0-9._:-]{1,128}$/ (existing NEAR_ID_PATTERN); the key ID, never the key
}
```

**Countersignature.** The invite-derived private key signs `canonicalBytes({ v:1, purpose:'near-ai.team.invite-join', teamId, memberId, inviteEvent: <id of the member.invited event>, device:{fingerprint,publicKey} })`. The envelope is signed by the joiner's new device key as usual. Binding to `teamId`, `memberId`, the invite event id and the device means the countersignature cannot be reused for another device, another invitation (a re-issue gets a new member id and key), or another team; a log reader who sees the public key and the countersignature cannot mint a new one. Single use is structural: the join flips the member out of `invited`, so a second join for that member id is refused (`notInvited`).

**Pipeline change (research flag 4).** In `applyEntry`, before step 3 (`boundKey`), branch when `event.type === 'member.joined' && state.accepted > 1 && author is a member with status 'invited'`. For that branch only:
1. Envelope checks as normal (teamId, duplicate id), then **self-binding**: `event.device === body.device.fingerprint`, `body.device` passes `validateDeviceRef` (fingerprint is the hash of the key), the fingerprint is not in `deviceIndex`, and the envelope signature verifies against **`body.device.publicKey`** (not against the roster, because nothing is bound yet).
2. Chain checks as normal: `prev === head`, Lamport rule.
3. Invitation checks: member not removed; `invite.sig` verifies against `member.invite.publicKey`; `body.emailHashes` equals the invited hashes (a joiner cannot claim another person's address); `body.role` equals the expected role (below); expiry (below).
4. Any `member.joined` that is not a valid owner genesis join and not this branch keeps today's rejection `notPermitted: only the owner joins at genesis in this version` (so `teamMaterialize.test.ts` lines 117 and 124 and `teamLog.test.ts` line 167 keep passing unchanged). New fixed reasons to add to `TEAM_REJECTION_REASONS`: `notInvited`, `inviteProof`, `inviteExpired`, `inviteRole`, `inviteEmail`, `alreadyInvited`.

**Expected role (D-15).** `expected = (pendingRole === 'observer' || !policy.requireLeadConfirmation) ? pendingRole : 'observer'`, evaluated against the policy at that log position. The member keeps `pendingRole` until a `member.role-changed` to exactly that role clears it. `pendingRole` doubles as the "waiting for confirmation" flag for D-16.

**Expiry without wall-clock ordering (D-08).** `CommittedEvent.commitTime` is the commit's `%ct` in seconds, parsed by `parseLog` in `gitTransport.ts` and identical on every client for the same commit `[VERIFIED: src/team/gitTransport.ts:154,165]`. When `member.invited` is applied, store `invite.commitTime = entry.commitTime` in the member record. Accept the join iff `entry.commitTime <= invite.commitTime + ttlSeconds + 300` (300 s skew allowance, `[ASSUMED]` value for the owner to confirm). This is deterministic across clients and never reads `Date.now()` on the read path. Two caveats the plan must state plainly: it is **hygiene against stale bundles, not authentication** (a joiner who holds the code also controls their commit date; the real controls are code secrecy, cancel and single use), and `checkCandidate` currently builds candidate entries with `commitTime: 0` (`materialize.ts:563`). Make `Materializer.check` accept an optional commit time and have `GitTransport` pass `Math.floor(now/1000)` (inject the clock for tests) at its two `check` calls (`gitTransport.ts:669,736`); treat `commitTime === 0` on either side as "unknown, skip the expiry check" so Phase 60 fixtures stay valid. The Manage Members list computes pending, expired and used for display from the local clock and the stored `commitTime`; that display is not part of validation.

### Member record additions (state, snapshot, hash)

All optional on `Member` (`types.ts:47`), omitted when absent:

```text
status?: 'invited'                       // absent = active; present only before the join
invite?: { publicKey, ttlSeconds, eventId, commitTime }   // present only while invited
pendingRole?: Role                       // the invited role, until confirmed
allocationNanoUsd?: number               // the invitation's intent, kept for the confirm step
```

Invited records have `role: 'observer'`, `devices: []`, `availability: 'offline'`, and `joinedAt/joinedEvent` set from the invited event (those two strings are required today). Because `toPlain` drops `undefined`, a team with no invitations serialises **exactly as before**, so `STATE_HASH_VERSION` stays 1 and Phase 60 snapshots still verify. Required follow-ups in `materialize.ts`: `parseMember` (`:260-270`) must allow the four new optional keys and allow `devices.length === 0` **only** when `status === 'invited'`; `checkAnchorBinding` and `checkIndex` need no change. Add a test that a Phase 60 snapshot fixture still loads with an unchanged `stateHash`, and one that a state with an invited member round-trips through `serialiseState`/`deserialiseState`. Reference rules: `member.role-changed`, `device.*`, `member.skills` must refuse an `invited` member (new reason "member has not joined yet"); `member.removed` accepts it (that is cancel).

### Re-issue

Cancel plus new invite in one batch append: `member.removed {memberId: old}` then `member.invited {memberId: new, ...}`. The old member id stays a removed record and cannot be reused (existing `lookupMember` rule), so a re-issue always mints a new `mbr-` id and a new code. The email-hash uniqueness rule above ignores removed members, so this succeeds. Re-joining after removal is deferred, but a fresh invite with a new member id already works under these rules.

## Materializer changes for removal (research flag 4, D-19, TEAM-03)

- **Positional rejection already works.** `boundKey` rejects any event whose author is removed (`R.removedAuthor`) and `member.removed` already sets `removedEvent` `[VERIFIED: src/domain/team/materialize.ts boundKey and applyTransition member.removed]`. Do **not** also mark the member's devices revoked in the transition: `boundKey` checks `revokedEvent` first, so existing tests that expect `author was removed before this event` would change, and a `device.revoked` event cannot revoke a member's last device anyway (`R.lastDevice`). Removal implies revocation; show it that way in Verify Team Log (`removed: true` already prints).
- **Release on removal, in `applyTransition` for `member.removed`, for an active member only.** Iterate `state.claims` in map order: every claim with `memberId === removed` and `status` in `active | in-review | integrating` becomes `released`; its item (if present) gets `state: 'ready'` and `claimId` cleared (branch name stays on the claim record, "branches preserved"); leases whose `holder` is the member or whose `claimId` is a released claim are deleted from `state.leases`; allocations with `memberId` are removed from `state.allocations` (the unspent amount is implicitly back in the pool because the pool is derived); released claim ids are filtered out of `state.integrationQueue`. Claims already `merged`, `handed-off`, `expired` or `released` and items `done` or `cancelled` are untouched. Deterministic because Map iteration is insertion order and events apply in commit order. `[ASSUMED]` that deleting leases and allocations (rather than marking them) is acceptable now; Phase 66 may refine allocation history.
- **Invited member removal = cancel.** Sets `removedEvent` and does nothing else; the invite key can no longer produce a valid join because the member is removed.
- **Fixture-only proof.** `emptyList` in `deserialiseState` means real Phase 61 snapshots always carry empty `items/claims/leases/allocations`, so tests build state by calling `addFixtureMember` (existing helper) and inserting claims/leases/allocations into the `TeamState` maps directly, then applying a signed `member.removed` entry. Add a determinism property test (seeded `mulberry32`, existing) that replays the same log twice and with an incremental versus full reduce and compares `serialiseState`.

## Lead session, refresh and the two `main` commits (research flag 5)

**Stored value.** SecretStorage key `nearAi.team.nearSession.<teamId>` holds JSON `{ v:1, refreshToken, label }` where `label` is the account's `username` for the "signed in as" status. The access token (1 hour) is held only in memory. The refresh token matches the `rt_` detector, so the storage helper must never pass it through `assertNoSecrets`-guarded write paths or into an output channel; it is only ever passed to SecretStorage and as a Bearer header.

**`src/team/nearSession.ts` (vscode-free, over `SecretStorageLike` and the injected `fetch`).**
- `accessToken()`: return the cached token if younger than 50 minutes; otherwise single-flight refresh: re-read the stored refresh token, `POST /users/me/access-tokens`, **persist the returned `refresh_token` before using the access token**, cache the access token. On a 401 from refresh, re-read the stored value; if it differs (another window rotated it first) retry once with the new value; otherwise report "signed out" (code `expired`) and ask the user to sign in again.
- A 401 from any API call with a fresh access token triggers one refresh and one retry; a second 401 surfaces.
- `signOut()`: `POST /auth/logout` with the stored refresh token (reuse `signOut()`), delete the secret regardless of the HTTP result, report whether the server confirmed.
- A refresh token unused for 7 days dies; the UI message for `expired` is "Your NEAR sign-in for <team> expired. Sign in again."

**The two `main` commits.** `d637578` adds `firstSession()` to `reportingSignIn.ts` and makes `browserSignIn` (a private function in `spendTracking.ts`) race the loopback listener against a paste box in a browser-based VS Code. `403c06e` changes only the reporting-token/usage-summary path (404 means "not offered yet") in `reportingToken.ts`, `spendAccount.ts`, `spendInsight.ts`, `spendReconciler.ts`, `spendTracking.ts` `[VERIFIED: git show --stat d637578 / 403c06e this session]`. Phase 61 does not call `/usage/summary` (that route needs a reporting token); per-key usage comes from the session-token key list and `usage/history`, so `403c06e` needs no code reuse beyond treating a 404 on any usage-style route as "not offered" in `nearOrg.ts`.
- **Recommendation: merge `main` into this branch as the first task** (not rebase, not cherry-pick). A dry run `git merge-tree --write-tree HEAD main` this session conflicts only in `.planning/REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` and `state.json`; `package.json` auto-merges and no `src/` file conflicts. Resolve the planning files by keeping both sides' entries (main's Phase 25 lines and the team branch's Phases 60 to 67). Cherry-picking would drag in version bumps and CHANGELOG hunks.
- **Then extract, do not duplicate.** Move `browserSignIn`, `pasteSignInAddress` and `checkPasted` from `spendTracking.ts` into a new `src/services/nearSignIn.ts` (vscode) and add a parameter for the paste-box prompt. The current prompt text says "It holds a one-time sign-in that is signed out as soon as the token is made", which is wrong for the kept team session; the team variant must say the session is kept for team invitations until the user runs `NEAR AI: Sign Out of NEAR (Team)`. `spendTracking.ts` imports the extracted function with its original wording so 0.4.x behaviour and `reportingTokenEntry.test.ts` expectations do not change.

## Project-scoped key storage (research flag 6, D-12, D-14, D-20)

`[VERIFIED: src/domain/auth.ts, src/services/auth.ts, src/services/profileStore.ts read this session]`
- Scope: `createProjectCredentialScope(projectIdentity, profileId)` hashes the workspace identity into `project-<32 hex>`; secrets are stored under `nearAi.v2.<projectId>.<profileId>.api-key` and `.api-key-endpoint` by `AuthService.saveScopedApiKey(scope, key, endpoint)`. `PROFILE_ID_PATTERN` is `/^profile-[a-z0-9][a-z0-9-]{1,63}$/`.
- Team profile id: `profile-team-<first 10 hex of sha256(teamId)>` (stable, derived, no team name). `displayName` `"<team name> (team key)"`, `organization` the team name; `safeLabel` rejects labels containing `api key`, `token`, `bearer`, `command:` and similar, so sanitise the team name before use and fall back to `Team`.
- Create and activate: `new ProfileStore(projectRoot, new AuthService(secrets))`, then `configure({profileId, displayName, organization, baseUrl, authMode:'apiKey'}, apiKey)`. `configure` creates the profile, stores the key bound to its endpoint, validates by listing models (`validateNearAiProvider`), and **selects only if validation passes**; `select()` throws on a non-valid profile. The previous active profile is read first with `getActiveSelection()` and remembered in a small non-secret per-team file (`<globalStorage>/team/<teamId>/join.json`, `{previousProfileId}`), not in the profile ledger.
- **Propagation delay.** Because a new key may take up to 10 seconds to authenticate, the first `validate` can fail. Wrap `validate` then `select` in a bounded retry (for example 6 tries, 2 s apart, longer for tests via an injectable `sleep`). Do not treat the first 401 as a bad key. A key with limit `0` still lists models because the usage gate sits on the completion routes (`build_completion_routes` "with auth and usage tracking" in `lib.rs`) `[CITED]`; `[ASSUMED]` that `/models` is not gated, confirmed by the live test.
- Profile metadata lives in `.planning/.near-ai/auth-profiles.json` (non-secret labels, local). `ProfileStore.remove(profileId)` deletes the ledger entry and both scoped secrets, so D-20 is: `select(previousProfileId)` if it still exists and is valid, `remove(teamProfileId)`, `forgetDeviceIdentity`, delete `nearAi.team.nearSession.<teamId>`, write a local "removed" marker (`<globalStorage>/team/<teamId>/removed.json`, `{memberId, removedEvent}`; no secret) so a restart shows the removed state instead of "no device key".
- Paste path (no linked org, or the user prefers their own key): `NearAiClient.checkApiKey()` returns `{organizationId, apiKeyId}`; with a linked org require `organizationId` to equal `team.near.organizationId` and fetch `workspace_id` from the raw `/check_api_key` body to compare with `workspaceId` (the existing method does not return it, so extend it or call it directly). Record `apiKeyId` as `nearApiKeyId` (a pasted key's id is knowable, so removal can still zero and revoke it). A `402` here means the key is at its limit or the org is out of credits: show that reason, do not call it invalid.

## Removal flow and cleanup checklist (D-17, D-18, TEAM-03)

1. **Target safety check before any NEAR write.** The log's `nearApiKeyId` is attacker-influenced (a joiner chooses it). Before zeroing or revoking, page the workspace key list, find the key by id and refuse to act if it is missing, or if its `created_by_user_id` is the lead's own user id or belongs to an org `owner`/`admin` (`GET /organizations/{org}/members` gives `user.id` and `role`). Refused steps go to the checklist as "needs manual review". This also yields the NEAR `user_id` for step 4 without trusting a user id from the log (so `member.joined` carries no `nearUserId`).
2. Step 1: `setSpendLimit(workspaceId, keyId, 0)`. 404 means the key is already gone: mark steps 1 and 3 done. Any other failure: show a prominent warning that the key can still spend, queue steps 1, 3, 4.
3. Step 2: append `member.removed`. This happens even if step 1 failed (D-18). Use the `TeamLog.append` conflict path: if the lead was removed or demoted meanwhile, report the reason.
4. Step 3: revoke the key only if step 1 succeeded or returned 404. Step 4: `DELETE /organizations/{org}/members/{user_id}`; "last owner" and 403 become checklist items.
5. For an `invited` target: append `member.removed`, then cancel the NEAR invitation (find it by the locally cached email via `listInvitations('pending')`; if the cache is missing, put "cancel the pending invitation in the NEAR console" on the checklist).
6. **Checklist persistence.** `<globalStorage>/team/<teamId>/cleanup.json` written with the existing `writeFileAtomic` under `runSerialised`, items `{id, memberId, step: 'zero-limit'|'revoke-key'|'remove-org-member'|'cancel-invitation'|'repo-access', keyId?, nearUserId?, status:'pending'|'done'|'failed', attempts, lastError}`; `lastError` passes `safeReason` and holds no URL or token. `repo-access` is always the last item and is only ever marked done by the user.
7. Ordering hazard to tell the lead: if repository access is removed before the member's client has synced `member.removed`, their client never sees the removal and keeps its local device key and team key profile (the key is already revoked, so it is worthless; the local data is merely stale). The checklist wording should say "remove repository access last".

## Removed-member client (D-20) and lead notifications (D-16)

- In `TeamSession.syncOnce`, after `log.sync()`, look up the local device in `deviceIndex`; if its member has `removedEvent` and no `removed.json` exists, run the removal handler once: stop the scheduler, show "You were removed from <team>", clean up as in "Project-scoped key storage", write the marker, switch the status bar to a removed state. `adoptSigner` already refuses removed members (`teamSession.ts:adoptSigner`), so no write can happen. On later activations, `removed.json` short-circuits to the read-only removed state with no retries.
- Pending confirmation: count members with `pendingRole !== undefined && status === undefined && removedEvent === undefined`; the status text gains an optional count (`Team: <name> (2 pending)`). Show the "<name> joined <team> and is waiting for confirmation" notification only when the local member is owner or lead, once per join event id, remembered in a small local set so a reload does not repeat it. Treat all names from the log as untrusted display text and pass them through `safeReason`.
- Confirm = `member.role-changed {memberId, role: pendingRole}` then `setSpendLimit(keyId, allocationNanoUsd)`. If the limit call fails the member is confirmed but the key stays at 0 (fails closed); queue "set spend limit" on the checklist.

## Architecture Patterns

### System Architecture Diagram

```text
LEAD WINDOW                                              INVITEE WINDOW (clone of the project repo)
-----------                                              ------------------------------------------
Invite command
  | read repo URL (git remote get-url) -> clean (D-06)
  | new code (160 bit) -> HKDF -> invite pubkey
  | [team.near?] NearSession.accessToken() --refresh--> NEAR /users/me/access-tokens
  |        \-> nearOrg.inviteByEmail(org, email, 'member') ----------> NEAR emails the invitee
  | TeamLog.append: member.invited{pubkey, ttl, role, allocation}
  |        \-> GitTransport CAS push -> remote near-ai/coordination
  | show bundle ONCE (modal + Copy)   -- code never logged/stored -->  pasted by the invitee
                                                           Join Team command: parse bundle, check team.json (else Clone, D-07)
                                                             | sync log; check invited, unexpired, code derives the recorded pubkey
                                                             | create device key (SecretStorage)
                                                             | [team.near?] browser sign-in -> GET /users/me/invitations -> accept
                                                             |             -> POST api-keys {spendLimit:{amount:0}} -> store key (project scope)
                                                             | TeamLog.append member.joined{device, invite.sig, nearApiKeyId}
                                                             |        (self-bound; materializer verifies proof + expiry)
                                                             | activate team profile (retry validate), logout NEAR, start session
sync brings member.joined (pendingRole set)  <---- remote ----+
  | notify "<name> waiting": Confirm / Remove
Confirm: member.role-changed -> nearOrg.setSpendLimit(keyId, allocation)
Remove: verify target -> setSpendLimit 0 -> member.removed -> revoke key -> remove org member -> checklist
                                                           removed client syncs member.removed -> stop, wipe device key,
                                                           team profile, session; reactivate personal profile
```

### Recommended Project Structure

```text
src/domain/team/
  types.ts            + MemberInvitedBody, MemberJoinedBody (optional invite/nearApiKeyId), Member optional fields, new reasons
  validate.ts         + 'member.invited' validator, extended 'member.joined' validator
  materialize.ts      + invite-gated join branch, invited state, release on removal, parseMember relax
  invite.ts           + pure: proof bytes, expected role, expiry rule, display status (pending|expired|used|cancelled)
src/team/
  inviteCode.ts       code generate/format/parse, deriveInviteKey, signJoinProof (node:crypto only)
  inviteBundle.ts     encode/parse bundle, cleanRepoUrl
  nearOrg.ts          typed NEAR client (injected fetch, retry/backoff, redaction)
  nearSession.ts      kept session over SecretStorageLike
  invite.ts join.ts remove.ts nearLink.ts  vscode-free orchestration over real git (like enable.ts)
  cleanupChecklist.ts persisted NEAR cleanup items
src/services/team/
  nearSignIn.ts       extracted browserSignIn + team prompt copy (vscode)
  teamCommands.ts     + invite, join, manageMembers, linkNearOrganization, signOutNear adapters
  teamSession.ts      + append() passthrough, removal detection, pending count
src/test/helpers/fakeNear.ts   fake NEAR server (no .test suffix)
```

### Pattern 1: A typed spend-limit call that cannot drop the field
```typescript
// Source: provider schema UpdateApiKeySpendLimitRequest (openapi.json) and handler behaviour (cloud-api workspaces.rs)
async setSpendLimit(token: string, workspaceId: string, keyId: string, nanoUsd: number): Promise<NearKey> {
  if (!Number.isSafeInteger(nanoUsd) || nanoUsd < 0) throw new RangeError('A spend limit is a whole number of nano-USD, zero or more.');
  const body = { spendLimit: { amount: nanoUsd, currency: 'USD' } };      // camelCase on requests
  return parseKey(await this.send('PATCH', `/workspaces/${enc(workspaceId)}/api-keys/${enc(keyId)}/spend-limit`, token, body));
}
// Removing a cap is a separate, explicitly named method that sends { spendLimit: null }. Nothing else may build this body.
```

### Pattern 2: Self-bound join in the pipeline
```typescript
// Before boundKey() in applyEntry(); only for a non-genesis member.joined whose author is an 'invited' member.
// publicKey for the envelope signature comes from the event's own body, then the invite countersignature is checked.
const device = event.body.device;
if (event.device !== device.fingerprint) return reject(state, event.id, R.unboundDevice);
if (!verifyEventSignature(event, device.publicKey)) return reject(state, event.id, R.badSignature);
if (!verifySignature(joinProofBytes(state.team.id, member.id, member.invite.eventId, device), event.body.invite.sig, member.invite.publicKey)) return reject(state, event.id, R.inviteProof);
```

### Anti-Patterns to Avoid
- **Writing the code anywhere durable:** not in the log, `team.json`, settings, output channel, audit, transcripts, error messages, test snapshots. Only the invite dialog and the clipboard Copy see it.
- **Trusting `nearApiKeyId` or any NEAR id read from the log** for a destructive NEAR call without the target safety check.
- **Blind retry of `POST /api-keys`:** a timeout may have created the key; list by name before retrying, and never log the create response body (it holds the secret).
- **Marking devices revoked in the `member.removed` transition** (changes Phase 60 rejection reasons, conflicts with `lastDevice`).
- **Putting the pasted-bundle code into a retained "pending join" without an explicit decision** (see Open Question 2).
- **Calling `DELETE /users/me/tokens`** for sign-out (kills the user's other sessions).
- **Using `Date.now()` on the read path** for expiry or anything else the materializer decides.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Canonical bytes for the proof and the bundle | A second serializer | `canonicalize`/`canonicalBytes` | Frozen by `teamCanonical.test.ts`; floats and odd values are rejected already |
| Ed25519 from a seed | Any hand-written curve code | `createPrivateKey` DER with the fixed PKCS#8 prefix | Verified working; same primitive the device keys use |
| Key derivation | Hash-then-truncate | `hkdfSync('sha256', ...)` with salt `teamId` and info per member | Standard, domain-separated |
| Strict base64url, key shapes | New regexes | `isStrictBase64url`, `validateDeviceRef`, `PUBLIC_KEY_PATTERN` | Round-trip check already handles non-canonical trailing bits |
| Secret detection before writes | A parallel detector | `assertNoSecrets` and key names `publicKey`/`sig` for the exemptions | A random 43 or 86 character string can match `sk-`, `rt_` by chance; only keys named `publicKey` and `sig` are exempt (`secrets.ts isExemptKeyMaterial`) |
| Atomic JSON files | `fs.writeFile` | `writeFileAtomic` + `runSerialised` (`teamFile.ts`) | Temp-file-then-rename and per-path ordering |
| Browser sign-in, paste fallback, logout | New OAuth plumbing | `startLoopbackSignIn`, `firstSession`, `parseCallback`, `signOut` | Includes the code-server paste fix on `main` |
| Team commit of `team.json` | A second git sequence | Extract the `add -f` / `commit --only` block from `enable.ts` | Avoids committing the user's staged work |
| Profile creation and secret deletion | Direct SecretStorage key names | `ProfileStore`/`AuthService` | Keeps the endpoint binding and scope hashing |
| HTTP retry/backoff | Ad hoc loops per call | One `send()` in `nearOrg.ts` | Retry only idempotent methods; honour `Retry-After`; redact |

**Key insight:** every new byte that is signed, hashed or parsed from a remote must reuse the Phase 60 primitives; the only new cryptographic code is two `node:crypto` calls (HKDF, PKCS#8 wrap).

## Runtime State Inventory

Not a rename or migration phase. Omitted per the template, with one explicit note: Phase 61 **adds** local runtime state that Phase 62+ and removal must account for, all non-secret unless marked.

| Category | Items | Action |
|----------|-------|--------|
| Stored data | `<globalStorage>/team/<teamId>/{cleanup.json, join.json, removed.json, invites.json (lead's local email/name display cache, no code)}` | Create atomically; delete `join.json` after join |
| Live service config | NEAR org invitation, org membership, workspace key per member | Cancel/remove/revoke through `nearOrg.ts`; checklist if it fails |
| OS-registered state | none | none |
| Secrets/env vars | SecretStorage: `nearAi.team.nearSession.<teamId>` (refresh token), `nearAi.v2.<project>.<profile>.api-key` (team key), existing `nearAi.team.deviceKey.<teamId>` | Delete the first three on removal (D-20) and on sign-out |
| Build artifacts | none | none |

## Common Pitfalls

### Pitfall 1: A mis-cased spend limit silently removes the cap
**What goes wrong:** `{"spend_limit":{...}}` (the docs prose casing) returns 200 and the server stores `NULL`.
**Why:** `spendLimit` is the only accepted name; the unknown field is ignored; absence means "remove" on the dedicated route `[CITED: workspaces.rs, models.rs]`.
**How to avoid:** the typed method in Pattern 1; the fake server must reproduce this exact behaviour (store `null` when `spendLimit` is absent) so a wrong body fails a test; assert the response `spend_limit.amount` equals what was sent after every call.
**Warning signs:** `spend_limit: null` in a response after a "set".

### Pitfall 2: Refresh-token rotation burns the session
**What goes wrong:** two windows (or two calls) refresh with the same token; the second gets 401 and the stored token is stale or lost.
**How to avoid:** single-flight per team, persist the new refresh token before anything else, re-read and retry once on 401, treat "no stored token" as signed out. Test with the fake server's rotation (old token reuse returns 401) and a concurrent-refresh test.

### Pitfall 3: Provider cap is not tamper-proof against the key's owner
**What goes wrong:** an org `member` can PATCH their own key's limit to a larger value or `null`.
**Why:** any org member may set any key's limit (`check_workspace_permission` is membership only).
**How to avoid:** document it to the owner (Open Question 1); have Phase 66 treat `GET api-keys` `spend_limit` as drift-detectable state and reassert it on every poll; do not describe the provider layer as a security boundary against the member in UI copy.

### Pitfall 4: Key activation delay makes a good key look bad
**How to avoid:** bounded retry on `validate` and on first use; never delete the just-created key on the first 401; the fake server can answer 401 for a configurable first few hundred ms to test it.

### Pitfall 5: `invite-by-email` is HTTP 200 with per-email failure
**How to avoid:** inspect `results[0].success`/`error`; map "User is already a member" to "already in the organization, continue"; `Insufficient permissions` to "your NEAR role cannot invite"; then list pending invitations to learn the id.

### Pitfall 6: The invitee cannot see the invitation
**Why:** matched by login email; wallet users have placeholder emails; an invitee may sign in with a different account.
**How to avoid:** if `GET /users/me/invitations` has none for the team's organization, check `GET /users/me` `organizations` for membership (already a member: skip accept); otherwise say plainly "Sign in with the email the lead invited, or ask the lead to invite the address on your NEAR account", and offer the emailed-link token path (`POST /invitations/{token}/accept`) as the fallback.

### Pitfall 7: Orphan NEAR resources when the log write fails after the key exists
**How to avoid:** order is NEAR steps (key at limit 0) then log append; on a definitive append failure (cancelled invite, lost race for the single use, expired) revoke the new key with the invitee's still-open session, forget the device key and delete the profile. A crash between the two leaves a zero-limit key the lead can see in the console; document it.

### Pitfall 8: Candidate checks run with `commitTime` 0
**How to avoid:** extend `Materializer.check`/`checkCandidate` with an optional commit time; skip expiry when either time is 0; test an expired join is refused both on write (conflict) and on read (rejection) with the same reason.

### Pitfall 9: Snapshot compatibility
**How to avoid:** optional-only `Member` fields; relax `devices.length > 0` only for `status === 'invited'`; keep `STATE_HASH_VERSION` at 1; add the Phase 60 snapshot regression test. Mixed-version teams (a Phase 60 build reading `member.invited`) will reject it as unsupported and diverge from snapshots; acceptable pre-release, mention in the changelog.

### Pitfall 10: Detector false positives on random key material
**How to avoid:** only the keys named `publicKey` and `sig` are exempt, so name the invite fields `invite.publicKey` and `invite.sig` exactly; run `assertNoSecrets` on every new body in tests with 1000 random keys.

### Pitfall 11: `team.json` `near` not pushed when the invitee clones
**Why:** D-03 commits `near` on the lead's current branch and never pushes. An invitee who clones sees no `near` and joins in degraded mode without knowing why.
**How to avoid:** after Link, offer Push (reuse `pushCodeBranch`); at invite time warn when the local branch has an unpushed `team.json` change; optionally include `near` in the bundle and have Join prefer `team.json`, use the bundle value only when `team.json` has none, and stop with an explanation if both exist and differ.

### Pitfall 12: The clone-then-resume flow wants the code to survive a window reload
**Why:** D-07 says resume after Clone; D-05 says never stored in clear text.
**How to avoid:** see Open Question 2; the safe default is to ask the user to paste the bundle again in the cloned window.

### Pitfall 13: Hostile text from NEAR or the log reaching the UI
**How to avoid:** org, workspace and key names and member names pass through `safeReason`-style flattening before QuickPick, status bar or notifications; status bar text must escape `$(`.

## Code Examples

### Deriving the invite key (verified this session on Node 24.22.2)
```typescript
// Source: node:crypto docs; run and verified in the research scratchpad
import { createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function deriveInviteKey(codeBytes: Buffer, teamId: string, memberId: string): { privateKey: KeyObject; publicKey: string } {
  const seed = Buffer.from(hkdfSync('sha256', codeBytes, Buffer.from(teamId, 'utf8'), Buffer.from(`near-ai/team-invite/v1|${memberId}`, 'utf8'), 32));
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('The invite key has no public half.');
  return { privateKey, publicKey: jwk.x };   // 43 base64url chars
}
```

### Refresh with rotation (shape from the provider's route)
```typescript
// POST {base}/users/me/access-tokens   Authorization: Bearer rt_...   -> { access_token, refresh_token, refresh_token_expiration }
// The old refresh token is dead after this call: write the new one to SecretStorage first.
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Spec assumed `spendLimit` lifetime semantic | Confirmed lifetime by server source | this session | Cumulative grants in Phase 66 are right; no period mapping |
| Spec said logout "if configured" | `POST /v1/auth/logout` confirmed (undocumented in OpenAPI, implemented) | this session | Keep using `signOut()` |
| Reporting sign-in signs out at once | Team session kept, refresh rotated | D-01 | New `nearSession.ts` and a changed paste prompt |

**Deprecated/outdated:** the addendum's `POST /users/me/access_tokens` spelling (underscore); the path is `access-tokens`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A limit change reaches a running key within seconds, and in-flight requests can overshoot | NEAR contract finding 4 | Removal "fast cut-off" is slower than promised; only live testing measures it |
| A2 | The invitation is matched to the invitee by login email; wallet users cannot see theirs | finding 5, Pitfall 6 | Join stalls for some accounts; fallback token path covers it |
| A3 | `GET .../api-keys` returns `key: null` for existing keys | finding 7 | None for correctness (never relied on) |
| A4 | `GET /models` is not blocked for a limit-0 key | Project-scoped key storage | Profile validation fails for a fresh zero-limit key; fallback: validate with `check_api_key` and treat 402 as "valid but capped" |
| A5 | 300 s skew allowance on the commit-time expiry | Invite protocol | Slightly wrong grace window; owner may prefer another value |
| A6 | Deleting leases and allocations on removal (instead of marking) is acceptable until Phase 66 | Materializer changes | Phase 66 may want allocation history; revisit then |
| A7 | SecretStorage is an acceptable place to hold a pending-join bundle across a window reload | Open Question 2 | Could violate "no clear-text invite code anywhere persistent" depending on how the owner reads it |
| A8 | Any org `member` can raise their own key's limit (from source; not exercised live with a plain-member session) | finding 3, Pitfall 3 | If the provider tightens this, the residual risk disappears; if my reading is wrong the other way, creating a key at 0 may be refused for plain members and the lead must create it |
| A9 | NEAR's own invitation expiry (`expires_at`) is set server-side and not controllable by the client | invite-by-email row | NEAR invitation may expire before the team invite; Re-issue handles it |

## Open Questions

1. **Provider cap against the key holder (owner decision 1 follow-up).**
   - What we know: lifetime semantics confirmed; any org member can create keys and change any key's limit; the invitee can therefore raise their own cap.
   - What's unclear: whether the owner accepts "provider cap protects against mistakes and overruns, not a malicious member" for v0.6.0; a tamper-proof alternative (lead creates and hands over the key) needs a secret transfer path the design forbids.
   - Recommendation: accept and document it; create the key at `spendLimit 0` as the invitee (D-12/D-13 as decided); lead sets the limit on confirm; Phase 66 reasserts the expected limit on every poll and flags drift as an alert. Confirm with the owner before planning copy that mentions "hard cap".
2. **D-07 resume versus D-05 never stored.**
   - What we know: `git.clone` opens a new window or reloads; the code can live only in memory in the pasting window.
   - Recommendation: default to re-paste in the cloned window (the "team.json found, no membership" prompt, D-22, already exists). Optional enhancement: keep the bundle in SecretStorage for at most one hour under `nearAi.team.pendingJoin.<teamId>` and delete on join or cancel. Needs an owner yes/no.
3. **Invitee NEAR login email versus invited email.** Recommendation: build the "no matching invitation" message and the emailed-token fallback; verify with the opt-in live test using a disposable address.
4. **Does a zero limit on create work for a plain `member` token?** Source says yes (`amount >= 0`, membership check only). Recommendation: the live test covers it; fallback in `nearOrg` if refused: create with `amount: 1` and report "capped at one nano-dollar".
5. **`member.joined` `nearApiKeyId` for a pasted key.** Recommendation: record the `api_key_id` from `check_api_key`; removal's target safety check protects the lead's own and admin keys.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | build and tests | yes | v24.22.2 (floor 22; no `/usr/bin/node` 22 here) | run team tests once under Node 22 before release (as in Phase 60 gate) |
| git | real-git tests, clone | yes | 2.53.0 | none needed |
| npm / `node_modules` | `npm run lint`, `npm test` | yes | present | none |
| `xvfb-run` | `npm run test:e2e` | no | n/a | run e2e with `DISPLAY=:0` as in `60-VALIDATION.md` |
| Network to `cloud-api.near.ai` | opt-in live test only | reachable (spec downloaded) | n/a | the default suite uses only the fake server |
| A real NEAR org, two accounts, a short-lived access token | opt-in live test and the manual check (success criterion 3) | not provided to this session | n/a | live test skips without env |

**Missing dependencies with no fallback:** none for the default suite.
**Missing dependencies with fallback:** `xvfb-run` (use `DISPLAY=:0`); Node 22 (run elsewhere before release).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` with `node:assert/strict` (compiled to `dist/test/*.test.js`) |
| Config file | none; `package.json` scripts `lint` (`tsc --noEmit`), `test`, `check`, `test:e2e` |
| Quick run command | `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` |
| Team family command | `npx tsc -p tsconfig.json && node --test dist/test/team*.test.js` |
| Full suite command | `npm run check` (lint plus full `npm test`) |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEAM-02 | Code generation (160 bit, alphabet, parse/normalise), HKDF key vector, proof bytes, bundle encode/parse/frozen vector, URL cleaning incl. the canary URL | unit | `node --test dist/test/teamInviteBundle.test.js` | Wave 0 |
| TEAM-02 | `member.invited` and invite-gated `member.joined` bodies: exact keys, secret-detector exemptions with 1000 random keys, unsupported-type test updated | unit | `node --test dist/test/teamValidate.test.js` | exists, update |
| TEAM-02 | Materializer: invited state, self-binding, bad proof, replay of a join, wrong device, wrong email hash, wrong role, `requireLeadConfirmation` true/false, observer invite, expiry (inside, edge, outside, commitTime 0), cancel, re-issue, duplicate email, owner role refused, role-changed clears `pendingRole`, snapshot round trip and Phase 60 snapshot hash unchanged, determinism property | unit/property | `node --test dist/test/teamInvite.test.js` | Wave 0 |
| TEAM-02 | Existing Phase 60 pins still pass or change deliberately (`ROSTER_AUDIT_TYPES`, member.invited-unsupported) | unit | `node --test dist/test/teamMaterialize.test.js dist/test/teamAudit.test.js` | exists, update |
| TEAM-02 | `nearOrg.ts` against the fake server: every endpoint, casing, the mis-cased-body-removes-cap trap, error shapes, 429/5xx retry and `Retry-After`, no blind POST retry, redaction of `key` and bearer from errors | integration | `node --test dist/test/teamNearOrg.test.js` | Wave 0 |
| TEAM-02 | `nearSession.ts`: refresh rotation, persist-before-use, concurrent refresh, expired session, logout deletes the secret even on failure | integration | `node --test dist/test/teamNearSession.test.js` | Wave 0 |
| TEAM-02 | End to end on two real clones plus the fake NEAR: link org, invite (NEAR invitation created, id found by email), join (accept, key at limit 0, profile active, session logged out), confirm (role-changed then limit set), failure rollbacks (cancelled invite, lost single-use race, expired), degraded no-NEAR path, paste path | integration | `node --test dist/test/teamJoin.test.js` | Wave 0 |
| TEAM-03 | Release on removal on fixture state (claims released to ready with branch kept, leases dropped, allocations removed, queue filtered, other members untouched), later events from the removed member's device rejected with the existing reason | unit | `node --test dist/test/teamInvite.test.js` | Wave 0 |
| TEAM-03 | Removal flow: order zero, log, revoke, org remove; failure at each step queues the checklist and never blocks the log; step 3 not attempted after a failed step 1; target safety refusals; invited cancel cancels the NEAR invitation; checklist persistence and retry | integration | `node --test dist/test/teamRemove.test.js` | Wave 0 |
| TEAM-03 | Removed client: wipes device key, team profile, session, reactivates personal profile, writes marker, no retries after restart | integration | `node --test dist/test/teamRemove.test.js` | Wave 0 |
| TEAM-02/03 | Commands registered and driven through the vscode stub: invite, join, manage members, link org, sign out; pending count in status text; messages contain no em-dashes and no secrets | unit | `node --test dist/test/teamCommands.test.js` | exists, extend |
| SEC-01 (criterion 4) | Privacy canary over the whole flow: API key, access and refresh tokens, clear-text code (in 3 renderings), device key forms absent from every coordination blob, `team.json`, settings, audit, transcripts, output channel text, extension storage files | integration | `node --test dist/test/teamInvitePrivacy.test.js` | Wave 0 |
| Criterion 3 | Opt-in live test: org and workspace listing, key create with limit 0, `check_api_key` 402, raise limit then 200 within a polling window, revoke, optional disposable-address invite list/cancel | live (opt-in) | `NEAR_LIVE_TEAM=1 NEAR_LIVE_TEAM_ACCESS_TOKEN=... NEAR_LIVE_TEAM_ORG_ID=... NEAR_LIVE_TEAM_WORKSPACE_ID=... node --test dist/test/teamNearLive.test.js` | Wave 0 (skips without env) |
| Criterion 5 | Solo parity: no new team work in a project without `team.json`, existing suite unchanged and green | regression | `npm run check` | exists (`teamSoloParity.test.ts`) |

### Sampling Rate
- **Per task commit:** `npm run lint` plus the one changed test file (target under 60 s).
- **Per wave merge:** `node --test dist/test/team*.test.js` plus `npm run lint`.
- **Phase gate:** `npm run check` green; team family once under Node 22; `npm run test:e2e` once (with `DISPLAY=:0`) for command registration; `npm run verify:release` once; manual check against a real NEAR organization (success criterion 3) with the opt-in live test run first.
- Security checks (signatures, proof, permission, forgery, canary) are blocking at every wave. Never delete, skip or weaken a failing test to get green.

### Wave 0 Gaps
- [ ] `src/test/helpers/fakeNear.ts` (no `.test` suffix) with: org/workspace/member/invitation/key model, session tokens with expiry and refresh rotation (old token reuse returns 401), role enforcement (invite/cancel/remove need owner/admin; key calls need membership), **real-server quirks** (`spendLimit` camelCase only; absent field stores null on the dedicated route; `check_api_key` 402 when `usage >= limit`, so 0 blocks; key `key` secret only in the create response; `invite-by-email` returns 200 with per-email results and no invitation id; invitation visible only to the matching login email), configurable key activation delay, fault injection (429 with `Retry-After`, 500, dropped connection), a request log that stores only method, path and which auth kind (never token values), and a usage injector.
- [ ] `src/test/teamInviteBundle.test.ts`, `teamInvite.test.ts`, `teamNearOrg.test.ts`, `teamNearSession.test.ts`, `teamJoin.test.ts`, `teamRemove.test.ts`, `teamInvitePrivacy.test.ts`, `teamNearLive.test.ts`.
- [ ] Extend `src/test/helpers/teamHarness.ts`/`teamEvents.ts` with an invited-member builder and a clock-injectable commit time; extend `teamCanary.ts` with `inviteCode` and `accessToken` canaries.
- [ ] No framework install needed.

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | NEAR OAuth session via existing loopback/paste flow; refresh rotation; never persist access tokens |
| V3 Session Management | yes | Single-flight refresh, logout on sign-out, per-team session secret, expiry handling |
| V4 Access Control | yes | `decideTeamAction` for invite/remove/role change on write and read; NEAR role checked from `GET /organizations` before offering link; target safety check before destructive NEAR calls |
| V5 Input Validation | yes | Exact-key bodies, strict base64url, bundle parser with caps, URL cleaning, treat NEAR and log text as untrusted |
| V6 Cryptography | yes | `node:crypto` only: HKDF-SHA256, Ed25519; 160-bit random code; no hand-rolled primitives |
| V7 Logging and errors | yes | No secrets in output channel, errors, audit; `safeReason` on all remote text; bodies of create-key responses never logged |
| V8 Data protection | yes | Keys and tokens only in SecretStorage; local checklists hold no secrets |
| V13 API | yes | Typed client, integer-only money, HTTPS base URL (loopback HTTP only for tests via `isSecureEndpoint`) |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Invite code leaks via the public coordination branch | Information disclosure | Only the HKDF-derived public key and a countersignature are logged; canary test over all blobs |
| Observer of the log forges a join | Spoofing | Join needs the invite private key; proof binds team, member, invite event and device |
| Replay of a captured `member.joined` | Tampering | Single use by state change; proof bound to invite event id and device; duplicate event id rejected |
| Joiner claims another person's email or a higher role | Elevation | Email hashes must equal the invite's; role must equal the computed expected role |
| Joiner names someone else's key id in `nearApiKeyId` | Tampering | Removal and confirm verify the key's creator and org role through NEAR before any write |
| Stale bundle used after expiry | Elevation | Commit-time expiry (hygiene) plus cancel; honest limit stated |
| Credentials in the bundle's repo URL | Information disclosure | `cleanRepoUrl` drops userinfo, refuses queries, `findSecrets` on the result, canary URL test |
| Refresh-token theft or reuse | Spoofing | SecretStorage only, rotation makes stolen tokens single-use, logout on sign-out |
| Mis-cased limit field removes a cap | Tampering | Typed method, post-call assertion on `spend_limit`, fake-server trap test |
| Hostile NEAR or log strings in UI | Tampering | Flatten and escape before display |
| Member raises own provider limit | Elevation | Documented residual risk; Phase 66 drift reassertion (Open Question 1) |
| Removed member's client keeps secrets | Information disclosure | D-20 wipe on sync; key already revoked so residue is worthless |

## Sources

### Primary (HIGH confidence)
- `https://cloud-api.near.ai/api-docs/openapi.json` (fetched in full and parsed: paths, security, request and response schemas for every row of the contract table)
- `https://docs.near.ai/llms.txt` and the pages it links: invite-by-email, list/cancel invitations, accept invitation, remove member, workspaces, API keys, spend limit, usage, access tokens (read; consistent with the OpenAPI document)
- `github.com/nearai/cloud-api` @ `72d98902a0e7a471eaceeed6cc7b5ba29d0eebff` (committed 2026-10-30): `crates/api/src/models.rs` (request structs, `DecimalPriceRequest::validate`), `crates/api/src/routes/workspaces.rs`, `crates/services/src/workspace/mod.rs` (`check_workspace_permission`), `crates/services/src/organization/{mod,ports}.rs` (`create_invitations`, `can_invite_as`), `crates/database/src/repositories/api_key.rs` (lifetime usage), `crates/api/src/middleware/usage.rs` (`>=` gate, 402), `crates/api/src/routes/users.rs` and `lib.rs` (rotation, logout), `crates/database/src/cp_client/{check_api_key,config}.rs` (verdict cache)
- In-repo source read this session: `src/domain/team/{types,validate,materialize,permissions,secrets,canonical}.ts`, `src/team/{eventLog,enable,teamFile,identity,gitTransport,transport,auditMirror}.ts`, `src/services/{reportingSignIn,auth,profileStore,nearAiClient,spendTracking(main)}.ts`, `src/domain/auth.ts`, `src/services/team/{teamCommands,teamSession,teamStatusBar}.ts`, test helpers; `git show d637578`, `git show 403c06e`, `git merge-tree --write-tree HEAD main`
- `node:crypto` experiment (HKDF, PKCS#8 seed wrap, sign/verify, determinism) run in the scratchpad on Node 24.22.2

### Secondary (MEDIUM confidence)
- `.planning/research/v0.6.0-team-mode-addendum.md` §6.1 to 6.3, 6.10, 6.14, 7, 11, 14, Appendix A (spec intent; its path spelling `access_tokens` is superseded above)
- `.planning/phases/60-*/60-CONTEXT.md`, `60-VALIDATION.md` (gate shape and environment notes)

### Tertiary (LOW confidence)
- Behaviours marked `[ASSUMED]` above (propagation timing, wallet-user invitations, `/models` not gated for a zero-limit key, skew allowance) pending the opt-in live test

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no new dependencies, all primitives verified in `node:crypto`
- NEAR API contract: HIGH for paths, casing, roles and lifetime semantics (spec plus server source); MEDIUM for timing and account-matching behaviour
- Architecture and pipeline changes: HIGH, derived from reading the current validator, materializer and writer line by line
- Pitfalls: HIGH for 1, 2, 5, 8, 9, 10 (evidence in hand); MEDIUM for 4, 6, 11, 12

**Research date:** 2026-11-01
**Valid until:** 2026-11-15 for the NEAR contract (the provider ships frequently; re-fetch `openapi.json` and diff before executing), 30 days for the in-repo design
