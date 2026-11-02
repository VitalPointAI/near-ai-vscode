# API Coverage — NEAR AI Cloud (organization, invitation, workspace key, spend-limit, usage and session endpoints)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Source of the surface: 61-RESEARCH.md "NEAR AI Cloud contract" (openapi.json at https://cloud-api.near.ai/api-docs/openapi.json and the cloud-api server source). Paths are relative to `https://cloud-api.near.ai/v1`.
> Built in `src/team/nearOrg.ts` (plan 61-02), `src/team/nearSession.ts` (61-04) and the existing `src/services/reportingSignIn.ts`; every INTEGRATE row is served by `src/test/helpers/fakeNear.ts` and tested in `src/test/teamNearOrg.test.ts` or `src/test/teamNearSession.test.ts`.

| capability | decision | reason |
|---|---|---|
| list-organizations (GET /organizations) | INTEGRATE | |
| list-workspaces (GET /organizations/{org}/workspaces) | INTEGRATE | |
| list-org-members (GET /organizations/{org}/members) | INTEGRATE | |
| invite-by-email (POST /organizations/{org}/members/invite-by-email) | INTEGRATE | |
| list-org-invitations (GET /organizations/{org}/members/invitations) | INTEGRATE | |
| cancel-invitation (DELETE /organizations/{org}/members/invitations/{id}) | INTEGRATE | |
| list-my-invitations (GET /users/me/invitations) | INTEGRATE | |
| accept-invitation-by-id (POST /users/me/invitations/{id}/accept) | INTEGRATE | |
| accept-invitation-by-token (POST /invitations/{token}/accept) | INTEGRATE | |
| remove-org-member (DELETE /organizations/{org}/members/{user_id}) | INTEGRATE | |
| create-key-with-spend-limit (POST /workspaces/{ws}/api-keys) | INTEGRATE | |
| list-keys-with-usage (GET /workspaces/{ws}/api-keys) | INTEGRATE | |
| set-key-spend-limit (PATCH /workspaces/{ws}/api-keys/{id}/spend-limit) | INTEGRATE | |
| revoke-key (DELETE /workspaces/{ws}/api-keys/{id}) | INTEGRATE | |
| key-usage-history (GET /workspaces/{ws}/api-keys/{id}/usage/history) | INTEGRATE | |
| check-api-key (POST /check_api_key) | INTEGRATE | |
| current-user (GET /users/me) | INTEGRATE | |
| refresh-access-token (POST /users/me/access-tokens) | INTEGRATE | |
| logout-current-session (POST /auth/logout) | INTEGRATE | |
| browser-oauth-sign-in (loopback and paste callback) | INTEGRATE | |
| remove-key-spend-limit (spendLimit null) | OPT-OUT | explicitly out of scope: the extension never lifts a cap; no method can build a body without an integer spendLimit (research Pitfall 1) |
| general-key-update (PATCH /workspaces/{ws}/api-keys/{id}) | OPT-OUT | not needed: limits go through the dedicated spend-limit route and keys are revoked, never renamed or paused |
| decline-invitation (invitee side) | OPT-OUT | not needed: an invitee who does not want to join simply does not run Join; the lead cancels the team invite |
| change-organization-member-role | OPT-OUT | not needed yet: this phase has no team role-change command beyond Confirm; a demoted lead keeping org admin is recorded as a residual risk in 61-11 |
| create-update-delete-organization | OPT-OUT | explicitly out of scope: a team links an existing NEAR organization (D-03), it never creates or deletes one |
| create-update-delete-workspace | OPT-OUT | explicitly out of scope: a team links an existing workspace (D-03) |
| revoke-all-user-sessions (DELETE /users/me/tokens) | OPT-OUT | explicitly forbidden: it signs the user out of every session including the NEAR console (research finding 6) |
| organization-usage-summary (reporting token route) | OPT-OUT | already integrated by the 0.4.x reporting-token flow, which this phase leaves unchanged (D-01) |
| inference-and-model-catalog (chat completions, models, pricing) | OPT-OUT | already integrated by the 0.4.x NearAiClient; this phase adds no inference calls |
