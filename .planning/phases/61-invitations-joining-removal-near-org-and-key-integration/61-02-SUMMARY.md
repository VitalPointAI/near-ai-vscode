---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 02
subsystem: near-integration
tags: [near-ai-cloud, spend-limit, api-keys, invitations, fake-server, retry, redaction]

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: plan 01 invite and join log protocol (not called by this plan; independent wave-1 work)
provides:
  - src/team/nearOrg.ts, a vscode-free typed NEAR AI Cloud client (orgs, workspaces, members, invitations, workspace keys, spend limits, usage history, current user, check_api_key)
  - src/test/helpers/fakeNear.ts, a fake NEAR server over real HTTP that reproduces the real quirks, with fault injection
  - the spend-limit guarantee: one body builder, camelCase only, response amount asserted after every create and set
affects: [61-03, 61-04, 61-05, 61-06, 61-11, 66]

plan_head_before: d4e82891f53f7157fd9838911b55958ea01fc093
plan_head_after: c210aa6d47151a726116d4b082996d08e1e22b83
actuals:
  tokens: 23775
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "one private body builder for a security-relevant request field, with the answer checked against what was sent"
    - "fake server that implements the real server's traps (null on a mis-cased limit) so a wrong client fails a test"
    - "retry only idempotent calls; a POST that may have taken effect is reconciled by listing by unique name"
    - "scrubNearText: known credentials cut out by value, token shapes hidden by pattern, control characters dropped, 300 character bound"

key-files:
  created:
    - src/team/nearOrg.ts
    - src/test/helpers/fakeNear.ts
    - src/test/teamNearOrg.test.ts
  modified: []

key-decisions:
  - "createKey also reconciles (list by name, revoke matches) after a 5xx, not only after a network error or timeout, because a 500 may follow a successful create"
  - "checkApiKey returns empty organizationId/apiKeyId for a 402 whose body has no ids, rather than guessing; callers compare against the team organization and so refuse"
  - "Retry-After is read through an optional headers object, so the shared FetchLike type in reportingSignIn.ts is untouched"
  - "A scale above 9 in a response price is rounded up to whole nano-USD so a spend figure is never understated; scale below 9 is multiplied up; all by BigInt"
  - "cancelInvitation maps both 400 and 404 to not-pending (an invitation that does not exist is not pending)"

requirements-completed: []  # TEAM-02 and TEAM-03 are only partly delivered here (the NEAR client); the phase finishes them, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "A key is created with its spend limit in the same call, lowered to zero and revoked over real HTTP against the fake"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearOrg.test.js#tracer: a key is created with its cap in the same call, lowered to zero and revoked over real HTTP"
        status: pass
    human_judgment: false
  - id: D2
    description: "No method can send a missing, null or snake_case limit; non-integer, negative and unsafe amounts throw RangeError before any request; a mismatched answer fails and revokes a new key"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamNearOrg.test.js#a spend limit is only ever a whole number of nano-USD; #a response that carries a different limit; #the real traps"
        status: pass
    human_judgment: false
  - id: D3
    description: "The fake reproduces the real quirks: null on a mis-cased or missing limit, 402 at the limit so 0 blocks, secret only on create, 200 per-email invite results with no id, invitations by login email, single-use refresh tokens, role checks, last-owner rule"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearOrg.test.js (inviting by email, invitation matching, removing a member, the real traps, the fake rotates refresh tokens)"
        status: pass
    human_judgment: false
  - id: D4
    description: "GET, DELETE and the spend-limit PATCH retry on 429 (Retry-After), 5xx and dropped connections up to 3 times; POST is never retried; a lost create-key answer is reconciled by name"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearOrg.test.js#GET, DELETE and the spend-limit PATCH retry; #four 500s; #a POST is never retried blindly; #a create-key whose answer is lost"
        status: pass
    human_judgment: false
  - id: D5
    description: "No error, message or request log holds a bearer token, refresh token or key secret; NEAR text is bounded and redacted; the emailed invitation token is never echoed or logged"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearOrg.test.js#no error, message or request log ever holds a bearer token"
        status: pass
    human_judgment: false
  - id: D6
    description: "A removal can zero and revoke a key and remove an org member through this client (D-17), with missing keys and members answered as missing"
    requirement: TEAM-03
    verification:
      - kind: integration
        ref: "dist/test/teamNearOrg.test.js#removing a member; tracer revoke steps"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-11-02
status: complete
---

# Phase 61 Plan 02: NEAR organization and key client Summary

**A vscode-free NEAR AI Cloud client whose spend limit can only leave as camelCase integer nano-USD and is checked on the way back, proven over real HTTP against a fake server that stores no limit for a mis-cased body, exactly like the real one.**

## Performance

- **Duration:** about 35 min (start time was not recorded at launch, so this is an estimate)
- **Completed:** 2026-11-02T01:04Z
- **Tasks:** 2 (a tracer and the remaining surface), 4 commits (RED and GREEN each)
- **Files:** 3 created, 0 modified

## Accomplishments

- `NearOrgClient` covers every INTEGRATE row of COVERAGE.md that belongs to this plan: organizations, workspaces, organization members and removal, invite by email, list and cancel invitations, my invitations, accept by id and by emailed token, create, list, find, limit and revoke workspace keys, per-key usage history, the current user, and `checkApiKey`. Refresh and logout are served by the fake (for the session plan 61-04) and not called by this client.
- Spend limit safety (T-61-06): `spendLimitBody` is the only place a limit body exists. It rejects anything but a safe integer of zero or more with `RangeError` before any request. `createKey` and `setSpendLimit` compare the returned limit with the one sent and throw `limit-mismatch` otherwise; a mismatched new key is revoked first. Mutating the body to snake_case failed 10 of 26 tests, so the guard is real.
- Fake server (`startFakeNear`) on `127.0.0.1:0`: camelCase-only limits, 402 at or above the limit, create-only secrets, invite-by-email answering 200 with per-email results and no id, invitations visible only to the matching login email (case-insensitive), single-use refresh tokens with `POST /v1/users/me/access-tokens`, `POST /v1/auth/logout` (current session only), role checks, last-owner rule, usage history, activation delay, and fault rules (`status` or `drop`, `times`, `retryAfterSeconds`, `message`, `afterEffect`). Its request log keeps method, path, auth kind and status only, and replaces the emailed token in a path with `:token`.
- Retry (T-61-08): idempotent requests (GET, DELETE, spend-limit PATCH) retry on 429, 5xx and dropped connections up to `maxRetries` (default 3), honouring `Retry-After` seconds (capped at 60 s) or backing off 250 ms doubling. A 401 gets exactly one refresh and one retry for any method. A POST is never retried by `send`.
- Orphan keys (T-61-09): after a POST that may have taken effect (network error, timeout or 5xx), `createKey` lists the workspace's keys, revokes every key with the exact requested name, and throws with a plain note of what it did. The request log shows POST, GET, DELETE.
- Redaction (T-61-07): `scrubNearText` cuts out the credentials the client holds by value, hides `sk-`, `rt_` and JWT shapes and `redactSecrets` patterns, drops control characters and bounds to 300 characters. A test feeds hostile server messages through every error path and checks `message`, `stack`, `JSON.stringify` and `String` of each error.
- Base URL (T-61-10): `NearOrgClient` throws `RangeError` and `checkApiKey` answers `unavailable` for anything `isSecureEndpoint` rejects.

## Task Commits

1. **Task 1 (tracer): create a key with a limit, lower it, revoke it** - RED `7c8ce21` (test), GREEN `81a3e94` (feat)
2. **Task 2: the rest of the surface, traps, retry and redaction** - RED `001e0f3` (test), GREEN `c210aa6` (feat)

Tracer feedback gate (auto mode): the end-to-end verify command was re-run and passed; logged as "Tracer verified end-to-end, expanding".

## Files Created/Modified

- `src/team/nearOrg.ts` - the client, error type, `scrubNearText`, `checkApiKey`
- `src/test/helpers/fakeNear.ts` - the fake NEAR server
- `src/test/teamNearOrg.test.ts` - 26 tests (the acceptance bar was 12)

## Contract findings (from the live OpenAPI document, fetched during this plan)

- `usage` on a key is a `DecimalPrice` `{amount, currency, scale}` exactly like `spend_limit` (the schema is shared), so both go through one integer converter. `CreateApiKeyRequest` and `UpdateApiKeySpendLimitRequest` use `spendLimit` with `DecimalPriceRequest` `{amount, currency}` (no scale), confirming research finding 1.
- `GET /organizations/{org}/members` returns `PublicOrganizationMemberResponse`: `{id, organization_id, role, joined_at, user: {id, username, display_name, ...}}`. There is no email in it. `listMembers` therefore reads `user.id` (falling back to `user_id`) and exposes `email` only if a server returns one. Plan 61-11 cannot rely on member emails from this route and must use the locally cached email or `currentUser`/invitation emails.
- `GET /v1/organizations` role is per organization; `GET /users/me` organizations are `{id, name, role, ...}`.
- Usage history entries carry `total_cost` as an integer (the schema pairs it with `total_cost_display`). It is read as whole nano-USD (scale 9), the same unit as key spend; the live test should confirm this on the first real call.
- `/auth/logout` and the refresh route spelling `access-tokens` were taken from research; the fake implements both, this client calls neither (plan 61-04).

## Decisions Made

See `key-decisions` in the frontmatter. The two most consequential: `createKey` also reconciles after a 5xx, and a 402 from `check_api_key` with no body ids yields empty ids on a `capped` result.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] createKey reconciles after a 5xx as well as after network errors**
- **Found during:** Task 2 (designing the POST rules)
- **Issue:** The plan lists network error or timeout only. A 500 can be returned after the key was created (the fake's `afterEffect` rule proves it), which would leave an orphan key that can still spend.
- **Fix:** `createKey` runs the list-by-name-and-revoke step for `network` and `server` errors. Other errors (400, 403 and so on) mean nothing was made and are rethrown untouched. The test "a POST is never retried blindly" still shows exactly one POST.
- **Files modified:** src/team/nearOrg.ts
- **Commit:** 81a3e94

**2. [Plan interface addition] Fake gained optional extras**
- `FakeFailRule` gained `message` and `afterEffect`; `startFakeNear` gained `membersIncludeEmail`; `FakeNear` gained `emailedToken(email)`. All additive to the planned interface. They were needed to test redaction, the "answer lost" create-key recovery, the member-email case, and token acceptance.

**3. [Plan note] TDD RED evidence**
- Both RED commits fail at compile time (the module or methods do not exist yet), the same unavoidable form as 61-01, so they would be classed INVALID_RED by the evidence classifier. After GREEN, a mutation (snake_case limit body) made 10 of 26 tests fail on real assertions, which supplies the missing semantic check.

**Total deviations:** 1 auto-added safety behaviour, 2 notes. **Impact:** none on scope.

## TDD Gate Compliance

- Task 1: RED `7c8ce21` then GREEN `81a3e94`. Task 2: RED `001e0f3` then GREEN `c210aa6`. No REFACTOR commit was needed.
- RED evidence is compile-time failure only (see deviation 3); `gsd_run check tdd-red-evidence` was not run against a record.

## Verification Results

- `npx tsc -p tsconfig.json && node --test dist/test/teamNearOrg.test.js`: 26 tests, 26 pass, 0 fail.
- `node --test dist/test/team*.test.js`: 424 tests, 424 pass, 0 fail (398 before this plan plus 26).
- `npm run lint`: exit 0.
- Acceptance greps: `spendLimit` in nearOrg.ts matches; no `vscode` import; no empty catch in nearOrg.ts or fakeNear.ts; `retry-after` handled in nearOrg.ts; `users/me/access-tokens` and `auth/logout` in fakeNear.ts; no call to `users/me/tokens`; `grep -c "^test("` is 26; no em-dashes; no `any` type.
- No package installs; `package.json` unchanged.

## Known Stubs

None.

## Threat Flags

None. The only new network surface is the client itself, covered by T-61-06 to T-61-10 in the plan. The fake server is test-only and binds 127.0.0.1.

## Open Items For Later Plans

- The live opt-in test (later plan) should confirm: `total_cost` unit on usage history, whether `check_api_key` 402 carries ids, key activation delay, and whether `/models` is gated for a limit-0 key.
- Plan 61-04 (`nearSession.ts`) implements `NearAuth` over the stored refresh token and uses the fake's rotation and logout routes.
- Plan 61-11 must not rely on `listMembers` returning emails (see contract findings).

## Self-Check: PASSED

- Created files exist: `src/team/nearOrg.ts`, `src/test/helpers/fakeNear.ts`, `src/test/teamNearOrg.test.ts`.
- Commits `7c8ce21`, `81a3e94`, `001e0f3`, `c210aa6` are ancestors of HEAD.
