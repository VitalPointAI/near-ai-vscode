---
phase: 32-your-organizations-sync-hub
plan: 12
subsystem: multi-user staff commands (lead clearance, copy notices, preview way forward)
status: complete
tags: [staff, multi-user, commands, clearance, labels, copy, preview, D-19, D-22, D-23, D-68, MUS-05, MUS-06]
requires: [32-02, 32-09, 32-10]
provides:
  - "staffMultiUserCommands.ts: LEAD_CLEARANCE_TITLE, COPY_SHARE_AGAIN_TEXT; Make Multi-User asks and checks the lead's own clearance and passes leadClearance; the copy shows its extra notices; heldProductsInBase and the preview way forward"
affects: [32-11, 32-13, 32-24]
tech-stack:
  added: []
  patterns:
    - "the clearance is asked only when verify with none declared refuses not-cleared-for-label with labels, then verify runs again with it before the confirmation"
    - "a read-only open, fold and close of the shared project answers a yes or no question; any refusal or error answers false"
key-files:
  created:
    - .planning/phases/32-your-organizations-sync-hub/32-12-SUMMARY.md
  modified:
    - src/services/staffMultiUserCommands.ts
    - src/test/staffMultiUserCommands.test.ts
decisions:
  - "The clearance question is triggered by the first verify's not-cleared-for-label refusal with a non-empty labels list (with none declared only org/Public is covered, D-68), so verify decides which projects need it, and an all org/Public project takes today's path unchanged"
  - "The labels line in the confirmation uses the labels the second verify returns (every label the conversion needs, in verify's sorted order), not only the uncovered ones"
  - "pickClearance gains an optional placeholder; the lead's reads 'The clearance you declare for yourself (self-declared, not verified)'. Invite and Change a Member keep 'for them'"
  - "A preview project's already-shared refusal is the refusal sentence then PREVIEW_WAY_FORWARD_TEXT, without the 'To bring someone in' step, since the way forward carries its own next step and inviting is not what the lead should do next"
  - "The copy's extra notices are shown after NOT_COPIED_TEXT, deduplicated, and before COPY_SHARE_AGAIN_TEXT; tell() then adds the three notices every screen shows, so those appear once"
  - "heldProductsInBase is asked before the copy runs, as the plan says, so it describes the project that was copied"
  - "Defaults of 32-CONTEXT.md taken as accepted; the plan has no checkpoint. The tracer gate passed on the automated verify."
metrics:
  duration: "about 35 minutes"
  completed: 2026-11-20
estimate:
  tokens: 50026
  tasks: 2
actuals:
  tokens: 5164
  tasks: 2
  commits: 3
plan_head_before: 7a065afbaae6b715a04c741da67836e1b85feed3
plan_head_after: 767c1902e89e03c699bbf0144d38bc2e0c6f51c5
---

# Phase 32 Plan 12: The lead's own clearance, the copy's notices and the preview way forward Summary

Make This Staff Project Multi-User now asks the lead to declare their own clearance when the project needs a label other than org/Public. It checks that clearance before the confirmation, names the labels in the dialog and passes the clearance to the conversion. The single-machine copy now shows every notice the copy returns. A project shared under the 0.4.35 preview is told how to give its products their own parts.

## What was built

`src/services/staffMultiUserCommands.ts`:
- `LEAD_CLEARANCE_TITLE` = "The clearance you declare for yourself".
- makeMultiUserCommand:
  - Verify runs first with no clearance. When it refuses `not-cleared-for-label` with labels, the command asks `pickClearance(LEAD_CLEARANCE_TITLE, ...)`. Cancelling ends the command with nothing written and nothing more said.
  - Verify then runs again with `{ leadClearance }`. A refusal is warned with shownRefusal: the D-19 sentence per label, naming its products. This happens before any confirmation.
  - The confirmation detail adds: "Each product goes into a part of the project for its label: <labels>. Only people whose declared clearance covers a label receive that part. You declare yourself cleared for <level>."
  - `makeMultiUser` receives `leadClearance` beside `labelMapHash`.
  - An all org/Public project is asked nothing new.
- `heldProductsInBase(context, root)`:
  - Loads ReplicaProject and productCells with `import()`, opens the project with replicaDeps, folds it with state(), answers `baseCellHeldProducts(fold, project.projectId)`, then closes the project.
  - A missing or refused project, or any error, answers false.
- Make Multi-User on a finished conversion: when the helper answers true, the warning is `MIGRATION_REFUSALS['already-shared']` followed by `PREVIEW_WAY_FORWARD_TEXT`. Otherwise it is today's refusal with its invite step.
- singleCopyCommand:
  - The helper is asked before the copy.
  - After the parts it shows today, the result adds each line of `result.notices` that `multiUserNoticeLines()` does not hold, each once.
  - It then adds `COPY_SHARE_AGAIN_TEXT` ("To share it again with each product in its own part, open the copy's folder and run Staff: Make This Staff Project Multi-User.") when the project is a preview project.
- The orphaned "What a Single-Machine Copy does not carry" doc comment now sits on NOT_COPIED_TEXT, where it belongs.
- There is still no static import of src/staff/replica or src/domain/replica in this file. productCells loads only inside the handlers, past the setting check.

`src/test/staffMultiUserCommands.test.ts`:
- 6 new tests:
  - three "declare for yourself" tests: cancel, org/Public refused, org/Internal converts with the roster holding the lead's clearance;
  - "copy notices": real notices computed by a direct copy into another folder, plus an injected extra notice through mock.method;
  - two "preview" tests: a 0.4.35-style fixture, and a Phase 32 project that gets neither sentence.
- New `previewProject` fixture: product.create, doc.client and doc.update in the base stream through appendOwn, plus a complete migration marker in project.json. It asserts `baseCellHeldProducts` is true.
- `staffProject(label, productLabel = 'org/Public')`.
- Three existing tests gained assertions. The setting-on test checks that no quick pick is asked, that the dialog has no labels line, and that the already-shared warning has no way forward. The copy test checks there is no share-again sentence. The texts test covers LABEL_CELL_REFUSALS, PREVIEW_WAY_FORWARD_TEXT, COPY_SHARE_AGAIN_TEXT, LEAD_CLEARANCE_TITLE and the preview refusal as shown, with a next step in each.
- The stale "W-1" comment 32-10 left is gone. The three em-dash characters in the file are now the `EM_DASH` constant, written as an escape.

## Verification

All runs used the memory cap wrapper and the shared focused lock.

- Plan verify (Task 2 set): staffMultiUserCommands, staffMultiUserManifest, staffReplicaMigration, then `npm run lint`: **79 tests, 79 pass, 0 fail, lint exit 0**. staffMultiUserManifest's first test (nothing under src/staff/replica loaded with the setting off) is green.
- staffMultiUserCommands alone: 39 tests, 39 pass.
- Acceptance greps: `leadClearance` in staffMultiUserCommands.ts 6 (HEAD was 0), `baseCellHeldProducts` 2 (HEAD was 0). Test names include "declare for yourself", "preview" and "copy notices". There is no em-dash character in either file.
- No module outside src/staff/replica and src/domain/replica imports a domain/replica module statically, so productCells is not loaded with the setting off.

### Failing first

The tests were written and run on the unchanged code (commit 9b1d3022). tsc reported TS2339 for the missing `COPY_SHARE_AGAIN_TEXT` and `LEAD_CLEARANCE_TITLE` but still emitted the JS. **39 tests, 32 pass, 7 fail.** The 7 failures:
- the texts test;
- the three "declare for yourself" tests: "one quick pick" and "the clearance was asked" got 76 where 77 was expected, and the org/Internal test showed no conversion dialog;
- "copy notices": the conversion was refused not-cleared-for-label;
- both "preview" tests: the already-shared warning had no way forward, and the Phase 32 one could not convert.

The org/Public refusal test passed on the first run. With no clearance the old code refuses with the same sentence, so the test now also asserts that the clearance was asked.

After Task 1 (3af5c073), 36 of 39 passed; the remaining failures were the three Task 2 tests. After Task 2 (767c1902), 39 of 39 passed.

### Mutation proofs (D-66; compiled JS changed, run, restored and compared by sha256)

| Mutation | Tests that failed |
| --- | --- |
| M1 heldProductsInBase always false | 1: preview (0.4.35 fixture) |
| M2 heldProductsInBase always true | 4: copy notices, make a single-machine copy, preview (Phase 32), setting on |
| M3 leadClearance not passed to makeMultiUser | 3: declare for yourself org/Internal, copy notices, preview (Phase 32) |
| M4 second verify without the declared clearance | 3: same three |
| M5 extra copy notices not shown | 1: copy notices (the injected notice) |

## Deviations from Plan

1. **[Plan wording] Trigger for the clearance question.** The plan says to ask "when verified.labels holds a label other than org/Public". With no clearance declared, verify refuses such a project and returns no `verified.labels`. It returns the refusal's `labels` instead, which 32-10 added for this purpose. The command therefore asks when that refusal carries labels. The behaviour is the one the plan describes.
2. **[Rule 2, clarity] Placeholder for the lead's own clearance.** pickClearance's placeholder said "for them", which is wrong when the lead declares their own clearance. An optional placeholder parameter now lets the lead's question say "for yourself", still "(self-declared, not verified)".
3. **[Fixture] staffProject takes a product label.** The default stays org/Public, so every existing caller is unchanged.
4. **Extra test teeth.** The "copy notices" test also injects one extra notice through mock.method. Until 32-11 is merged, a direct copy returns no notice beyond the three, so the real check alone would pass on unchanged code. The real computed check stays too.
5. **Commits:** three: tests first (RED), Task 1, Task 2.
6. **Branch name:** the plan names `feat/phase-32-12-command-steps`. The orchestrator made `feat/phase-32-12-multiuser-clearance-preview`, and that branch was used.

Files touched: only the two in the plan's files_modified, plus this summary.

## Known limits

- The org/Public refusal names every uncovered label. A label the scales do not know is never covered, so such a project is asked the clearance and then refused whatever the lead declares. The refusal says which label, so the lead can see why.
- Until 32-11 is merged, the lead's own copy never has an extra notice. The command is ready for the "not cleared for" notice whenever the copy returns it.
- heldProductsInBase opens the project a second time while the staff host may also hold it open. Other handlers already do this through withShared.

## Known Stubs

None.

## Threat Flags

None beyond the register:
- **T-32-216:** the clearance is asked and checked before the confirmation. The conversion checks it again (M3 and M4).
- **T-32-217:** the preview way forward is shown on Make Multi-User and on the copy (M1 and M2).
- **T-32-218:** every extra notice is shown (M5).
- **T-32-SC:** no package was installed.

## Self-Check: PASSED

- FOUND: src/services/staffMultiUserCommands.ts, src/test/staffMultiUserCommands.test.ts
- FOUND: 9b1d3022, 3af5c073, 767c1902 (ancestors of HEAD)
