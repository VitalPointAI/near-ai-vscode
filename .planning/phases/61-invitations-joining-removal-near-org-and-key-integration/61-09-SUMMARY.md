---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 09
subsystem: team-core
tags: [join, invite-bundle, seal-key, near-invitation, check-api-key, rollback, tracer]
status: complete

requires:
  - phase: 61-invitations-joining-removal-near-org-and-key-integration
    provides: "61-01 appendJoin and invite proof; 61-03 createSealIdentity and forgetDeviceIdentity; 61-04 saveNearSession and installTeamKey; 61-05 memberAttention; 61-07 parseInviteBundle and inviteMember; 61-02 NearOrgClient, checkApiKey and the fake NEAR server"
provides:
  - src/team/join.ts - prepareJoin, JoinPreparation, joinTeam, JoinInput, JoinResult, NO_ORG_NOTICE
  - src/test/teamJoin.test.ts - 15 tests over two or three real clones and the fake NEAR server
affects: [61-10, 61-11, 61-12, 61-13]

plan_head_before: abbdc1454c45ffecd3faee7a85545ccbc91e7ba6
plan_head_after: 205ea98ef1d8e5ef6df83989df169123ff239697
actuals:
  tokens: 15800
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "the join event is the one write built without a signer: the new device key signs, the code-derived key countersigns, and the body is rebuilt from the freshest state on every lost race"
    - "outcome (role, pendingRole) is read from the materialised state after the write, not from what the builder last saw"
    - "a write whose answer is lost is settled by reading the log for the new device fingerprint; unknown keeps the keys, absent removes them"
    - "NEAR work for a lead invitee runs only after the join is written and can never undo it"

key-files:
  created:
    - src/team/join.ts
    - src/test/teamJoin.test.ts
  modified: []

key-decisions:
  - "JoinResult gains one additive failure code, invalid-name, because a display name that is empty, too long or secret-like had no honest code among the planned ones; nothing is created for it"
  - "A device that already holds a device or seal key answers already-has-key before anything is created and never deletes keys it did not make; the unfinished-join reset (re-issue by the lead, clear the old key) is left to the command adapter, which can use forgetDeviceIdentity"
  - "Rollback removes the device and seal keys only. The NEAR session, the team key profile and the pasted key all come after a successful write, so a failed join has nothing else to undo"
  - "A write that ended offline is settled by reading the log: landed counts as success, absent removes the keys, unknown keeps the keys and says the join may or may not have been saved"
  - "A list of invitations that cannot be read is not proof of none, so the emailed link is still offered, and with no link the NEAR step answers failed (not not-found) with NEAR's scrubbed reason"
  - "prepareJoin also refuses a bundle whose coordination ref differs from the project's team.json, in addition to the planned team id and NEAR link checks"
  - "key stays skipped, with a plain notice, when a pasted key is rejected, empty or malformed; not-applicable in the planned type is not produced by any path"

requirements-completed: []  # TEAM-02 is only partly delivered here (join); confirm, key delivery and removal arrive in later plans, so REQUIREMENTS.md was left unticked

coverage:
  - id: D1
    description: "prepareJoin answers ready for the matching project, clone-needed with the cleaned repo URL otherwise, and refused (never echoing the paste) for a damaged bundle, a conflicting NEAR link or a different coordination branch; nothing is stored between windows"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamJoin.test.js#prepareJoin answers clone-needed ...; #prepareJoin takes the NEAR link from team.json ...; #nothing from the bundle is written on the joining computer ..."
        status: pass
    human_judgment: false
  - id: D2
    description: "A developer joins a NEAR-linked team from a second clone as observer with pendingRole developer, awaiting the lead's key, with zero requests to NEAR and no NEAR session; the lead's client lists the member under confirm and the member's device has its seal key"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamJoin.test.js#tracer: a developer joins a NEAR-linked team from a second clone with no NEAR request, and the lead sees them waiting"
        status: pass
    human_judgment: false
  - id: D3
    description: "A developer, reviewer or observer is never signed in to NEAR at join even when a sign-in and an emailed link are supplied, and is never offered pasting an own key in a NEAR-linked team"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamJoin.test.js#a rejected pasted key or none at all leaves the join done ...; mutation: replacing the lead gate with true fails 2 tests"
        status: pass
    human_judgment: false
  - id: D4
    description: "A lead invitee signs in, accepts only the team organization's invitation (by id, or by the emailed link when the list cannot be read), is treated as accepted when already a member, keeps the per-team session, and gets a plain notice when no invitation matches; a NEAR problem never undoes the join"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamJoin.test.js#a lead joining a NEAR-linked team ...; #a lead whose invitation list cannot be read ...; #a lead who is already an organization member ...; #a lead is never joined to a different organization ...; mutation: dropping the organization filter fails 1 test"
        status: pass
    human_judgment: false
  - id: D5
    description: "In a team with no NEAR organization a pasted key is checked with check_api_key only and installed as the team key profile with NO_ORG_NOTICE; a rejected, empty or missing key leaves the join done with key skipped; the key reaches no log object, notice or stored file"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamJoin.test.js#a team with no NEAR organization checks a pasted key ...; #a rejected pasted key or none at all ..."
        status: pass
    human_judgment: false
  - id: D6
    description: "A join that fails for good (cancelled, used, expired locally or at write time, wrong code, not invited, lost race, bad name) reports the reason in plain language and leaves no device key, seal key, session or profile; a device that already has a key is refused and its key is untouched"
    requirement: TEAM-02
    verification:
      - kind: integration
        ref: "dist/test/teamJoin.test.js#a cancelled, used or unknown invitation ...; #an expired invitation is refused ...; #a cancel that lands while the join is being written ...; #two devices racing with one bundle ...; #a device that already holds a team key ...; mutation: removing the key cleanup fails 3 tests"
        status: pass
    human_judgment: false

duration: ~45min
completed: 2026-11-02
---

# Phase 61 Plan 09: Join Summary

**An invitee pastes the bundle and joins as an observer: prepareJoin decides between ready and clone-needed with nothing kept between windows, joinTeam proves the code, makes the device and seal keys and writes member.joined, developers never touch NEAR, leads accept their organization invitation as admin and keep a per-team session, and teams without an organization take a pasted key with the not-capped notice.**

## Performance

- **Duration:** about 45 min of wall clock
- **Tasks:** 2 (one tracer, one auto), 5 commits
- **Files:** 2 created, 0 modified

## Accomplishments

- `prepareJoin({ projectRoot, bundleText })` parses the bundle (a parser failure becomes `refused` with the parser's fixed sentence, never the paste), reads the open project's `team.json`, and answers `ready` when the team ids match, `clone-needed` with the already cleaned repo URL otherwise (no folder, no `team.json`, or another team). `near` is the file's link, else the bundle's; two different links, or a different coordination ref, are refused.
- `joinTeam` checks the trust pin, refuses a device that already holds a key (touching nothing), syncs read-only with a signer-less `TeamLog`, classifies the invitation (not-invited, cancelled, used), checks that the code derives the recorded key and a local early expiry check, then creates the Ed25519 device key and the X25519 seal key and calls `appendJoin`. The builder re-reads the member from the freshest state on every attempt and signs the proof over team, member, invitation event, device and seal key. The code bytes are zero-filled in a `finally`.
- Role and pending role in the result come from the materialised member after the write, so `requireLeadConfirmation` and the invited role are reflected exactly as the log has them.
- Developer, reviewer and observer in a NEAR-linked team: result `key: 'awaiting-lead'`, a notice that the lead sends the team key, no sign-in, no NEAR request, no session, and `pasteOwnKey` is never called.
- Lead in a NEAR-linked team: `signIn` once; `currentUser` with the access token for the session label; `saveNearSession`; `myInvitations` filtered by the team's organization id; `acceptInvitation`; else already-member through `currentUser().organizationIds`; else the emailed link (address or bare token) through `acceptInvitationToken`; else `not-found` with the notice to sign in with the invited email or ask the lead to invite the NEAR address. Cancelled, absent or failed sign-in and any NEAR error become `skipped` or `failed` with a scrubbed notice and never undo the join.
- Team with no organization: `pasteOwnKey`, trimmed and shape-checked, goes to `installTeamKey` with no `expect` and one attempt; the result carries `NO_ORG_NOTICE` in every case, `installed` on success and `skipped` with a plain message otherwise.
- Failures after key creation (lost race, cancel, expiry at write time, bad name) map to `cancelled`, `used`, `expired`, `wrong-code`, `invalid-name`, `offline` or `conflict`, and remove both new keys.

## Task Commits

1. **Task 1 (tracer): prepareJoin and the developer join** - RED `304f542` (test), GREEN `6d49c6c` (feat)
2. **Task 2: lead acceptance, pasted keys, rollback** - RED `13e115e` (test), GREEN `43a1284` (feat)
3. **Extra pins found by mutation checks** - `205ea98` (test)

Tracer feedback gate (auto mode): after the tracer GREEN the verify command was re-run end to end (`npx tsc -p tsconfig.json && node --test dist/test/teamJoin.test.js`, 4 pass) before Task 2 started. Logged as "Tracer verified end-to-end, expanding".

## Files Created/Modified

- `src/team/join.ts` - join orchestration, vscode-free, no `any`, no empty catch
- `src/test/teamJoin.test.ts` - 15 tests: clone-needed/ready/refused, link agreement, developer tracer, no copy of the bundle on disk, lead acceptance by id and by link, already-member and skipped and failed NEAR steps, wrong-organization invitation, pasted key paths, refusals, expiry, cancel race, two-device race, existing key

## Decisions Made

See `key-decisions`. For a reviewer: the only API addition beyond the plan is the `invalid-name` failure code.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] "used" invitation was reported as not-invited**
- **Found during:** Task 2 RED
- **Issue:** the Task 1 lookup required `member.invite` before reading the status, but a joined member keeps `invitedEvent` and drops the invite record, so a second device saw "not on the team list" instead of "already used".
- **Fix:** read `status` before the invite record (`standingOf`).
- **Files modified:** `src/team/join.ts`
- **Commit:** `43a1284`

**2. [Rule 2 - Missing critical functionality] Input validation and a coordination-ref check**
- **Found during:** Task 1 design
- **Issue:** the plan's `JoinResult` had no code for an unusable display name, and a bundle for a different coordination branch than `team.json` would have been joined silently.
- **Fix:** additive `invalid-name` code (nothing created for it; a secret-like name is also caught from `assertNoSecrets` and cleaned up); `prepareJoin` refuses a ref mismatch.
- **Files modified:** `src/team/join.ts`
- **Commit:** `6d49c6c`, `43a1284`

**3. [Rule 1 - Bug, test only] Emailed-token scenario did not match the NEAR rules**
- **Found during:** Task 2 GREEN
- **Issue:** the first version of the "login email differs" test expected NEAR to accept an emailed token for a different login. The fake (modelled on NEAR) answers 403 for that, so the token only helps when the invitation list cannot be read. The test now uses a list failure for the token path and keeps a different-email login for the not-found notice and the refused token.
- **Files modified:** `src/test/teamJoin.test.ts`
- **Commit:** `43a1284`

**Total deviations:** 3 (one production bug, one additive input check, one test-side). **Impact:** none on scope.

### Design Choices Beyond the Plan Text

- An interrupted join (process stopped between key creation and the write) leaves a device key; the next `joinTeam` answers `already-has-key` with a message asking for a re-issued invitation and clearing of the old key, as planned. Join never deletes a key it did not create in the same call, so the clearing action (a Reset in the command adapter using `forgetDeviceIdentity`, only when the device is not on the roster) belongs to plan 61-13.
- When the write ends offline and the log cannot be read to settle it, the keys are kept (the push may have landed) and the message says so, instead of deleting a key that may be the only one for a joined device.

## TDD Gate Compliance

- **Task 1 RED (`304f542`):** `join.ts` was committed as a signature-only stub so the tests compile and fail on their assertions. `gsd_run check tdd-red-evidence` returned `RED_EVIDENCE_OK` (`target_test_failed`) for the tracer test. Semantic assessment: the four target tests executed and failed because `prepareJoin` answered `refused` and `joinTeam` answered `not implemented`, which is exactly the planned behaviour that was missing; no setup, import or fixture fault. GREEN `6d49c6c` followed.
- **Task 2 RED (`13e115e`):** 9 of 14 tests failed on assertions for the planned behaviour (no NEAR step, no key install, keys left behind, wrong code for a used invitation). The 5 that passed were Task 1 tests plus the already-has-key test, which Task 1 delivered. GREEN `43a1284` followed; the final test commit `205ea98` adds two regression pins.
- No REFACTOR commit was needed.
- Mutation checks on the compiled output (proving the tests can fail): replacing the lead gate with `true` fails 2 tests; removing the organization filter fails 1; removing the key cleanup after a failed write fails 3.

## Verification Results

- `npm run lint`: exit 0.
- `npx tsc -p tsconfig.json && node --test dist/test/teamJoin.test.js dist/test/teamInviteFlow.test.js dist/test/teamInvite.test.js`: 48 pass, 0 fail.
- `node --test dist/test/team*.test.js dist/test/nearSignIn.test.js` (run before the last test additions): 537 pass, 0 fail.
- Acceptance greps: `appendJoin(`, `createSealIdentity(` and `acceptInvitationToken(` match in `join.ts`; `NO_ORG_NOTICE` text is exact; no `vscode` import; no em-dash in either file; `grep -c "^test(" src/test/teamJoin.test.ts` is 15.
- The full repository suite was not run: this plan adds one new module and one new test file and changes nothing else; the full suite belongs to the phase boundary.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. T-61-35 (developers never sign in; test asserts zero sign-in calls and zero NEAR requests), T-61-36 (team id, ref and link agreement checked, trust pin before any write), T-61-37 (rollback tests per failure kind), T-61-38 (no file or secret on the joining computer holds the code or bundle) and T-61-39 (invitations filtered by the team's organization, tested with a second organization) are covered by tests.

## Open Items For Later Plans

- 61-13 (commands): call `prepareJoin` after every paste, offer Git: Clone on `clone-needed` and ask for the bundle again afterwards (D-26); pass `signIn`, `askInvitationLink` and `pasteOwnKey` only for the cases that use them; show `notices` as they are; offer an unfinished-join reset on `already-has-key` (remove both keys with `forgetDeviceIdentity` only when the log shows the device is not on the roster) and restart the team session after a successful join.
- After a successful join the display name is the member's own, so the roster may show a different name than the lead typed into the invitation.
- `key: 'not-applicable'` exists in the planned type but no path returns it.

## Self-Check: PASSED

- Files found: `src/team/join.ts`, `src/test/teamJoin.test.ts`
- Commits `304f542`, `6d49c6c`, `13e115e`, `43a1284`, `205ea98`: present in history
