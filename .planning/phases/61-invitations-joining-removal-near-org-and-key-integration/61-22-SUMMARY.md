---
phase: 61-invitations-joining-removal-near-org-and-key-integration
plan: 22
subsystem: team-e2e-and-phase-gate
tags: [gap-closure, e2e, vscode-test-electron, real-window, G-61-1, G-61-2, G-61-3, G-61-4, G-61-5, G-61-6, phase-gate]
status: complete

requires:
  - phase: 61-15 to 61-21, 61-23, 61-24
    provides: "teamSectionTap probe and facts, promptTap script and records, Share Team Setup, the invite modal with Copy invite, Join catching up a behind copy, plain words"
provides:
  - "Real-window e2e of the whole invite: turn on, share, invite (shown once, copied), join from a behind copy, confirm, driven only by sidebar buttons"
  - "A green fix-pass gate: lint, full npm test, e2e, verify:release, invariants"
  - "Per-Task Verification Map rows for 61-15 to 61-24"
affects: [61-UAT owner repeat, 61 verify-work, 62 fix pass]

plan_head_before: e89e706e752e9d88a4f881f5ac593d6e2034aef2
plan_head_after: 2fb062542258c09a52630fc28f67b7695f03fb4d
actuals:
  tokens: 11268
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Two VS Code windows open at once in one e2e run (Promise.allSettled over runTests), handing a test secret over through a file written whole then renamed"
    - "A test-only url.<bare>.insteadOf rule on a public-looking https address, so production address checks run unchanged"
    - "Sidebar-driven e2e: teamSectionTap.probe clicks drawn buttons, promptTap.script answers every prompt, promptTap.shown is scanned with the plain-words pattern"

key-files:
  created: []
  modified:
    - src/test/e2e/run.ts
    - src/test/e2e/suite.ts
    - src/test/teamGsdImport.test.ts
    - src/test/teamImport.test.ts
    - .planning/phases/61-invitations-joining-removal-near-org-and-key-integration/61-VALIDATION.md

key-decisions:
  - "The lead's steps (team-lead, then team-confirm) run in one window while the invitee's window runs at the same time: VS Code keeps ALL storage, SecretStorage included, in memory whenever extension tests run (getStorageOptions: useInMemoryStorage = !!extensionTestsLocationURI), so a separate confirm launch can never find the lead's device key on any host. No key is exported."
  - "The lead shares with the sidebar Share button before inviting, because the Team section (61-17) shows Invite someone only once the setup is online; the invite's own Share and continue path stays covered by teamInviteShare.test.ts"
  - "The self-import tests read which plans are finished from the SUMMARYs committed at HEAD instead of assuming Phase 61 has exactly 14 finished plans"

patterns-established:
  - "Cross-window e2e step: bounded wait of 180 s for the other window, 20 s for a window's own steps"

requirements-completed: [TEAM-01, TEAM-02, TEAM-03]

coverage:
  - id: D1
    description: "In a real window the lead turns on Team Mode from the sidebar Team section (Share then comes first, Invite someone waits), shares with one confirmation so main online holds team.json, and invites: the invite is shown once with Copy invite, copied, and the section counts one unused invite"
    requirement: TEAM-01
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-lead] (5 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "In a second real window on a copy made before Team Mode was on, Join a team with the pasted invite brings the copy up to date by itself and joins as an observer waiting for a lead; the paste is recorded hidden and the section shows the waiting state"
    requirement: TEAM-02
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-join] (5 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "In the lead's window Members shows 1 waiting; confirming E2E Joiner from Members makes them a developer on the team record and the badge goes away"
    requirement: TEAM-02
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#[team-confirm] (3 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every prompt the windows showed was answered and has no git word and no 'NEAR organization'; the invite text is left nowhere on disk"
    requirement: TEAM-02
    verification:
      - kind: e2e
        ref: "src/test/e2e/suite.ts#every prompt ... spoke plain words (3 tests); run.ts finally removes the handoff folder"
        status: pass
    human_judgment: false
  - id: D5
    description: "Fix-pass gate: npm run check, e2e, verify:release, no vscode import in the team core, event/bundle/crypto modules unchanged since a7fcba5, no new dependency"
    requirement: TEAM-03
    verification:
      - kind: other
        ref: "npm run check (1765 tests, 1755 pass, 0 fail, 10 skipped)"
        status: pass
      - kind: e2e
        ref: "npm run compile && xvfb-run -a node dist/test/e2e/run.js (30 tests)"
        status: pass
      - kind: other
        ref: "npm run verify:release (268 entries)"
        status: pass
      - kind: other
        ref: "! grep -rlE vscode src/team src/domain/team && git diff --quiet a7fcba5 -- <12 core files>"
        status: pass
    human_judgment: false
  - id: D6
    description: "The owner repeats 61-UAT tests 1 to 6 in code-server on the scratch project with the sidebar flow"
    verification: []
    human_judgment: true
    rationale: "Pending owner review: hands-on check in code-server with real clones (alice, bob) and the owner's own judgement of whether the flow is understandable; recorded, not performed, in auto mode"

duration: 17min
completed: 2026-11-03
---

# Phase 61 Plan 22: Real-window e2e of the invite flow and the fix-pass gate Summary

**Two real VS Code windows prove the whole invite from sidebar buttons only (turn on, share, invite shown once and copied, join from a behind copy, confirm), with a local bare online home behind a test-only insteadOf rule, and the full fix-pass gate is green.**

## Performance

- **Duration:** about 17 min
- **Started:** 2026-11-03T23:38:35Z
- **Completed:** 2026-11-03T23:56Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- `run.ts` prepares a bare online home, the lead's project (origin `https://example.invalid/e2e-team.git`, mapped to the bare folder only by `url.<bare>.insteadOf` in the test repositories) and the invitee's copy cloned from the same public address before Team Mode, and a handoff folder removed in a `finally`.
- The lead's window (`team-lead`, then `team-confirm`) and the invitee's window (`team-join`) run at the same time. Everything is clicked through `teamSectionTap.probe`, every prompt answered by `promptTap.script` and checked in `promptTap.shown`.
- team-lead: Turn on Team Mode, then Share (one confirmation; `main` on the online home holds the lead's team.json), then Invite someone. The invite is shown once, in the one modal, with only Copy invite. The clipboard holds it and the section says "1 invite is not used yet".
- team-join: the copy is behind once the lead shares. Join a team brings it up to date by itself ("Your copy of the project was brought up to date."). The invitee joins as an observer waiting to be a developer, the paste is recorded as `hidden`, and the invite text is in no record.
- team-confirm: Members shows `1 waiting`. Confirming E2E Joiner makes them a developer with no pending role on the team record online.
- The two deferred self-import tests now take their expectations from the files committed at HEAD.
- The full gate is green and the validation map has rows for 61-15 to 61-24.

## Task Commits

1. **Task 1: Tracer: the lead turns on Team Mode and invites from the sidebar Team section.** `8381250` (test). The tracer gate re-ran the e2e after the commit: green (`⚡ Tracer verified end-to-end, expanding`).
2. **Task 2: The invitee joins from a behind copy; the lead confirms them.** `ba3b708` (test)
3. **Task 3: Phase gate and validation map.** `e064ed3` (test: self-import tests from deferred-items), `2fb0625` (docs: validation map)

## Gate results (Task 3)

| Check | Command (under the mandated memory wrapper) | Result |
|-------|---------------------------------------------|--------|
| Lint + full suite | `npm run check` (MemoryMax=6G, timeout 1800) | exit 0. 1765 tests: 1755 pass, 0 fail, 10 skipped (missing external tools or live keys) |
| e2e | `npm run compile && xvfb-run -a node dist/test/e2e/run.js` (MemoryMax=6G) | exit 0. All 30 tests pass: project 8, plain 2, team 7, team-lead 5, team-join 5, team-confirm 3. The handoff folder is removed. Re-run in Task 3 for stability (green on the Task 2 run and on this rerun) |
| Release content | `npm run verify:release` | exit 0. 268 entries, 191 runtime JS files, 51 required assets |
| Invariants | `! grep -rlE "from .vscode.\|require\(.vscode.\)" src/team src/domain/team && git diff --quiet a7fcba5 -- <types, validate, materialize, canonical, permissions, invite, eventLog, inviteBundle, inviteCode, gitTransport, identity, keySeal>` | exit 0 |
| Dependencies | `git diff a7fcba5 -- package.json` (only command titles and the Share command) + teamManifest.test.ts inside npm test | no new runtime or dev dependency |
| teamSession "unreachable remote pauses ... recovers" (deferred from 61-16) | in the full suite, then 3 solo runs of teamSession.test.js | passed every time (21/21 each). Not changed, because it did not fail again |

## Files Created/Modified

- `src/test/e2e/run.ts`: the invite projects on a bare online home behind insteadOf, the handoff folder, and the two concurrent invite windows with `--password-store=basic`. The existing project, plain and team launches are unchanged in content.
- `src/test/e2e/suite.ts`: comma-separated scenarios per window, `inviteKit` (probe, facts, click, finished, assertPlain, readLog), `teamLeadTests`, `teamJoinTests`, `teamConfirmTests`.
- `src/test/teamGsdImport.test.ts`: the plan count of Phases 60 to 62 equals the committed plan files. Phase 60 and 61-01..14 must be finished, and every plan's `hasSummary` must equal whether its SUMMARY is committed.
- `src/test/teamImport.test.ts`: the Phase 60/61 plan items equal the committed plan files, and an item is `done` with `summary` exactly when its SUMMARY is committed. 60-01..12 and 61-01..14 must be finished.
- `61-VALIDATION.md`: 29 map rows for 61-15-01 to 61-24-03, plus one gate line (frontmatter untouched).

## Decisions Made

See key-decisions: the same-window lead, Share before Invite, and SUMMARY-derived self-import expectations.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Invite someone is not offered until the setup is shared, so the lead shares first**
- **Found during:** Task 1
- **Issue:** The plan expected "share as primary with invite present" after turn-on, and an invite script with "Share and continue". The 61-17 model (`teamPlan`) deliberately shows Share *instead of* Invite someone while the setup is not online, so the sidebar cannot start an invite at that point.
- **Fix:** The test asserts the product rule: Share is first and Invite someone is absent. It clicks Share (one confirmation, "Share"), checks that `main` online holds team.json, then clicks Invite someone. The invite's own "Share and continue" path is not reachable from the sidebar. It stays covered by `teamInviteShare.test.ts` (tracer: inviting with the team setup not online asks once to share it first).
- **Files modified:** src/test/e2e/suite.ts
- **Committed in:** 8381250

**2. [Rule 3 - Blocking, infrastructure finding] SecretStorage cannot persist between extension-test launches on any host; the lead's confirm runs in the lead's own window**
- **Found during:** Task 2 (first run: `✖ [team-confirm] ... the lead's device key was not found`)
- **Issue:** A separate team-confirm launch with user data L found no device key. The user data folder had no `state.vscdb` at all. VS Code 1.144.1 `mainImpl.js` has `getStorageOptions(){return{useInMemoryStorage:!!this.environmentService.extensionTestsLocationURI}}`, so every storage, SecretStorage included, lives in memory while extension tests run. `--password-store=basic` cannot change that. This is not a keyring problem on this host.
- **Fix:** The plan said to stop rather than change the flow and never export a key. The product flow and production code are unchanged and no key is exported. Only the test launch plan changed: the lead's window stays open and runs team-confirm after team-lead, while the invitee's window runs team-join at the same time (`Promise.allSettled` over two `runTests`). The invite is handed over through `bundle.txt`, written whole then renamed. Cross-window waits are bounded at 180 s. `--password-store=basic` stays, documented as keeping VS Code from looking for an OS keyring, not as persistence.
- **Files modified:** src/test/e2e/run.ts, src/test/e2e/suite.ts
- **Verification:** e2e green on both runs of this design (the Task 2 run and the Task 3 gate rerun)
- **Committed in:** ba3b708

**3. [Rule 1 - Bug, deferred from 61-15] The self-import tests assumed Phase 61 had exactly 14 finished plans**
- **Found during:** Task 3 (assigned in deferred-items.md)
- **Issue:** `teamGsdImport` expected 14 plans in Phase 61, all with SUMMARYs. `teamImport` expected every 60/61 plan to be `done`. This repository's `.planning` now holds the gap-closure plans 61-15..61-24 and 62-15..62-23, which have no SUMMARY until they are executed.
- **Fix:** The expectations are derived from the planning files committed at HEAD. Both tests still prove every committed plan is parsed and imported, and that Phase 60 and 61-01..61-14 are finished. They also now prove the converse: a plan without a SUMMARY is *not* marked finished or done. Nothing is loosened: the old `>= 26` count is now an exact equality with the committed files.
- **Files modified:** src/test/teamGsdImport.test.ts, src/test/teamImport.test.ts
- **Verification:** both pass alone and in the full suite
- **Committed in:** e064ed3

**4. [Rule 2 - stricter check] The plain-words scan also covers the offered choices**
- **Found during:** Task 1
- **Issue:** The plan scanned each record's text and detail. Button and pick labels are also read by a person.
- **Fix:** `assertPlain` also scans `record.choices`. It is green.
- **Committed in:** 8381250

---

**Total deviations:** 4 (2 blocking, 1 deferred bug, 1 stricter check).
**Impact on plan:** Every must-have truth is proven in real windows. The confirm step runs "in the lead's window again", in the lead's same window rather than a relaunch, because VS Code makes a relaunch impossible during extension tests. No production code changed.

## Issues Encountered

- The first full e2e of Task 2 failed only in team-confirm (deviation 2). It was diagnosed from the user data folder and the VS Code bundle, not by changing the cap or the flow.
- The deferred teamSession test did not fail again (full suite plus 3 solo runs).

## Known Stubs

None.

## Owner check (pending owner review, not performed in auto mode)

Repeat 61-UAT tests 1 to 6 in code-server on the scratch project (`ALuhning/team-check-scratch`, clones alice and bob) with the VSIX built from this branch, using only the sidebar Team section:
1. In alice, with NEAR AI not connected, choose Turn on Team Mode and connect NEAR AI from the offer. Team Mode turns on.
2. With alice's origin pointed at a local folder, Turn on Team Mode warns up front in plain words. Restore origin afterwards.
3. Invite someone from the sidebar. After turn-on the section shows Share first: one confirmation shares the setup, then Invite someone shows the invite with Copy invite and how to send it. The "Share with my team" button on the Enable message is another way to share.
4. In bob's existing clone (not pulled), choose Join a team and paste. The copy updates itself and bob joins.
5. Every step was a sidebar button, with no Command Palette.
6. No text says "NEAR organization", and linking is explained in one line with Link now or Not now.

Once these pass, 61-UAT test 7 (real organization: key cap, removal, revoke, and the opt-in live tests) can run.

## User Setup Required

None. No external service configuration required.

## Next Phase Readiness

- Phase 61's fix pass is complete. All plans 61-15 to 61-24 have SUMMARYs. It is ready for the owner's hands-on repeat and `/gsd-verify-work 61`.
- The Phase 62 gap plans (62-15 to 62-23) can reuse `inviteKit` and the two-window pattern for their own real-window checks.

---
*Phase: 61-invitations-joining-removal-near-org-and-key-integration*
*Completed: 2026-11-03*

## Self-Check: PASSED

- All 6 key files exist; task commits 8381250, ba3b708, e064ed3, 2fb0625 and the SUMMARY commit 0b7b9a9 are on this branch.
- Acceptance criteria re-run: "team-lead", "team-confirm" and "password-store=basic" grep matches in run.ts/suite.ts; insteadOf in run.ts; the validation map names the fix-pass plans (29 matches, baseline 0); e2e, check, verify:release and invariant commands exit 0.
