---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 04
subsystem: near-integration
tags: [near-ai-cloud, session, refresh-rotation, secret-storage, profile-store, sign-in, code-server]

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: plan 02 NearAuth, NearOrgClient, checkApiKey and the fake NEAR server
provides:
  - src/team/nearSession.ts, a kept per-team NEAR session (refresh token in SecretStorage, access token in memory) with single-flight refresh rotation and sign out
  - src/team/teamKeyProfile.ts, install, inspect and remove a team API key as the project-scoped profile profile-team-<10 hex>, with the member's own profile remembered and restorable
  - src/services/nearSignIn.ts, the browser sign-in with the code-server paste fallback shared by the reporting token flow and Team Mode, with configurable wording
affects: [61-05, 61-06, 61-07, 61-08, 61-11]

plan_head_before: aca6fecee71a2b448eff8810c9deefe1f0654732
plan_head_after: 8f7b375931b3516ce38aba484c7b4be5e6ab21dc
actuals:
  tokens: 14000
  tasks: 3
  commits: 6

tech-stack:
  added: []
  patterns:
    - "refresh rotation: persist the new single-use token before handing out the new access token; one in-flight refresh per instance; re-read the stored token (after a short wait) before believing a refusal"
    - "validate a credential against the real server before touching any stored profile, so a bad re-delivery leaves the working key in place"
    - "ProfileStore validator that awaits a memoised check of the very key being installed"

key-files:
  created:
    - src/team/nearSession.ts
    - src/team/teamKeyProfile.ts
    - src/services/nearSignIn.ts
    - src/test/teamNearSession.test.ts
    - src/test/teamKeyProfile.test.ts
    - src/test/nearSignIn.test.ts
  modified:
    - src/domain/auth.ts
    - src/services/spendTracking.ts

key-decisions:
  - "A refused refresh that finds the stored token unchanged waits 300 ms and reads once more before reporting expired, because the winning window stores its new token only after NEAR answers it"
  - "installTeamKey verifies the key with check_api_key (retrying invalid and unavailable) before it creates or updates any profile, so a failed re-delivery never overwrites the working key; the ProfileStore validator awaits that same memoised check"
  - "removeTeamKey restores the remembered profile only when the team profile is still the active one; a profile the member chose afterwards is left selected"
  - "With expect set, a capped (402) key whose body carries no ids is refused as wrong-organization, matching the 61-02 decision that missing ids never match"
  - "signOut with no kept session reports serverConfirmed true (nothing was left to end)"

requirements-completed: []  # TEAM-02 is only partly delivered here (device-side session and key profile); later plans finish it, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "A lead's NEAR session is kept per team (only {v:1, refreshToken, label} stored; access token memory only), refreshed through the fake's rotation with the new refresh token stored first, and signed out via POST /auth/logout, leaving other teams alone"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearSession.test.js#tracer: a session is kept per team, refreshed through rotation and signed out"
        status: pass
    human_judgment: false
  - id: D2
    description: "Concurrent refresh is safe: callers in one window share a refresh, two windows racing both end working with the newest token stored, an unrotated refusal says the sign-in expired, an outage is unavailable, damaged values are signed out, sign out works offline, and no token appears in errors"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamNearSession.test.js (callers share a single refresh; two windows refreshing; refresh token NEAR refuses; NEAR outage; damaged stored value; sign out offline; plain-HTTP refusal)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A team key installs as the project's active profile profile-team-<10 hex> after NEAR's activation delay, org and workspace are checked when NEAR-linked, a capped key is accepted, a bad key changes nothing, and the key buffer is wiped"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamKeyProfile.test.js (installs as the active profile after NEAR activates it; other organization or workspace; revoked key; spend limit; unreachable NEAR; safe display label)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The member's previous profile is remembered once in join.json, restored on removal when the team profile is still active, and never deleted; the team profile, its scoped key, join.json and key.json are removed"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamKeyProfile.test.js (first remembered personal profile is not overwritten; removing restores the personal profile; does not override a later choice; personal profile gone)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The browser sign-in with the code-server paste fallback lives in one module; the reporting flow keeps its exact wording and the team flow says the sign-in is kept until NEAR AI: Sign Out of NEAR (Team)"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/nearSignIn.test.js and dist/test/reportingTokenEntry.test.js, reportingSignIn.test.js unchanged"
        status: pass
    human_judgment: false
  - id: D6
    description: "The live browser sign-in in a real VS Code window (and the code-server paste box on screen) behaves as before"
    requirement: TEAM-02
    verification: []
    human_judgment: true
    rationale: "The logic moved unchanged and the paste box wording is asserted against a stub, but nothing here drives a real window or browser; the e2e suite was not run for this plan."

duration: ~15min
completed: 2026-11-02
status: complete
---

# Phase 61 Plan 04: Lead session, team key profile and shared sign-in Summary

**A lead's NEAR sign-in is kept per team and renewed through single-use refresh tokens without losing the session when two windows race; a member's team key installs as the project's active profile after NEAR's activation delay and the personal profile comes back on removal; and the browser sign-in with the code-server paste fallback is now one module used by both the reporting token and Team Mode.**

## Performance

- **Duration:** about 15 min (start time was not recorded at launch; estimated from commit times)
- **Completed:** 2026-11-02T01:18Z
- **Tasks:** 3 (a tracer and two more), 6 commits
- **Files:** 6 created, 2 modified

## Accomplishments

- `NearSession` (implements `NearAuth`): stores only `{v:1, refreshToken, label}` under `nearAi.team.nearSession.<teamId>`, keeps the access token in memory for 50 minutes, refreshes through `POST /users/me/access-tokens`, and stores the rotated refresh token before the new access token is used. Concurrent callers in one window share one refresh. A refused refresh re-reads the stored token (after a 300 ms wait if unchanged) and retries once with a newer value another window stored; otherwise it throws `expired` with the fixed text "Your NEAR sign-in for this team expired. Sign in again." and deletes nothing. `signOut` waits for any in-flight refresh, calls `POST /auth/logout` with the stored token, and deletes the secret in a `finally`. `DELETE /users/me/tokens` is never called. A damaged stored value is treated as signed out and deleted. A plain-HTTP non-loopback address is refused with `RangeError`.
- Racing windows: two `NearSession` instances over one SecretStorage refresh at once; both end with a usable session through the client's 401 recovery, and a third window opened from the stored token refreshes with a 200. Mutating the retry-with-newer-token branch off made this test fail.
- `installTeamKey`: validates the key with `checkApiKey` first (invalid and unavailable answers retried, default 6 tries 2 s apart, `valid` and `capped` both accepted), checks organization then workspace when `expect` is set and the key id when `keyId` is given, and only then configures the profile `profile-team-<10 hex of sha256(teamId)>` through `ProfileStore` and selects it. The previous active profile is written once to `<storage>/join.json`; `key.json` holds the key id. The key `Buffer` is zero-filled on every path. The display name is the cleaned team name (control characters and words `ProfileStore` refuses removed, 40 characters) plus " (team key)".
- `removeTeamKey`: selects the remembered profile again only when the team profile is still active and the earlier profile still exists, removes the team profile and its scoped secret, deletes `join.json` and `key.json`, and never touches the earlier profile.
- `src/services/nearSignIn.ts`: `browserSignIn`, the paste box and its check moved out of `spendTracking.ts` with identical logic and a `SignInCopy` parameter. `REPORTING_SIGN_IN_COPY` holds today's strings byte for byte; `TEAM_SIGN_IN_COPY` ends with the "kept until NEAR AI: Sign Out of NEAR (Team)" note. `spendTracking.ts` imports it; no team logic went into it. `TEAM_PROFILE_PREFIX` added to `src/domain/auth.ts`.

## Task Commits

1. **Task 1 (tracer): per-team session, rotation, sign out** - RED `c6c3265` (test), GREEN `d499308` (feat)
2. **Task 2: racing refreshes, expiry, team key profile** - session hardening + tests `7aca983` (feat), RED `54670c9` (test), GREEN `e232839` (feat)
3. **Task 3: shared browser sign-in** - `8f7b375` (refactor)

Tracer feedback gate (auto mode): the end-to-end verify was re-run and passed; logged as "Tracer verified end-to-end - expanding".

## Files Created/Modified

- `src/team/nearSession.ts` - kept per-team session with single-flight rotation
- `src/team/teamKeyProfile.ts` - install, read and remove the project-scoped team key profile
- `src/services/nearSignIn.ts` - shared browser sign-in, paste fallback, configurable copy
- `src/services/spendTracking.ts` - private sign-in helpers removed; imports the shared module (reporting flow unchanged)
- `src/domain/auth.ts` - `TEAM_PROFILE_PREFIX`
- `src/test/teamNearSession.test.ts` (8 tests), `src/test/teamKeyProfile.test.ts` (11 tests), `src/test/nearSignIn.test.ts` (3 tests)

## Decisions Made

See `key-decisions` in the frontmatter. The two most consequential: a key is verified against NEAR before any profile or stored key is changed (so a bad re-delivery cannot replace a working key), and a refused refresh waits and re-reads once before reporting expiry (so the window that lost a race does not tell the lead to sign in again).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Refusal re-read could happen before the winning window stored its token**
- **Found during:** Task 2 (designing the racing test)
- **Issue:** The plan re-reads the stored token once on a 401 and calls it expired if unchanged. The winner stores its rotated token only after NEAR answers, so a loser in another process can re-read too early and wrongly report expiry.
- **Fix:** When the re-read value is unchanged, wait 300 ms (injectable `sleep`) and read once more before believing the refusal.
- **Files modified:** src/team/nearSession.ts
- **Commit:** 7aca983

**2. [Rule 1 - Bug] A failed re-install would have replaced the working key**
- **Found during:** Task 2 (designing `installTeamKey`)
- **Issue:** `ProfileStore.configure` stores the new key before it validates, so a bad key delivered a second time would overwrite a good one.
- **Fix:** `installTeamKey` verifies the key with `check_api_key` first and only then calls `configure`; the `ProfileStore` validator awaits that same memoised check. Tested with a revoked second key.
- **Files modified:** src/team/teamKeyProfile.ts
- **Commit:** e232839

### Plan interface additions (additive)

- `saveNearSession` takes a fifth argument `{ baseUrl, fetch?, now?, sleep? }`; the plan's four-argument form cannot build a `NearSession`, which needs the address.
- `NearSessionOptions` gained `sleep`; `InstallTeamKeyInput` is exported as a named type.
- `installTeamKey` also compares `keyId` with the id `check_api_key` reports (when both are known) and answers `invalid` on a mismatch.
- Added `src/test/nearSignIn.test.ts` (not in the plan's file list) to pin the reporting wording and the paste check.

### Notes

- **TDD RED evidence:** both RED commits use an interface stub that throws "not implemented", so the target tests fail at runtime on the call, not at compile time (better than 61-01 and 61-02). The failures are a stub throw rather than a planned assertion, so `gsd_run check tdd-red-evidence` was not run against a record. The Task 2 session tests were added after the implementation worked (the plan expected them to pass); the one real gap they found (deviation 1) was fixed with a mutation check showing the race test fails without the fix.
- **Acceptance grep for the credentials directory name:** the pre-tool safety hook blocks any shell command containing that path text, so the "no reference in code lines" check was not run as a grep. Neither source file contains it; nothing in this plan reads or writes that directory.

**Total deviations:** 2 auto-fixed bugs, 4 additive interface changes, 2 notes. **Impact:** none on scope.

## TDD Gate Compliance

- Task 1: RED `c6c3265` then GREEN `d499308`. Task 2: RED `54670c9` then GREEN `e232839`. Task 3 is `type="auto"` without TDD. No REFACTOR commit was needed.

## Verification Results

- `npx tsc -p tsconfig.json && node --test dist/test/teamNearSession.test.js dist/test/teamKeyProfile.test.js dist/test/reportingTokenEntry.test.js dist/test/reportingSignIn.test.js dist/test/profileStore.test.js dist/test/nearSignIn.test.js`: 48 tests, 48 pass, 0 fail.
- `npm run lint`: exit 0.
- `node --test dist/test/*.test.js` (whole suite, run once at the end because `spendTracking.ts` and `auth.ts` are shared with 0.4.x): 1037 tests, 1029 pass, 0 fail, 8 skipped (pre-existing skips).
- `reportingTokenEntry.test.ts`, `reportingSignIn.test.ts` and `profileStore.test.ts` are unchanged (`git diff` empty); `package.json` unchanged.
- Acceptance greps: `nearAi.team.nearSession.` and `users/me/access-tokens` match in nearSession.ts; no `users/me/tokens'`; no `vscode` import in nearSession.ts or teamKeyProfile.ts; `TEAM_PROFILE_PREFIX` in domain/auth.ts; `checkApiKey(` and `join.json` in teamKeyProfile.ts; `browserSignIn`/`pasteSignInAddress` gone from spendTracking.ts; `REPORTING_SIGN_IN_COPY` used there; both wording strings in nearSignIn.ts; no em-dashes or `any` in the new files.
- The e2e and `verify:release` suites were not run (phase boundary work).

## Known Stubs

None.

## Threat Flags

None. The new surface is the refresh and logout calls to NEAR (T-61-15 to T-61-17 in the plan) and local files holding ids only (T-61-19). Tokens appear only in SecretStorage and as a Bearer header; tests assert they are absent from thrown errors and stacks.

## Open Items For Later Plans

- Wiring: a command to sign in as the lead (using `browserSignIn` with `TEAM_SIGN_IN_COPY` then `saveNearSession`) and the "NEAR AI: Sign Out of NEAR (Team)" command are not registered here; the copy already names that command.
- The live opt-in test should confirm that NEAR keeps an older access token valid after a refresh (the fake invalidates it, which the client recovers from) and the real activation delay against the six-try default.
- Concurrent windows in different processes cannot share the in-memory single-flight; the stored-token re-read is the only coordination between them.

## Self-Check: PASSED

- Created files exist: `src/team/nearSession.ts`, `src/team/teamKeyProfile.ts`, `src/services/nearSignIn.ts`, `src/test/teamNearSession.test.ts`, `src/test/teamKeyProfile.test.ts`, `src/test/nearSignIn.test.ts`.
- Commits `c6c3265`, `d499308`, `7aca983`, `54670c9`, `e232839`, `8f7b375` are ancestors of HEAD.
