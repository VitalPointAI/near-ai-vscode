---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 07
subsystem: team-core
tags: [invite, bundle, repo-url, near-org, cleanup-checklist, re-issue]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-01 invite code and member.invited; 61-02 NearOrgClient.inviteByEmail and listInvitations and the fake NEAR server; 61-04 NEAR session"
provides:
  - src/team/inviteBundle.ts - near-ai-invite-v1 bundle encode, strict parse, credential-free repo URL cleaning, frozen vector
  - src/team/invite.ts - inviteMember, reissueInvite, readInviteDirectory, recordInvite and the lead's local invites.json
  - src/team/cleanupChecklist.ts - persisted local NEAR cleanup checklist (all eight step kinds) and the repository-access reminder
affects: [61-08, 61-09, 61-10, 61-11, 61-12]

plan_head_before: 3561f3537e47ef56398ed9166c83fd839fedf582
plan_head_after: 72580ec48b6dfe90fb93ac247bef6c9c941829ec
actuals:
  tokens: 22470
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "one internal issue() shared by invite and re-issue; the plan is decided inside the append builder so it is re-read from the freshest state after a lost race"
    - "a secret-shaped value is never a literal in a test: canaries and codes are built at run time"
    - "mutation checks on the compiled output to prove the new tests can fail"

key-files:
  created:
    - src/team/inviteBundle.ts
    - src/team/invite.ts
    - src/team/cleanupChecklist.ts
    - src/test/teamInviteBundle.test.ts
    - src/test/teamInviteFlow.test.ts
  modified: []

key-decisions:
  - "The bundle's code is the canonical 32-character Crockford text (strict: upper case, no groups); the parser refuses anything else so one bundle has one spelling"
  - "encodeInviteBundle parses what it just built, so a lead can never copy a bundle that no client would accept (too large, a URL that cleaning would change)"
  - "Re-issue requires the same email as the original invitation (compared by hash inside the append builder) and takes name, role and allocation from the old invited member; only the lifetime is new"
  - "A re-issue of a lead whose NEAR invitation is still pending (case-insensitive email match in listInvitations) returns nearInvitation sent with a notice and sends nothing; if listing fails the step is queued like any other NEAR failure"
  - "A failure to save invites.json after the log write does not fail the invite: the bundle is returned with a notice, because the log already holds the invitation"
  - "cleanup.json lastError goes through scrubNearText and the team secret detectors, so it is redacted even for shapes the shared redactSecrets misses (sk-, rt_)"
  - "A damaged cleanup.json is reported and left untouched, never replaced"

requirements-completed: []  # TEAM-02 is only partly delivered here (the lead's invite side); later plans finish join and confirm, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "inviteMember appends member.invited over real git and returns one near-ai-invite-v1 bundle whose code derives the public key recorded in the log and joins from a second clone"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInviteFlow.test.js#tracer: a lead invites a developer over real git and gets a bundle whose code matches the log"
        status: pass
    human_judgment: false
  - id: D2
    description: "The repo URL is read raw from git config (not expanded by insteadOf), stripped of userinfo and passwords, and refused (reason never holds the URL) for a query, fragment, local path, file URL or anything the secret detectors flag"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInviteFlow.test.js#credentials in the configured remote URL never reach the bundle, the log or the failure text; #a remote that cannot be shared refuses the invite"
        status: pass
      - kind: unit
        ref: "dist/test/teamInviteBundle.test.js#cleanRepoUrl (four tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The bundle parser accepts only the exact prefix, strict base64url, at most 4 KB and valid team, member, ref, code and NEAR link; unknown keys are ignored; a __proto__ key changes nothing; no error repeats the input; the v1 spelling is pinned by frozen vectors"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamInviteBundle.test.js#frozen v1 vector; #hostile bundles are refused; #an unknown key is ignored; #no refusal message repeats the pasted text; #size cap"
        status: pass
    human_judgment: false
  - id: D4
    description: "The clear-text code is in no file inviteMember wrote, in no coordination object (remote or local mirror), and its bytes are zero-filled after the bundle is built and on a refused invite"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInviteFlow.test.js#the clear-text code is in no file the invite wrote and in no object on the coordination remote; #the code bytes are zero-filled"
        status: pass
    human_judgment: false
  - id: D5
    description: "In a NEAR-linked team a lead invitation sends exactly one admin invitation by email; developer, reviewer and observer invitations and a lead in an unlinked team make no NEAR request; a NEAR failure or a missing session queues a send-invitation item and never blocks the team invite"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInviteFlow.test.js#a lead invitation in a NEAR-linked team ...; #developer, reviewer and observer invitations never call NEAR; #a NEAR failure never blocks the team invite"
        status: pass
    human_judgment: false
  - id: D6
    description: "Re-issue is one coordination commit (member.removed old, member.invited new with a new id and code), carries role and allocation over, refuses a non-pending invitation or a different email, and keeps a still-pending NEAR invitation"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamInviteFlow.test.js#re-issue is one commit; #re-issue refuses ...; #re-issuing a lead keeps a NEAR invitation that is still pending"
        status: pass
    human_judgment: false
  - id: D7
    description: "The cleanup checklist defines all eight step kinds, assigns ids and times, counts attempts, keeps insertion order, redacts and bounds errors, refuses a secret in any field, survives concurrent writers, and reports a damaged file instead of replacing it"
    requirement: TEAM-02
    verification:
      - kind: unit
        ref: "dist/test/teamInviteFlow.test.js (five checklist tests and recordInvite test)"
        status: pass
    human_judgment: false

duration: ~10min
completed: 2026-11-02
---

# Phase 61 Plan 07: Lead invite, bundle and cleanup checklist Summary

**A lead invites by email in one call and gets a single pasteable `near-ai-invite-v1` bundle with a credential-free repo URL and a code that is never stored; a lead invitee also gets a NEAR admin invitation, any NEAR failure goes on a local retry checklist, and re-issue replaces an invitation in one commit.**

## Performance

- **Duration:** about 10 min of wall clock (start 2026-11-02T01:37Z, end 01:47Z); the plan frontmatter field below uses the same estimate
- **Completed:** 2026-11-02T01:47Z
- **Tasks:** 3 (one tracer, two auto), 5 commits
- **Files:** 5 created, 0 modified

## Accomplishments

- `inviteBundle.ts`: encode and strict parse of `near-ai-invite-v1.<base64url of canonical JSON>`. The parser takes the exact prefix, at most 4 KB, strict base64url with a decode and encode round trip, valid UTF-8 JSON object, `v === 1`, team, member and ref patterns, a 32-character Crockford code and the repo through `cleanRepoUrl` (refused if cleaning would change it). Unknown keys are ignored; the result is a fresh object so a `__proto__` key changes nothing. Every failure is one of five fixed sentences that never echo the input. A newer prefix or `v` gets a distinct "update the extension" sentence.
- `cleanRepoUrl`: https drops userinfo and refuses query or fragment; ssh drops the password and keeps a lowercase login name; scp-style keeps a plain user and refuses `user:pw@host:path`; file URLs, local paths, Windows drives, other schemes and empty text are refused; the result must pass `findSecrets`. Reasons are fixed text and never contain the URL. A cleaned URL is a fixed point.
- `inviteMember`: validates input, reads the URL with `git config --get remote.<name>.url` (not `get-url`, which applies the user's `insteadOf` rewrites; the tracer proves the bundle carries the configured public URL while git reaches the local bare remote through a rewrite), generates the code, derives the key, appends `member.invited`, records `invites.json`, builds the bundle and zero-fills the code bytes in a `finally`. Append failures map to `refused`, `conflict` (also `busy`) or `offline`.
- Lead invitees in a NEAR-linked team get `inviteByEmail(org, email, 'admin')` after the log write; every other role never reaches NEAR. A NEAR error, a refusal from NEAR or a missing client becomes a `send-invitation` checklist item (failed or pending) and a plain notice; the team invite still succeeds.
- `reissueInvite`: one batch `[member.removed old, member.invited new]`, one coordination commit; name, role and allocation come from the old invited member inside the append builder (fresh state per attempt); same-email check by hash; a pending NEAR invitation for a lead is kept.
- `CleanupChecklist`: `{version: 1, items}` in `cleanup.json` under `runSerialised` with a fresh read inside the section, atomic write, `assertNoSecrets` on the whole file, `lastError` scrubbed and bounded to 300 characters, strict item validation on read.

## Task Commits

1. **Task 1 (tracer): invite over real git** - RED `397362c` (test), GREEN `89049c4` (feat)
2. **Task 2: parser hardening, URL matrix, frozen vector** - `d85728c` (test only, see TDD notes)
3. **Task 3: lead NEAR invitation, re-issue, checklist** - RED `1e5502e` (test), GREEN `72580ec` (feat)

Tracer feedback gate (auto mode): the end-to-end verify command was re-run after the tracer GREEN and passed; logged as "Tracer verified end-to-end, expanding".

## Files Created/Modified

- `src/team/inviteBundle.ts` - bundle format, parser, URL cleaner
- `src/team/invite.ts` - invite, re-issue, local invite list
- `src/team/cleanupChecklist.ts` - persisted NEAR cleanup checklist
- `src/test/teamInviteBundle.test.ts` - 9 tests (frozen vectors, hostile input, URL matrix)
- `src/test/teamInviteFlow.test.ts` - 18 tests (real git, code at rest, NEAR roles, re-issue, checklist)

## Decisions Made

See `key-decisions` above. The two worth a second look by a reviewer: re-issue is bound to the original email (a corrected address means cancel and invite again), and a failed `invites.json` write does not fail an invite whose event is already in the log.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug, test only] Live state object read after the join**
- **Found during:** Task 1 GREEN
- **Issue:** the tracer read `pending.invite.eventId` after the join, but the materialiser state object is live and the join deletes `invite`, so the read threw.
- **Fix:** read the event id before the join. No production change.
- **Files modified:** `src/test/teamInviteFlow.test.ts`
- **Commit:** `89049c4`

**2. [Rule 1 - Bug] Two test gaps found by mutation checks**
- **Found during:** Task 2
- **Issue:** with the base64url round-trip check removed and with the scp user pattern removed, all tests still passed (the "non-canonical tail" case was also invalid JSON; no scp user case with odd characters).
- **Fix:** added a true same-bytes-different-spelling case and two odd scp users (`we!rd@`, `-oProxyCommand@`). Both mutations now fail a test.
- **Commit:** `d85728c`

**3. [Plan note] Code-byte zero-fill test added**
- The plan states the zero-fill as a truth but lists no test for it. A test wraps `generateInviteCode`, captures the buffer and asserts it is all zero after a successful and after a refused invite. Removing the `fill` call fails it.
- **Commit:** `72580ec`

**Total deviations:** 2 test-side fixes, 1 added test. **Impact:** none on scope; no production behaviour changed from the plan.

## TDD Gate Compliance

- **Task 1 RED (`397362c`):** the new test file fails to compile because `invite.ts` and `inviteBundle.ts` do not exist. That is a build/load failure, not an assertion failure, so a strict classifier would call it INVALID_RED; it is unavoidable for brand-new TypeScript modules without a stub commit (same as plan 61-01). GREEN `89049c4` followed.
- **Task 2:** test-only commit. `inviteBundle.ts` was written in full in Task 1 (the plan's Task 1 action already specifies the whole parser and cleaner), so the Task 2 tests passed on first run: an unexpected GREEN. Investigated by mutation on the compiled output: removing the secret check, the URL round-trip check, the code-shape check, the ssh user check, the base64url round trip or the scp user check each made at least one test fail once the two gaps in Deviation 2 were closed. The tests are regression and format gates, not a red-green pair.
- **Task 3 RED (`1e5502e`):** compile failure again (missing `cleanupChecklist.ts` and `reissueInvite`). GREEN `72580ec`. Mutation checks after GREEN: sending NEAR for every role, dropping the re-issue pending check, and sending role `member` each fail a test; removing the zero-fill fails the zero-fill test.
- No REFACTOR commit was needed.

## Verification Results

- `npm run lint`: exit 0.
- `npx tsc -p tsconfig.json && node --test dist/test/teamInviteFlow.test.js dist/test/teamInviteBundle.test.js dist/test/teamInvite.test.js`: all pass (27 in the two new files plus 15 in teamInvite).
- `node --test dist/test/team*.test.js`: 510 tests pass, 0 fail (baseline before the plan: 483).
- `node --test dist/test/testIntegrity.test.js dist/test/security.test.js dist/test/privacy.test.js`: 12 pass.
- Acceptance greps: `near-ai-invite-v1.` in `inviteBundle.ts`; `'config', '--get'` in `invite.ts` and no `'get-url'`; no `vscode` import in `inviteBundle.ts` or `invite.ts`; `inviteByEmail(` appears once in `invite.ts`; `'send-invitation'` and `'repo-access'` in `cleanupChecklist.ts`; `grep -c "^test(" src/test/teamInviteBundle.test.ts` is 9 (at least 6); `frozen` appears in the bundle test.
- The full repository suite was not run: this plan adds new files only and touches no shared module, and the full suite belongs to the phase boundary.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-61-27 (URL cleaning, canary URL test, URL never logged), T-61-28 (code at rest: invites.json, cleanup.json, remote and mirror objects scanned, bytes zero-filled), T-61-29 (hostile bundle input) and T-61-31 (no NEAR request for non-leads) are covered by tests. T-61-30 is accepted as planned: cancelling an unconfirmed lead invitee's NEAR invitation arrives with 61-11 (the `cancel-invitation` step kind already exists in the checklist).

## Open Items For Later Plans

- 61-08 (join) can call `parseInviteBundle` and use `bundle.near`, `bundle.repo` and `bundle.member` directly; `INVITE_FILE` entries carry the email a retry of a `send-invitation` item needs (`readInviteDirectory`), because the checklist deliberately stores no email.
- 61-10 and 61-11 use `CleanupChecklist.add/update/forMember` and `repoAccessText(name)`; `REPO_ACCESS_TEXT` keeps a `<name>` placeholder.
- The commands plan must show `result.notice` and, for `nearInvitation: 'queued'`, point at the checklist.

## Self-Check: PASSED

- Files found: `src/team/inviteBundle.ts`, `src/team/invite.ts`, `src/team/cleanupChecklist.ts`, `src/test/teamInviteBundle.test.ts`, `src/test/teamInviteFlow.test.ts`
- Commits `397362c`, `89049c4`, `d85728c`, `1e5502e`, `72580ec`: present in history
