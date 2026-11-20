---
phase: 31-staff-roster-cell-keys-and-migration
plan: 23
subsystem: staff-replica
tags: [replica, commands, preview-gate, membership, migration, single-machine-copy, security-docs, d-36, tdd]
status: complete

requires:
  - phase: 31-19
    provides: makeMultiUser, verifyLegacyLedgers, LEGACY_LEDGERS, MIGRATION_REFUSALS, migrationComplete
  - phase: 31-20
    provides: inviteToProject, addMyOtherMachine, voidInvite, joinFromInvite, openWelcome, reviewJoinRequest, admitJoinRequest, removeFromProject, updateMember, chooseRosterBranch, nameDeputy, handOverLead, cellOrderHook
  - phase: 31-21
    provides: StaffHostOptions.replica, StaffHost.isSharedProject, StaffHost.close, SHARED_PROJECT_REFUSAL
  - phase: 31-22
    provides: makeSingleMachineCopy, COPY_REFUSALS, CONTESTED_AT_COPY_TEXT, carriedApprovalName
provides:
  - "src/services/staffMultiUserCommands.ts: registerStaffMultiUserCommands, MULTI_USER_PREVIEW_SETTING, MULTI_USER_PREVIEW_OFF_TEXT, multiUserPreviewOn, shownRefusal, REFUSAL_NEXT_STEPS, SIX_WORDS_MATCH, SIX_WORDS_DIFFER, the texts each handler shows, one handler per command"
  - "src/domain/staff/commands.ts: STAFF_MULTI_USER_COMMANDS (twelve ids: eleven from this plan, plus startHistoryAgain added by review fix MJ-08); PERSON_DECISION_COMMANDS unchanged"
  - "package.json: nearAi.staff.multiUserPreview (boolean, default false, application scope), twelve Staff: commands under NEAR AI (eleven from this plan, plus Start This Computer's Shared History Again from review fix MJ-08), twelve commandPalette entries behind config.nearAi.staff.multiUserPreview"
  - "src/services/staffCommands.ts: registers the multi-user commands, passes { globalStorageDir, identityDir } as the staff hosts' replica options, and refuses decide, Decide a PIR and Set Aside in a shared project before any dialog"
  - "src/staff/watchHost.ts: every standing watch change refused with SHARED_PROJECT_REFUSAL in a shared project before the register is written"
  - "src/test/helpers/vscodeStub.ts: showSaveDialog with saveDialogAnswers and saveDialogRequests"
  - "src/test/staffMultiUserCommands.test.ts (19 tests), src/test/staffMultiUserManifest.test.ts (6 tests), one test in src/test/staffWatches.test.ts"
  - "SECURITY.md ### People and clearances are declared by the staff lead; CHANGELOG Unreleased: Staff collaboration (preview)"
affects: [32, 33]

tech-stack:
  added: []
  patterns:
    - "Register always, check the setting inside every handler (no reload needed), hide from the palette with a when clause"
    - "Replica modules only through import() inside handlers and import() types; no static import of src/staff/replica, checked by require.cache"
    - "Ask where to save a file before the flow runs, so cancelling writes nothing"
    - "Every refusal shown passes through shownRefusal: the flow's sentence plus a next step when it has none"
    - "Read-only checks before any dialog (ledgers verified, invitation read, copy destination checked), the flow checks again before it writes"

key-files:
  created:
    - src/services/staffMultiUserCommands.ts
    - src/test/staffMultiUserCommands.test.ts
    - src/test/staffMultiUserManifest.test.ts
    - .planning/phases/31-staff-roster-cell-keys-and-migration/deferred-items.md
  modified:
    - package.json
    - src/domain/staff/commands.ts
    - src/domain/staff/multiUser.ts
    - src/services/staffCommands.ts
    - src/staff/watchHost.ts
    - src/test/helpers/vscodeStub.ts
    - src/test/staffReplicaProject.test.ts
    - src/test/staffWatches.test.ts
    - SECURITY.md
    - CHANGELOG.md

key-decisions:
  - "MULTI_USER_PREVIEW_SETTING moved from src/domain/staff/multiUser.ts into src/services/staffMultiUserCommands.ts (the staff doctrine test refuses the word preview under src/domain/staff); the multiUser.ts comments no longer say preview; staffReplicaProject.test.ts no longer imports it, and staffMultiUserManifest checks its value"
  - "The label map hash Make Multi-User passes is the sha256 of the canonical JSON of .planning/.near-ai/labels.json (the same envelope hash the gate's label marker records); the raw bytes' sha256 when the file is not JSON; the migration's empty-map default when there is no label map"
  - "Make Multi-User verifies the four ledgers before its modal, so a broken ledger is refused with today's wording before any question, and the modal lists each ledger with its entry count"
  - "Every file a flow returns is saved where the person picks in a save dialog asked before the flow runs (cancelling writes nothing), defaulting to the home folder, owner-only (0600). An invitation is refused inside the project folder: it holds a one-time secret git could commit"
  - "The six words are shown in a modal on both sides; the Admit modal's question names the person declared in the invitation and ends with the six words, its detail adds the request's own words, the declared seat and the notices"
  - "Dismissing the Admit modal, 'They do not match', or any other answer admits nobody and writes nothing; the welcome file's place is asked only after 'The six words match'"
  - "Agent seats are not asked at admission; Change a Staff Project Member sets them later"
  - "Clearance is picked from the shipped scale levels with no compartments or releasability (a declared clearance; a narrower one only clears fewer cells, so it fails closed); the flows use the shipped scales (SharedProjectHost.scales absent), as 31-20 defaults"
  - "Roles offered: member, observer, section_lead:<section> and answers_for:<section> for each staff section; the lead roles come only by handover or naming the deputy"
  - "Add My Other Machine lists this computer's own member first ('My other computer') and the other members after; the flow refuses on a computer that did not found the project (31-20)"
  - "Choose Roster Branch lists the first pending split's changes as 'Change n of m' with the entry hash and the split sentence; with no split it shows the flow's own refusal"
  - "Make a Single-Machine Copy checks the destination (inside the shared project, or holding .planning/staff) before it asks who the person is; the flow checks again before it writes. The result names what is not copied (31-22) instead of copying the calculator records"
  - "Change's result is the flow's sentence: it carries the rekey sentence when a rekey was planned (a lowered clearance), not for a raise or a name change, where the sentence would be false; the confirmation of a clearance change always carries it"
  - "After Make Multi-User and after joining by welcome file, the staff host's cached shared project is closed so its next read opens the shared record"

requirements-completed: [MUS-04, MUS-05, MUS-06]

actuals:
  tokens: 31900
  tasks: 4
  commits: 5
plan_head_before: 969e7cf5063a406f14e49e3b0f172a3ea69f4a11
plan_head_after: 22361446dbe678d6392e48e1422fe5303464d3d2

duration: about 75 min
completed: 2026-11-20
---

# Phase 31 Plan 23: Multi-user staff commands behind the preview setting Summary

**Twelve Staff: commands now run every Phase 31 flow (eleven from this plan; the twelfth, Start This Computer's Shared History Again, came with review fix MJ-08), behind `nearAi.staff.multiUserPreview` (off by default). They are hidden and inert until a person turns the setting on, and they load no replica module until one is run. A person is admitted only when the lead picks "The six words match". Every confirmation and result shows the three declared-not-verified notices, and every refusal says what to do next.**

## Accomplishments

- **The gate (D-36).** `nearAi.staff.multiUserPreview` is a boolean, default false, application scope, with a plain description. All twelve commands are registered always and hidden from the Command Palette with `when: config.nearAi.staff.multiUserPreview`. Each handler checks the setting at run time. While it is off, a handler shows `MULTI_USER_PREVIEW_OFF_TEXT` once and does nothing else. The test shows no replica module is loaded, and no file, folder or secret is made, global storage included.
- **Make This Staff Project Multi-User.** The command verifies the four ledgers with today's checks before it asks anything. A broken ledger is refused with today's wording and the Set Aside way out. The modal lists each ledger and its count, says where the history goes and that the originals are kept in `.planning/staff/legacy/`, and shows the notices. The command passes the project's real label map hash. The result names the next step.
- **Membership.**
  - Invite asks name, seat (slug), roles and declared clearance, then where to save the `.near-staff-invite` file. The file is saved outside the project and owner-only. The result says the invitation works once and gives its 7-day expiry.
  - Join opens either an invitation (it returns a `.near-staff-join` file and shows the six words in a modal) or a welcome file (the project opens on this computer).
  - Admit calls `reviewJoinRequest`, then shows the declared name and the six words with exactly "The six words match" and "They do not match". It calls `admitJoinRequest({ codeMatched: true })` only after the first answer.
  - Remove offers members, single devices and open invitations. Cancelling an invitation writes `invite.void`. The member and device confirmations and results carry "They keep what they already received. They will not receive anything new."
  - Add My Other Machine, Choose Roster Branch, Name Deputy Lead, Hand Over Staff Lead (asks planned or lead lost) and Change a Staff Project Member each run their flow behind a modal.
- **Make a Single-Machine Copy.** The command asks for a folder and refuses one inside the shared project, or one holding `.planning/staff`, with the flow's sentence before it asks anything else. Then it asks who the person is and shows the carried wording in the confirmation. The result lists what was carried, left open (contested), differs or was left, and says plainly what is not copied (31-22 carry-over).
- **Carry-overs closed.**
  - 31-21: replica storage passed to `configureStaffHosts`. In a shared project, Set Aside refuses before its dialog, and so do the four decision commands and Decide a PIR (the same class). The watch host refuses every change before writing the standing watches file.
  - 31-20: review, then admit with `codeMatched: true`.
  - 31-19: the real label map hash is passed.
  - 31-22: the copy message names what is not copied.
- **The blocking fix from the wave-9 merge.** `MULTI_USER_PREVIEW_SETTING` moved out of `src/domain/staff/multiUser.ts`, and no file under `src/domain/staff` says preview or provisional. `staffDoctrine.test.js` passes, and the test itself is unchanged.
- **SECURITY.md:** `### People and clearances are declared by the staff lead`, plus one fact fixed in the review (below). **CHANGELOG:** user-facing bullets under `## Unreleased`, "Staff collaboration (preview)". README was not changed: it describes staff commands in prose, not in a list.

## Task Commits

1. **Task 1 (tracer): the setting and Make Multi-User:** `21e98538` (feat). The tracer gate re-ran the verify end to end (staffMultiUserCommands 3, teamManifest 8: 11 of 11) before expansion.
2. **Task 2: the other ten commands:** `67a33a53` (test)
3. **Carry-over (31-21): watch host refusal before the register is written:** `07251901` (fix)
4. **Task 3: manifest checks, plain words, lazy loading, SECURITY.md, CHANGELOG:** `d77faf98` (test)
5. **Task 4 review: SECURITY.md fact fix, deferred item:** `22361446` (docs)

The command module was written in full in Task 1, together with its tracer tests. Tasks 2 and 3 added their tests and small changes (owner-only saving in Task 3). This is the same pattern 31-19 and 31-20 used.

## Test Results

Every run went through the shared flock lock and the memory cap (`MemoryMax=4G`, `--max-old-space-size=1536`, `timeout`). Each compile exited 0.

| Run | Tests | Pass | Fail |
|-----|-------|------|------|
| Task 1 verify: staffMultiUserCommands (3), teamManifest | 11 | 11 | 0 |
| Task 1 extra: staffMultiUserCommands, teamManifest, staffReplicaProject, staffDoctrine | 52 | 52 | 0 |
| Task 2 verify: staffMultiUserCommands (18 at that commit) | 18 | 18 | 0 |
| Carry-over: staffWatches | 27 | 27 | 0 |
| Task 3 verify: staffMultiUserManifest, staffMultiUserCommands, staffReplicaParity, teamManifest, changelogSections, gateDocs | 74 | 74 | 0 |
| `npm run lint` | | exit 0 | |
| Focused run (48 files, `--test-concurrency=4`, list below) | 764 | 763 | 1 |
| staffReplicaMembership rerun alone (the one failure) | 26 | 26 | 0 |
| After the SECURITY.md fix: gateDocs, security, staffDoctrine, changelogSections | 58 | 58 | 0 |

The focused run covered:
- every `dist/test/staffReplica*.test.js` and `staffMultiUser*.test.js`;
- staffDoctrine, staffWatches, staffBranchLedger, staffRoom, staffIntegration, staffSetup, staffFeedImport, staffScenarioLoad, staffToolSurface and staffReviewRound5;
- teamManifest, teamCommands, teamSoloParity, teamKeyRotation, gateDocs, security and changelogSections;
- every test that reads `contributes` from package.json: agentDefaults, approvalPolicyPicker, codePushLater, config, gateChatLabel, gateCommands, gateLabelCommands, gateLabelStore, historyRetention, modelComparisonPage, participantRecord, profileIndex, reportingTokenEntry, setupSteps, stateHome, stateRemote, syncControl, syncFlows and usageExport.

The single failure is a pre-existing flaky test (see Deferred Issues). It passed 26 of 26 when the file was run again alone. As the orchestrator asked, the full `npm test`, e2e and `npm run verify:release` were not run; the orchestrator runs them next.

**Mutation checks** were made in compiled `dist/` only. Each file was restored and checked with `cmp`.

| Mutation | Tests that failed |
|----------|-------------------|
| The setting check always passes | 12, including the three setting-off tests (manifest activation, Make Multi-User off, every command off) |
| Any Admit answer admits | the "They do not match" test |
| A static `require` of `staff/replica/membership` in the command module | the activation test (require.cache) |
| The watch host's shared check removed | the new staffWatches test |

**Acceptance greps.**

| Check | Result | Required |
|-------|--------|----------|
| `nearAi.staff.multiUserPreview` in package.json | 13 (the setting itself and one `when` clause for each of the twelve commands) | at least 13 |
| `^import .*staff/replica/` in staffMultiUserCommands.ts | 0 | 0 |
| `The six words match` in staffMultiUserCommands.ts | 3 | at least 1 |
| `### People and clearances are declared by the staff lead` in SECURITY.md | 1 | 1 |
| Em-dashes in SECURITY.md and package.json | 0 | 0 |

staffMultiUserCommands has 19 tests (at least 3, then 14, required). staffMultiUserManifest has 6 (at least 5).

## Task 4 review (instead of the full suite)

- **SECURITY.md against what was built.** Checked:
  - paths: `.planning/staff/replica/` with its own `.gitignore`, and the pin under `staff-replica/<project>/genesis.json`;
  - secret names: `nearAi.identity.encryptionKey`, `nearAi.staff.epochKeys.`, `nearAi.staff.replicaMarks.`, and the join secret;
  - limits: 256 KiB, 2 MiB, 100,000 parts; worker 128/32/4 MB and 5 s;
  - 7-day invitations, the setting name, and the sentences.

  One fact no longer matched. The section said only that roster changes come from the lead's or the deputy's devices. Since 31-20, invitations are made and admitted only on the computer that founded the project. That is now said (`22361446`).
- **Diff scope against c1dba334.**
  - `git diff --name-only c1dba334 -- src`: 91 files. Every one is named in a phase plan except `src/staff/watchHost.ts` and `src/test/staffWatches.test.ts`, which are this plan's documented carry-over fix.
  - Under `src/domain/staff/`, only `commands.ts` and `multiUser.ts` changed.
  - `git diff c1dba334 -- package.json`: 114 added lines and 0 removed (105 from this plan, 9 from review fix MJ-08). They are only the setting, the twelve commands and their twelve palette entries.

## TDD Gate Compliance

The plan has `tdd="true"` tasks but is not `type: tdd`. The module and the Task 1 tests were written in the same session. Tasks 2 and 3 are test commits over that module, so there are no separate RED commits. The RED evidence is the mutation table: each guard, when removed, fails the named tests.

## Decisions (defaults taken, owner asleep)

There was no checkpoint. Task 1's reversibility rating, "costly", applies to the setting name and the command ids. They were taken exactly as the plan names them. The other choices are in `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Blocking, from the wave-9 merge] The staff doctrine test failed on "preview" in `src/domain/staff/multiUser.ts`**
- **Fix:** the setting constant moved to the services module, and the comments were reworded. The test file was not changed. `staffReplicaProject.test.ts` no longer imports the constant (its title now says the setting is checked in staffMultiUserManifest).
- **Commit:** `21e98538`

**2. [Rule 2] Decide, Decide a PIR and Set Aside refuse a shared project before any dialog**
- **Why:** the carry-over named Set Aside, and the other commands had the same class of problem: they asked the person's name and showed a modal, only for the host to refuse afterwards.
- **Fix:** `writableHostOrSay` shows `SHARED_PROJECT_REFUSAL` at once.
- **Test:** four commands, no dialog, no question, nothing written.
- **Commit:** `21e98538`

**3. [Rule 1, carry-over 31-21] The watch host wrote its register before the staff host refused the step's events**
- **Fix:** `change()` refuses in a shared project before the lock and the write.
- **Test:** pause, retire, create and the runtime evaluate leave the file and the events unchanged.
- **Commit:** `07251901`

**4. [Rule 3] The vscode stub had no `showSaveDialog`**
- **Fix:** added it, with recorded answers and requests.
- **Commit:** `21e98538`

**5. [Rule 2] Invitations are saved outside the project and owner-only**
- **Why:** an invitation holds the one-time join secret, and a file in the project folder could be committed by git.
- **Fix:** the command refuses a save path inside the project, and saves every file it writes with mode 0600 (also when an existing file is overwritten). SECURITY.md says so.
- **Commit:** `d77faf98`

**6. [Rule 2] `shownRefusal` adds a next step to any refusal sentence that lacks one (D-37)**
- **Why:** some flow sentences say only what happened, for example `already-shared`, `no-split` and `nothing-to-change`, and many fold sentences do the same.
- **Fix:** `REFUSAL_NEXT_STEPS` holds the specific steps, with a general step otherwise.
- **Test:** every refusal map the flows can return passes through `shownRefusal`, and each result must hold a next step.

### Notes

- **The store mark on open.** Opening a shared project signs its store mark again with a new time (31-13 behaviour). The commands tests compare marks by what they record, not by when they were signed. "Nothing written" means no file and no change of recorded state.
- **The stub's message answers.** The stub's `show*Message` takes the next queued answer for every message, the off message included. The tests account for that.

## Deferred Issues

- **Flaky grant signing (pre-existing since 31-15).** Recorded in `deferred-items.md`.
  - `buildGrant` signs random base64url wraps, and `assertNoSecrets` can, about 5 times in 100,000 per wrap, read a wrap as a key, for example `-rt_xxxxxxxx` or `_oc_xxxxxxxx`.
  - It was seen once in staffReplicaMembership during the focused run, and passed when that file was run again.
  - In use, an admission or a rekey would fail once with "NEAR AI could not finish that" and work on a retry.
  - The full suite the orchestrator runs could hit it.
  - The fix belongs in `cellKeys.ts` or `signedPayload.ts`: exempt known random binary fields, or make a fresh wrap when signing refuses. It was not fixed here, because it changes the shared signer outside this plan.
- **Watch commands in a shared project** still ask their questions before the watch host refuses. Nothing is written now, but `staffWatchCommands.ts` could check `isSharedProject()` first, as `staffCommands.ts` now does. That file is not in this plan.
- **Choose Roster Branch** names each change by its entry hash, not by what it changed. The roster state keeps no description of an unapplied branch. Phase 33's Staff Room can show more.
- **Manual UAT (31-VALIDATION).**
  - Two real installs invite and join by file, read the six words aloud and admit only when they are equal.
  - Read every command message with the setting on.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register.
- **T-31-77:** the Admit modal's two buttons, and only the first admits. Tested with "They do not match", dismissal and an unrelated answer.
- **T-31-78:** VS Code commands only. None is in `PERSON_DECISION_COMMANDS` or `STAFF_COMMANDS`, and no file under `src/agent` names one (tested).
- **T-31-79:** the notices on every confirmation and result (tested), and the SECURITY.md subsection.
- **T-31-80:** the when clauses, the run-time check, lazy loading, and the require.cache and tree checks.
- **T-31-SC:** no package was installed.

The save dialog writes files the person places. Invitations are kept out of the project folder, and every saved file is owner-only. No new network endpoint or secret was added.

## Self-Check: PASSED

- FOUND: src/services/staffMultiUserCommands.ts, src/test/staffMultiUserCommands.test.ts, src/test/staffMultiUserManifest.test.ts, .planning/phases/31-staff-roster-cell-keys-and-migration/deferred-items.md
- FOUND commits: 21e98538, 67a33a53, 07251901, d77faf98, 22361446 (ancestors of HEAD)
