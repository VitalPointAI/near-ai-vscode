---
phase: 32-your-organizations-sync-hub
plan: 02
subsystem: multi-user staff commands
status: complete
tags: [staff, multi-user, commands, D-03, D-04, D-05, D-06, D-09, D-12, MUS-04, MUS-05, MUS-06]
requires:
  - 32-01 (syncFolder, setFolderSyncProbe, StartedAgain.setAside null and carriedFrom, open refusing a lost history folder rolled back)
  - 32-05 (StaffHost.invalidateShared)
provides:
  - "JOIN_NO_FILE_TEXT and Join refusing an ok result with no file"
  - "quick picks that carry their value (member, choice, branch, reason); memberLabel shows the member id for a repeated declared name"
  - "saveSecretFile syncing the target's folder after the rename"
  - "Start Again reaching a lost but set-aside history folder, with sentences for setAside null and carriedFrom"
  - "invalidateShared() after Start Again and after a single-machine copy"
affects:
  - 32-12 (changes staffMultiUserCommands.ts again in wave 5)
tech-stack:
  added: []
  patterns:
    - "quick pick items carry their value and the returned item is used as it is; nothing matched back by label"
    - "a beforeEach that empties the vscode stub's answer queues, so a failed test cannot feed its unused answers to the next test"
    - "says(text, phrases, what): D-12 key-phrase assertions"
key-files:
  created:
    - .planning/phases/32-your-organizations-sync-hub/32-02-SUMMARY.md
  modified:
    - src/services/staffMultiUserCommands.ts
    - src/test/staffMultiUserCommands.test.ts
decisions:
  - "A declared name two members share is shown as 'name (member id)' in every list of the file (Remove member and device items, Add My Other Machine, pickMember) and in the Remove confirmation"
  - "Start Again no longer checks project.json first; ReplicaProject.open's answer decides (undefined means NOT_SHARED_TEXT)"
  - "Start Again calls invalidateShared() where it called close(); Make Multi-User and Join keep close(), which goes through invalidateShared since 32-05"
  - "The test simulates a lost history folder by moving it out of the project (rename), not by deleting it"
metrics:
  duration: about 15 minutes
  completed: 2026-11-20
estimate:
  tokens: 65034
  tasks: 3
actuals:
  tokens: 12630
  tasks: 3
  commits: 3
plan_head_before: f9694b721bc4827ce85b5664d9ea395443289eb6
plan_head_after: e2aec1de23eef918cc9a0d4e5bda349732b27ea8
---

# Phase 32 Plan 02: Multi-user commands pick by id, refuse an empty join request, sync saved secrets and tell the truth about Start Again Summary

Every quick pick in the multi-user commands now carries its value and the returned item is used directly. Remove and Add My Other Machine show the member id when two members share a declared name. Join refuses an ok result that has no file. saveSecretFile syncs the folder after the rename. Start Again reaches a history folder that was lost but set aside, and says what it set aside and what it carried from. Start Again and a single-machine copy now invalidate the staff host's shared project.

## What changed

`src/services/staffMultiUserCommands.ts`:
- `memberLabel(members, member)`: the declared name, with ` (member id)` added when another member in the list has the same name.
- `pickMember` returns `picked.member`. In Remove, the items are `{ label, description, choice }` and the command uses `picked.choice`; the member and device labels use memberLabel, and so does the confirmation question. Add My Other Machine uses `picked.member` with memberLabel labels. Choose Roster Branch uses `picked.branch`. Hand Over uses `picked.reason`. No `items.find` or `choices.find` on a label or description is left. pickClearance, pickRoles and the update-member field still read the label, because there the label is the value.
- `JOIN_NO_FILE_TEXT` ('The join request was not made. Nothing was saved. Run Join Staff Project again.'). joinCommand warns with it and returns before saving when `result.file === undefined`.
- `saveSecretFile` calls `await syncFolder(path.dirname(target))` after the rename, inside the same try block. A sync error is reported like any other save error.
- `startHistoryAgainCommand`:
  - The project.json pre-check is gone, so `ReplicaProject.open` decides.
  - The dialog says the folder "is moved aside to a folder beside it, when it is there".
  - The result's first sentence depends on `setAside`. When it is null: "Nothing was set aside, because this computer's shared history folder was not there. Nothing was deleted." Otherwise the sentence is unchanged.
  - When `carriedFrom` is present, the result adds "The new one was made from <carriedFrom>/.".
  - It calls `await staffHostFor(root)?.invalidateShared()` where it used to call `close()`.
- `singleCopyCommand` calls `await staffHostFor(root)?.invalidateShared()` after a successful copy.

`src/test/staffMultiUserCommands.test.ts`: 5 new tests (28 to 33), 1 existing test extended, a `twins` helper, a `says` key-phrase helper, and a `beforeEach` that empties the stub's answer queues.

## Tests (failing first)

| Test | Run on | Failure on the unchanged code |
|------|--------|-------------------------------|
| D-04: two members with the same declared name are listed by Remove with their member ids, and picking the second removes the second | unchanged source | `each is listed with their member id: mbr-lead \| mbr-lead, device in slot 1 \| B. Example \| B. Example, device in slot 2 \| B. Example \| B. Example, device in slot 3` |
| D-04: Add My Other Machine with two members of the same declared name and seat offers two distinct items, and the invitation is for the member picked | unchanged source | `every item is distinct: ... Another computer of B. Example / j2-analyst \| Another computer of B. Example / j2-analyst` (actual 2, expected 3) |
| D-05: Join refuses a flow result that is ok but carries no file | source with only the JOIN_NO_FILE_TEXT constant added, so the test compiles | level `info` instead of `warn`: the command showed "Read these six words to the staff lead: " (empty words) and had saved an empty file |
| D-06: saveSecretFile syncs the target's folder after the rename | unchanged source | `the target's folder is synced once: []` (actual 0, expected 1) |
| D-03: Start Again reaches a project whose shared history folder is gone but was set aside before | unchanged source (after Task 2) | no dialog: "This folder holds no shared staff project, so nothing was changed..." (dialog count 58, expected 59) |
| make a single-machine copy (extended with the D-09 host spy) | unchanged source (after Task 2) | `the copy invalidates the staff host's shared project once` (actual 0, expected 1) |

On the Start Again side of D-09: on the old code, `close()` already went through `invalidateShared()`, so the spy alone has no teeth there. The D-03 test still fails first, at the dialog. Mutation check: removing the `invalidateShared()` call after Start Again makes the spy count 0, and the test fails.

On the first failing run of Task 1, 11 later tests also failed. The two red tests had left their answers queued in the stub, and the next tests' dialogs took them. The new `beforeEach` empties the queues before every test.

Final runs (under the memory cap):
- After each task, staffMultiUserCommands alone: Task 1 30/30, Task 2 32/32, Task 3 33/33.
- The plan's Task 3 verify (staffMultiUserCommands, staffMultiUserManifest, staffReplicaStartAgain): `tests 62, pass 62, fail 0`, and `npm run lint` exits 0.
- Neighbours (staffReplicaParity, staffReplicaHostMode): `tests 22, pass 22, fail 0`.

Acceptance greps:

| Grep | Count | Target |
|------|-------|--------|
| `=== picked.label` | 0 | 0 (was 5) |
| `result.file?.text ?? ''` | 0 | 0 |
| syncFolder inside saveSecretFile | 1 | 1 |
| `invalidateShared` | 2 | at least 2 |
| `assert.equal(lastModal().message, '<long literal>'` | 0 | 0 (was 2) |

## D-12 conversions

These whole-sentence assertions now check the level and two or three load-bearing phrases through `says`:
- Make Multi-User result, invitation result, admit result
- remove question and result, cancel result, device question and result
- make-again question and result, finish question and result, add-machine result
- the two change results in the split test, the choose question and result
- deputy, handover and change questions and results, the save-again result
- the existing Start Again result

Where a result had no level check, an `info` level assertion was added. Every comparison against a refusal or text constant is unchanged and still exact: WORDS_DIFFER_TEXT, WORDS_NOT_CONFIRMED_TEXT, SEAT_TEXT, INVITE_INSIDE_PROJECT_TEXT, AGENT_SEATS_TEXT, NOT_SHARED_TEXT, STORE_REFUSALS['not-needed'], the MIGRATION/COPY/MEMBERSHIP refusal prefixes, MAKE_MULTI_USER_QUESTION and START_AGAIN_QUESTION.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] A failed test fed its unused stub answers to the next tests**
- **Found during:** Task 1, first failing run
- **Fix:** a `beforeEach` in the test file empties quickPickAnswers, openDialogAnswers, saveDialogAnswers, inputAnswers and messageAnswers.
- **Commit:** 9c05e0f8

**2. [Rule 2 - Correctness] The Remove confirmation names the member id of a repeated name**
- **Issue:** with only the list fixed, the question "Remove B. Example from the project?" still did not say which of the two people would be removed.
- **Fix:** the question uses memberLabel. A unique name reads as before, so the existing test is unchanged.
- **Commit:** 9c05e0f8

**3. The D-03 test counts dialogs**
- A warning is not recorded as a modal, so `lastModal()` alone would have read the earlier Start Again dialog. The test asserts that exactly one new dialog was shown.

**4. Lost folder simulated by moving it**
- A safety check refused a command whose script text contained a delete call. The test now moves `.planning/staff/replica` out of the project into the install's temporary base folder. For the store, that is the same as losing the folder, and nothing is deleted.

### Files outside the plan's list

None.

## Decisions

- Checkpoints: none in this plan. The tracer gate (Task 1) passed on the automated verify.
- The dialog wording "is moved aside to a folder beside it, when it is there" follows the plan.
- nameDeputy and handOver questions still use the plain declared name. Their lists show the id for a repeated name, and the flow acts on the member id that was picked.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register:
- T-32-05: items carry the member id, and the item picked is the one used.
- T-32-06: JOIN_NO_FILE_TEXT is shown and nothing is written.
- T-32-07: syncFolder runs after the rename.
- T-32-SC: no package was installed.

## Self-Check: PASSED

- FOUND: src/services/staffMultiUserCommands.ts, src/test/staffMultiUserCommands.test.ts
- FOUND commits: 9c05e0f8, a4b4762a, e2aec1de on feat/phase-32-02-remove-by-id-join-sync
