# Phase 61: Invitations, joining, removal, NEAR org and key integration - Context

**Gathered:** 2026-11-01
**Status:** Ready for planning
**Mode:** interactive (owner answered every gray area). Spec phase 26 = this Phase 61.
**Branch:** `gsd/phase-61-invitations-joining-removal-near-org-and-key-integration`, cut from the Phase 60 tip (`ae5e9e1`) in the `.claude/worktrees/team-mode` worktree, with `main` merged in before planning (D-28). Phase 60 is not yet merged into `gsd/milestone-v0.6.0-team-mode` and has no PR.

<domain>
## Phase Boundary

A lead brings people into the team and removes them cleanly. Invite by email with a role and allocation produces a copyable invite bundle (and, when a NEAR organization is linked, a NEAR org invitation). The invitee runs `NEAR AI: Join Team` with a single-use code, accepts the NEAR org invitation, gets their own API key in the team workspace stored only in project-scoped SecretStorage, and stays `observer` until the lead confirms. Removal releases everything the member held, revokes their devices, zeroes then revokes their NEAR key, removes them from the org, and reminds the lead to remove repository access.

Delivers: validators and materialiser handling for `member.invited`, `member.joined` (non-genesis, invite-gated), `member.removed` (members and pending invitees), `device.*` for joiners; `src/team/nearOrg.ts` (organization, invitation, workspace key, spend-limit and usage endpoints, `vscode`-free); the stored per-team NEAR session; commands for invite, join, manage members/invitations, link NEAR organization and sign out of NEAR; a fake NEAR API server for tests plus one opt-in live test behind an environment flag.

Release of claims, leases and allocations on removal is defined in the materialiser and proven on fixture state here; end-to-end proof comes in Phases 63 and 66. Not in this phase: allocation events and spend-limit raises per grant (66), the board (62), claims/leases (63).

</domain>

<decisions>
## Implementation Decisions

### Lead's NEAR session
- **D-01:** The NEAR session is kept, not discarded. The OAuth sign-in from `src/services/reportingSignIn.ts` is reused, but instead of signing out at once, the session's refresh token is stored in SecretStorage and access tokens are refreshed as needed. Status shows "NEAR: signed in as <account>" and a `NEAR AI: Sign Out of NEAR (Team)` command revokes the session (`POST /v1/auth/logout`) and deletes it. One sign-in serves invite and remove now and Phase 66's grant-time limit raises and usage reconciliation. The existing `rpt-` reporting-token flow is unchanged.
- **D-02:** The session is scoped per team: SecretStorage key `nearAi.team.nearSession.<teamId>`. Signing out of one team leaves others alone. An invitee signs in only to accept the org invite and create their key, and is signed out after join (their session is not kept unless they later act as a lead and sign in again).
- **D-03:** Linking a NEAR organization: the first invite on a team without `team.json` `near` offers "Link a NEAR organization" (sign in, pick organization and workspace from lists, or skip). A standalone `NEAR AI: Link Team to NEAR Organization` command does the same. Linking writes `near: { organizationId, workspaceId }` into `team.json` and commits only that file on the current branch, the same way Enable does (Phase 60 D-20: `git add -f`, `git commit --only`, offer Push, never push automatically).
- **D-04:** Teams without a NEAR organization can still invite and join, visibly degraded: the log-only flow works, the member supplies their own key, there is no provider spend cap, and the roster (later the board) says so plainly ("No NEAR organization linked: spend is not capped at the provider").

### Invite bundle and code
- **D-05:** The bundle is one pasteable string, `near-ai-invite-v1.<base64url of canonical JSON>`, holding repo URL, team ID, coordination ref and the single-use code. `NEAR AI: Join Team` accepts it. It is shown once in a dialog with Copy; the code is never logged, stored in clear text, or shown again. Only a hash or derived public value is stored, so a lost bundle means Re-issue. Works the same in desktop VS Code and code-server. — **Reversibility:** costly — bundles already handed out must stay parseable; a v2 format must keep accepting v1.
- **D-06:** The repo URL in the bundle has any credentials (userinfo, tokens) removed before it is written. If it cannot be cleaned, the invite refuses with the reason. The URL is never logged (Phase 60 D-34).
- **D-07:** If Join runs outside a repo whose `team.json` matches the bundle's team ID, it offers VS Code's built-in Git: Clone with the bundle's URL, then resumes Join once the matching `team.json` is found. Opening a repo that has `team.json` but no local membership also offers Join (Phase 60 D-22).
- **D-08:** Invite expiry defaults to 7 days; the lead can choose 24 hours, 3 days, 7 days or 14 days when inviting. Expiry is evaluated without wall-clock ordering (project constraint). Research decides the exact rule, such as comparing against the join commit's timestamp, carried by the transport (Phase 60 D-18), against the invite's recorded expiry.
- **D-09:** The single-use code must prove possession without appearing in the log. Success criterion 4 forbids a clear-text invite code on the coordination branch, so `member.joined` must not carry the raw code. Suggested mechanism for research to confirm: derive an Ed25519 key pair from the code; `member.invited` records the derived public key; `member.joined` is countersigned by the derived key over the joiner's device public key. This is not replayable, and the code stays out of the log. The code must have at least 128 bits of entropy, because its derived value is public. — **Reversibility:** one-way — the `member.invited` / `member.joined` bodies are signed into the log permanently.
- **D-10:** `member.invited` creates a member record in an `invited` status carrying the email hash (Phase 60 D-31; the plain email stays in the inviting device's local display cache only), role, allocation (integer nano-USD), expiry and the code proof value. No new event type is added for cancel: cancelling a pending invite writes `member.removed` for the invited member's id. Re-issue cancels the old invite and writes a new `member.invited` with a new code. — **Reversibility:** one-way — the meaning of `member.removed` on an invited member becomes part of the log format.
- **D-11:** `NEAR AI: Manage Team Members` lists members and invitations (pending, expired, used) with Cancel and Re-issue on invitations and Confirm and Remove on members.

### Invitee's NEAR key
- **D-12:** At join, after the invitee signs in and accepts the org invitation, the default creates a new API key in the team workspace named after team, member and device, and stores it directly in project-scoped SecretStorage (existing `ProjectCredentialScope`). The alternative is pasting an existing key, validated against the team's organization and workspace through `/v1/check_api_key`. Only the key ID (never the key) is recorded in the log, in `member.joined` or a follow-up profile event. Without a linked NEAR organization (D-04), only paste is offered and there is no workspace check.
- **D-13:** A new key starts with a spend limit of 0, matching observer status. When the lead confirms the member (D-15), the lead's client, which holds the NEAR session, sets the key's limit to the invite's allocation. Phase 66 then raises it on each grant. Who may set limits and create workspace keys is a research question (owner decision 1). If the invitee cannot create a key or set a zero limit with their own role, research must say which party does it.
- **D-14:** After join, the team key becomes the project's active credential, as a new project-scoped profile selected for this project. The member's existing personal profile is kept and can be switched back to. Team runs that use a non-team key are tagged and warned about.

### Lead confirmation
- **D-15:** Confirmation writes `member.role-changed` from `observer` to the role on the invite; no new event type. Then the lead's client sets the key's spend limit (D-13). If the invited role is `observer`, the member is confirmed on join. With `requireLeadConfirmation: false`, `member.joined` takes the invited role directly. — **Reversibility:** one-way — confirmation semantics are encoded in the signed roster history.
- **D-16:** When a sync brings in a `member.joined` awaiting confirmation, the lead's or owner's window shows "<name> joined <team> and is waiting for confirmation" with Confirm and Remove buttons. The Team status bar item shows a pending count, and the Manage Team Members list (D-11) covers it too.

### Removal
- **D-17:** Removal order: (1) set the member's NEAR key spend limit to 0 (fast cut-off for in-flight spend); (2) write `member.removed` (with device revocation, so later events from those keys are rejected per Phase 60 D-11); (3) revoke the NEAR key; (4) remove the member from the NEAR organization. The key is never revoked before step 1 succeeds.
- **D-18:** A failed NEAR step never blocks the log removal. Failed or skipped steps go into a local "NEAR cleanup pending" checklist with Retry, persisted locally, holding no secrets, and shown in Manage Team Members. If step 1 fails, the lead is warned prominently that the key is still able to spend. The checklist always ends with the reminder to remove the member's repository access (spec 6.2).
- **D-19:** On removal the materialiser releases the member's claims to `ready` (branches preserved), releases their leases and revokes their allocations (unspent returns to the pool). This is proven on fixture state in this phase, end to end in Phases 63 and 66.
- **D-20:** When the removed member's own client syncs its `member.removed`, it stops team sync and shows "You were removed from <team>". It deletes this team's device key, team API key profile and NEAR session from VS Code SecretStorage (unrelated to `~/.near-credentials`), and reactivates the member's personal profile if one exists. Local code and branches are untouched. Team Mode for that project shows a removed or read-only state rather than retrying.

### Decisions revised after research (owner, 2026-11-01; these supersede the decisions they name)
61-RESEARCH.md found, from NEAR's OpenAPI document and server source, that **any org member of any role can create keys and set or remove the spend limit on any key in the workspace**, including their own. The owner requires **an enforceable hard cap that the lead sets per team member**. So members never join the NEAR organization, and only the owner and leads do.
- **D-21 (supersedes D-12, D-13 and spec 6.2 join step 3):** In a team with a linked NEAR organization, `developer`, `reviewer` and `observer` members are **not** invited to the NEAR organization and never hold a NEAR session for the team. Each such member's API key is created by the confirming lead's client in the team workspace, with `spendLimit` equal to the member's allocation in the same create call. Only org owners and admins (the team's owner and leads) can change it. A NEAR API key is a bearer credential and needs no org membership to use. Members cannot paste their own key in a NEAR-linked team, because a key the lead does not control is not capped. In a team without a NEAR organization (D-04), paste stays the only path, with the "not capped at the provider" notice. — **Reversibility:** costly — moving members into the org later would lose the enforceability guarantee and change the join and removal flows.
- **D-22 (supersedes the spec 6.2 invite step 2 for non-leads):** The NEAR "invite by email" call is used only when the invited role is `lead`, at org role `admin`. Owner invitations are refused by NEAR. A lead accepts through `GET /users/me/invitations` then `POST /users/me/invitations/{id}/accept`, with the emailed-token fallback (`POST /invitations/{token}/accept`) and a "no matching invitation" message when the login email differs (research Open Question 3). Leads keep a per-team session (D-01, D-02). Invited developers, reviewers and observers sign in to nothing.
- **D-23 (key delivery, sealed to one device):** At join, the joining device generates an X25519 key pair (`node:crypto`). Its public key is published in `member.joined` next to the Ed25519 device key; the private key goes into SecretStorage under the device's team scope, like the device key (Phase 60 D-14). On confirm, the lead's client creates the key (D-21) and appends a signed roster event carrying the `sk-` key **sealed to that one device**: an ephemeral X25519 key, ECDH, HKDF-SHA256 and AES-256-GCM. The event also carries the key ID, the target member and device, and a context binding team, member, device and key ID as AAD. It must not carry the clear-text key, and the lead's client discards the clear key from memory right after sealing. The member's client opens it, stores the key in project-scoped SecretStorage (D-14), and runs check_api_key with the bounded activation retry from research. `assertNoSecrets` must still pass. The detectors exempt the sealed fields only by strict shape (base64url ciphertext, nonce, tag and ephemeral public key under named keys), the same way Phase 60 exempts `publicKey` and `sig`. The privacy canary asserts the clear-text `sk-` canary never appears. The event type name and body are for the planner; one new type added to the union is acceptable. — **Reversibility:** one-way — the sealed-key event body and its AAD binding are signed into the log permanently.
- **D-24 (ciphertext permanence):** The sealed key stays in the log forever, so every key ever sealed is revoked when its member is removed (D-17), and a member's key is re-created and re-sealed when they add a device or a device is revoked. Re-sealing an existing key to a new device without rotating it is not allowed. Planner's choice whether device add rotates the key or only re-seals; revocation always rotates.
- **D-25 (amends D-15 and D-17):** Confirm becomes: `member.role-changed` observer → invited role, then create the key with the allocation as its limit, then seal and deliver it (D-23). If key creation fails, the confirm stays done and a "key not delivered" item with Retry goes on the lead's checklist (the D-18 pattern). Removal of a non-lead member is: set limit 0, write `member.removed`, revoke the key; there is no org member to remove. Removal of a lead also removes their org membership (step 4).
- **D-26 (amends D-02 and D-07):** Join never signs in to NEAR for non-lead roles. After a clone (D-07), Join asks the invitee to **paste the bundle again**; nothing is stored between windows.
- **D-27 (copy):** UI text may call this a hard cap or spend cap set by the lead. The threat model records the residual risks: in-flight overshoot of seconds (research finding 4); another lead can change any key's limit, since leads are trusted with budgets anyway; and a member who extracts the key from SecretStorage can spend only up to the cap.
- **D-28 (branch):** `main` was merged into this branch before planning (merge commit `aab035e`), at the owner's request after research. The extracted sign-in helper therefore includes the code-server paste fix `d637578`. The four `.planning` state files kept their Team Mode versions.

### Claude's Discretion
- Exact event body field names, beyond the constraints above, and the bundle's JSON shape.
- Code alphabet and length (subject to ≥128 bits, D-09), and how the code is shown (for example grouped characters).
- Key naming format (D-12), wording of notifications and checklist items (plain language, no em-dashes), and where the cleanup checklist is persisted.
- Module split for the commands (`src/services/team/*`) and `nearOrg.ts` internals; retry and backoff on NEAR HTTP errors.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (source of truth)
- `.planning/research/v0.6.0-team-mode-addendum.md` §6.1, §6.2 (invite, join, remove), §6.3 (permissions: invite/remove/change roles), §6.10 (provider hard cap, spend-limit endpoint), §6.14, §7 (data model), §10 (phase 26 = Phase 61), §11, §14 decision 1, Appendix A (NEAR endpoints).
- `https://docs.near.ai/llms.txt` — confirm exact endpoint paths and field casing (`spend_limit` vs `spendLimit`), spend-limit semantics (lifetime or per period), and which org role may set limits and create workspace keys (roadmap research flags 1 and 2).

### Planning
- `.planning/ROADMAP.md` Phase 61 — goal, scope, research flags, success criteria 1 to 5.
- `.planning/REQUIREMENTS.md` — TEAM-02, TEAM-03.
- `.planning/PROJECT.md` "Current Milestone: v0.6.0 Team Mode" — constraints (no `vscode` in team core, no new runtime deps, no secrets anywhere, integer nano-USD, no wall-clock ordering, solo parity).
- `.planning/UX-CONTRACT.md` — privacy boundary, verbosity, interruptibility.
- `.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-CONTEXT.md` — D-07 (implemented types), D-09 to D-12 (validation pipeline, positional revocation, permissions), D-14 (device key storage), D-20 to D-22 (Enable, `team.json`, Join offer), D-23 (secret checks and canary), D-31 (email hashes), D-32, D-34.
- `.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-RESEARCH.md` — Phase 60 event body schemas this phase extends.

### Codebase maps
- `.planning/codebase/ARCHITECTURE.md`, `CONVENTIONS.md`, `CONCERNS.md`, `TESTING.md`, `INTEGRATIONS.md`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/services/reportingSignIn.ts`: NEAR OAuth via loopback (`startLoopbackSignIn`, `loginUrl`, `parseCallback`), `call()` helper, `signOut()`. Basis for the kept team session (D-01). **Note:** `main` has two later fixes not on this branch: `d637578` (sign-in from code-server on another computer finished by pasting) and `403c06e` (a 404 usage summary means "not offered yet"). Research must account for them, because the paste path matters for leads and invitees on code-server; they arrive when the team branches rebase onto `main`.
- `src/domain/auth.ts` `ProjectCredentialScope`, `createProjectCredentialScope`, `src/services/auth.ts` `SecretStorageLike`, `src/services/profileStore.ts`: project-scoped key storage and profile selection (D-12, D-14).
- `src/services/spendTracking.ts` / `reportingToken.ts`: existing NEAR org lookups (`/v1/check_api_key` organization), token-shape guards.
- `src/domain/team/{types,validate,materialize,permissions,secrets}.ts`: add validators for `member.invited` and non-genesis `member.joined`; `member.invited` is in `TEAM_EVENT_TYPES` but not `IMPLEMENTED_EVENT_TYPES`.
- `src/team/{enable,teamFile,identity,eventLog}.ts`: the Enable flow's commit-only-`team.json` pattern (D-03) and device-key generation for joiners.
- `src/services/team/{teamCommands,teamSession,teamStatusBar}.ts`: register new commands; pending-confirmation count in the status bar (D-16).

### Established Patterns
- Team core (`src/domain/team/*`, `src/team/*`) never imports `vscode`; `nearOrg.ts` takes an injected `fetch`, like `reportingSignIn.ts`.
- Tests: `node --test`, real git in `mkdtemp` dirs, `.invalid` emails; a local fake HTTP server for NEAR (no network in the default suite); the live test runs only behind an environment flag.
- Every write: `decideTeamAction` first, `assertNoSecrets` before persisting.

### Integration Points
- `package.json` contributes: `nearAi.team.invite`, `nearAi.team.join`, `nearAi.team.manageMembers`, `nearAi.team.linkNearOrganization`, `nearAi.team.signOutNear` (final ids at the planner's discretion).
- `team.json` `near` field (already optional in the format, Phase 60 D-21).
- Privacy canary (success criterion 4) extends the Phase 60 canary: API key, session and refresh tokens, and the clear-text invite code must not appear on the coordination branch, in `team.json`, settings, audit or transcripts.

</code_context>

<specifics>
## Specific Ideas

- The owner wants invite and join to work identically in desktop VS Code and code-server; this drove the single-string bundle (D-05) and the attention to the paste-to-finish sign-in fix on `main`.
- Removal favours cutting spend fast (limit 0 first) and never losing the log removal to a NEAR outage.

</specifics>

<deferred>
## Deferred Ideas

- Re-joining after removal, adding a second device for an existing member through an invite-like flow, and per-role limits on who a lead may invite: raised as possible further gray areas but not discussed; the planner applies the spec 6.1 to 6.3 defaults.
- A `vscode://` deep link for the bundle: not chosen (code-server reliability, and it puts the code in a URL); could be added later as an extra alongside the v1 string.

</deferred>

---

*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Context gathered: 2026-11-01*

## Owner decision (2026-11-04): connecting from inside the team setup

When Invite someone / Join a team (or the team setup) offers "Connect NEAR AI" and the person connects, the 0.4.14 next-step menu ("NEAR AI is ready ... What next?", PR #7) is NOT shown: the person gets the plain "NEAR AI is ready" message and the team flow continues. Implemented in the 0.6.2 integration preview as `configureApiKey(auth, sidebar, context, { offerNextStep: false })` from `connectNearAi` in src/extension.ts. Apply the same when main (with PR #7) is merged into Team Mode.
